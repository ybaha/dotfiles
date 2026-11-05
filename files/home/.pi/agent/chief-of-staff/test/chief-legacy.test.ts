import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, loadConfig, looksLikeSecret, ovisLink, setConfig, type Config } from "../store.ts";
import { TelegramError, handleMessage, questionMessage, runWorker, sendOutbox, sendQueued, statusLine, type Api } from "../telegram.ts";
import { fireMessage, setHerdr, setNowMs, setWatchIdleMs, startWorker, tickWatch, waitingAgentsText } from "../herdr.ts";
import { setModelsDeps } from "../models.ts";
import chief from "../index.ts";

const ME = "1912767327";
const config: Config = { ovisBaseUrl: "https://ovis.example.ts.net:8443/", machineId: "mac", telegramUserId: ME };
let store: Store;

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "chief-legacy-"));
	process.env.PI_CHIEF_CONFIG_DIR = join(root, "config");
	process.env.PI_CHIEF_DATA_DIR = join(root, "data");
	store = new Store();
	setHerdr(null);
	setWatchIdleMs(60_000);
	setNowMs(() => Date.now());
	setModelsDeps(null);
});

const msg = (text: string, replyTo?: number, from = Number(ME)) => ({
	message_id: 900, chat: { id: from, type: "private" }, from: { id: from }, text,
	...(replyTo !== undefined && { reply_to_message: { message_id: replyTo } }),
});

function fakeApi(updates: object[] = []) {
	const calls: { method: string; body: any }[] = [];
	let nextId = 100;
	const api: Api = async (method, body) => {
		calls.push({ method, body });
		if (method === "sendMessage") return { message_id: nextId++ };
		if (method === "getUpdates") return updates.splice(0);
		return {};
	};
	return { api, calls };
}


test("inbox: queue, take once, ordering", () => {
	store.queueInbox("a");
	store.queueInbox("b");
	assert.equal(store.countInboxQueued(), 2);
	assert.deepEqual(store.takeInbox("chief").map(i => [i.id, i.text]), [[1, "a"], [2, "b"]]);
	assert.equal(store.takeInbox("chief").length, 0);
});

test("memory: remember, search, replace, forget, expiry", () => {
	const a = store.remember("Baha prefers reviewed pull requests over direct pushes");
	store.remember("The home server runs Ovis", Date.now() - 1);
	assert.deepEqual(store.recall("what about pull requests?").map(m => m.id), [a]);
	assert.equal(store.recall("Ovis").length, 0, "expired memories are hidden");
	assert.equal(store.recall("or and the").length, 1, "stopword-only query lists recent memories");
	assert.ok(store.replace(a, "Baha prefers small pull requests"));
	assert.equal(store.recall("small")[0].id, a);
	assert.equal(store.recall("reviewed").length, 0, "replaced text is reindexed");
	assert.ok(store.forget(a));
	assert.equal(store.recall("small").length, 0);
});

test("config and private files", () => {
	setConfig("telegramUserId", ME);
	assert.equal(loadConfig().telegramUserId, ME);
	assert.throws(() => setConfig("ovisBaseUrl", "http://insecure"), /https/);
	assert.throws(() => setConfig("nope", "x"), /Unknown key/);
	assert.equal(statSync(join(process.env.PI_CHIEF_CONFIG_DIR!, "config.json")).mode & 0o777, 0o600);
	assert.equal(statSync(process.env.PI_CHIEF_DATA_DIR!).mode & 0o777, 0o700);
});

test("secrets and links", () => {
	assert.ok(looksLikeSecret("token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
	assert.ok(!looksLikeSecret("Baha likes 12:30 lunch"));
	assert.equal(ovisLink(config, "w8Y", "w8Y:p1"), "https://ovis.example.ts.net:8443/?machine=mac&ws=w8Y&pane=w8Y%3Ap1&view=chat");
	assert.equal(ovisLink(config, null, null), undefined);
});

test("questions dedupe and cap per session", () => {
	const ask = (question: string, sessionId = "s1") => store.ask({ sessionId, question, urgent: true });
	assert.deepEqual(ask("Deploy now?"), { id: 1, created: true });
	assert.deepEqual(ask("Deploy now?"), { id: 1, created: false });
	ask("Q2");
	ask("Q3");
	assert.throws(() => ask("Q4"), /already open/);
	assert.ok(ask("Q4", "other-session").created);
	assert.ok(store.closeQuestion(1, "s1"));
	assert.ok(ask("Q4").created);
});


test("worker sends a question with an Ovis button, then a threaded reply reaches the session once", async () => {
	const { id } = store.ask({ sessionId: "s1", workspace: "w8Y", pane: "w8Y:p1", question: "Ship it?", urgent: true });
	const { api, calls } = fakeApi([{ update_id: 7, message: msg("yes, ship", 100) }]);
	await runWorker({ config, store, api, once: true });
	const sent = calls.find(c => c.method === "sendMessage")!.body;
	assert.equal(sent.chat_id, ME);
	assert.match(sent.text, /Chief question #1\n\nShip it\?/);
	assert.equal(sent.reply_markup.inline_keyboard[0][0].url, "https://ovis.example.ts.net:8443/?machine=mac&ws=w8Y&pane=w8Y%3Ap1&view=chat");
	assert.match(calls.at(-1)!.body.text, /Sent to chief \(#1\)/);
	assert.equal(store.get("telegram_offset"), "8");
	assert.deepEqual(store.takeAnswers("s1").map(q => [q.id, q.answer]), [[id, "yes, ship"]]);
	assert.equal(store.takeAnswers("s1").length, 0, "answers are delivered at most once");
});

test("replies: strangers ignored, threaded answers, unthreaded goes to inbox", async () => {
	const { api } = fakeApi();
	store.ask({ sessionId: "s1", question: "A?", urgent: true });
	await sendQueued(config, store, api);
	assert.equal(handleMessage(config, store, msg("hi", 100, 42)), undefined);
	assert.equal(handleMessage(config, store, { ...msg("hi"), chat: { id: Number(ME), type: "group" } }), undefined);
	store.ask({ sessionId: "s1", question: "B?", urgent: false });
	await sendQueued(config, store, api);
	store.set(store.seenKey("chief"), String(Date.now()));
	store.set(store.stateKey("chief"), "idle");
	assert.match(handleMessage(config, store, msg("which?"))!, /Sent to chief/);
	assert.equal(store.countInboxQueued(), 1);
	store.set(store.stateKey("chief"), "working");
	assert.match(handleMessage(config, store, msg("later"))!, /after the current task/);
	store.set(store.seenKey("chief"), "0");
	assert.match(handleMessage(config, store, msg("offline note"))!, /offline/);
	store.set(store.seenKey("chief"), String(Date.now()));
	assert.match(handleMessage(config, store, msg("b answer", 101))!, /#2/);
	assert.match(handleMessage(config, store, msg("a answer", 100))!, /#1/);
	assert.match(handleMessage(config, store, msg("late", 100))!, /closed/);
	store.set(store.stateKey("chief"), "idle");
	assert.match(handleMessage(config, store, { ...msg("thanks", 999), reply_to_message: { message_id: 999, text: "Chief says hi" } })!, /Sent to chief/);
	assert.match(store.takeInbox("chief").pop()!.context!, /Replying to/);
});

test("failed sends are retried; a crash mid-send requeues", async () => {
	store.ask({ sessionId: "s1", question: "A?", urgent: true });
	const errors: string[] = [];
	await sendQueued(config, store, async () => { throw new Error("chat not found"); }, s => errors.push(s));
	assert.match(errors[0], /#1 not sent: chat not found/);
	assert.equal(store.question(1)!.status, "queued");
	store.claimQueued();
	store.requeueSending();
	assert.equal(store.question(1)!.status, "queued");
	assert.equal(questionMessage({ ...config, ovisBaseUrl: "" }, store.question(1)!).hasOwnProperty("reply_markup"), false);
});

test("telegram /status and non-text", () => {
	store.set(store.seenKey("chief"), String(Date.now()));
	store.set(store.stateKey("chief"), "idle");
	assert.match(statusLine(store), /Chief online/);
	assert.match(handleMessage(config, store, msg("/status"))!, /open question/);
	assert.match(handleMessage(config, store, { message_id: 1, chat: { id: Number(ME), type: "private" }, from: { id: Number(ME) } })!, /Only text and voice/);
});

test("outbox send and truncation", async () => {
	store.queueOutbox("hi");
	const { api, calls } = fakeApi();
	await sendOutbox(config, store, api);
	assert.equal(calls[0].body.text, "hi");
	assert.equal(calls[0].body.disable_notification, false);
	store.queueOutbox("x".repeat(5000));
	await sendOutbox(config, store, api);
	assert.equal(calls.at(-1)!.body.text.length, 4000);
	assert.match(calls.at(-1)!.body.text, /…$/);
});

test("send loop sends while getUpdates is blocked", async () => {
	store.ask({ sessionId: "s1", question: "Q?", urgent: true });
	store.queueOutbox("reply");
	const ac = new AbortController();
	const calls: string[] = [];
	const api: Api = async (method, body) => {
		if (method === "sendMessage") {
			calls.push(body.text);
			return { message_id: calls.length + 100 };
		}
		if (method === "getUpdates") {
			await new Promise<void>((resolve, reject) => {
				if (ac.signal.aborted) return reject(new Error("aborted"));
				ac.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		}
		return {};
	};
	const worker = runWorker({ config, store, api, signal: ac.signal });
	await new Promise(r => setTimeout(r, 2500));
	assert.ok(calls.some(t => /Chief question/.test(t)));
	assert.ok(calls.includes("reply"));
	ac.abort();
	await worker;
});

test("worker exits on a fatal poll error instead of idling in the send loop", async () => {
	const api: Api = async method => {
		if (method === "getUpdates") throw new TelegramError("getUpdates", 409, "Conflict");
		return { message_id: 1 };
	};
	await assert.rejects(runWorker({ config, store, api }), /Another process is polling/);
});

test("unthreaded with one open question adds hint context", async () => {
	const { api } = fakeApi();
	store.ask({ sessionId: "s1", question: "Ship?", urgent: true });
	await sendQueued(config, store, api);
	store.set(store.seenKey("chief"), String(Date.now()));
	handleMessage(config, store, msg("maybe"));
	assert.match(store.takeInbox("chief")[0].context!, /ask_baha_close/);
});

test("extension: off by default, /chief on exposes tools, answers are injected", async () => {
	process.env.CHIEF_WATCH_MS = "5000";
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const sent: string[] = [];
	const entries: any[] = [];
	let active: string[] = ["read", "bash", "edit", "write"];
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerFlag: () => {},
		registerCommand: (name: string, c: any) => commands.set(name, c),
		on: (event: string, h: Function) => handlers.set(event, h),
		getFlag: () => false,
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendUserMessage: (m: string) => sent.push(m),
	};
	const ctx: any = {
		sessionManager: { getSessionId: () => "s1", getBranch: () => entries },
		ui: { notify: () => {} },
	};
	chief(pi);
	handlers.get("session_start")!({}, ctx);
	assert.equal(tools.get("ask_baha").exposure, "hidden");
	assert.ok(!active.includes("ask_baha"));

	setConfig("telegramUserId", ME);
	await commands.get("chief").handler("on", ctx);
	assert.equal(tools.get("ask_baha").exposure, "direct");
	assert.deepEqual(active, ["read", "bash", "chief_remember", "chief_recall", "chief_forget", "ask_baha", "ask_baha_close", "reply_baha", "start_worker", "assign_lead", "watch_agent", "waiting_agents", "agents_overview", "resume_agent", "upgrade_model", "wait_for_model"]);
	assert.ok(!active.includes("edit"));
	assert.ok(!active.includes("write"));

	const result = await tools.get("ask_baha").execute("t", { question: "Merge?" }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /Queued question #1.*worker isn't running/);
	await tools.get("chief_remember").execute("t", { text: "Baha merges on Fridays" });

	const event: any = { messageType: "user", prompt: "should we merge today?", systemPromptOptions: { sections: {} } };
	handlers.get("before_agent_start")!(event, ctx);
	assert.match(event.systemPromptOptions.sections.chief, /merges on Fridays[\s\S]*#1 Merge\?/);
	assert.match(event.systemPromptOptions.sections.chief, /reply_baha/);
	assert.match(event.systemPromptOptions.sections.chief, /dispatcher/);
	assert.ok(event.systemPromptOptions.sections.chief.length <= 4000);

	store.queueInbox("ping from phone", "ctx");
	handlers.get("agent_start")!({});
	assert.equal(store.get(store.stateKey("chief")), "working");
	handlers.get("agent_end")!({});
	assert.equal(store.get(store.stateKey("chief")), "idle");

	await new Promise(r => setTimeout(r, 2100));
	assert.equal(sent.filter(m => m.includes("ping from phone")).length, 1);
	assert.match(sent.find(m => m.includes("ping from phone"))!, /\(ctx\)[\s\S]*reply_baha/);

	const ctx2 = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "other" } };
	await commands.get("chief").handler("on", ctx2);
	store.queueInbox("for owner only");
	await new Promise(r => setTimeout(r, 2100));
	assert.equal(sent.filter(m => m.includes("for owner only")).length, 0);

	const reader = new Store();
	reader.db.prepare("UPDATE questions SET status = 'sent', telegram_message_id = 55").run();
	reader.answer(55, "yes");
	reader.close();
	await new Promise(r => setTimeout(r, 2100));
	assert.deepEqual(sent.filter(m => m.includes("question #1")), ['[Telegram reply to chief question #1: "Merge?"]\n\nyes']);

	handlers.get("session_start")!({}, ctx);
	assert.equal(tools.get("ask_baha").exposure, "direct");
	await commands.get("chief").handler("off", ctx);
	handlers.get("session_start")!({}, ctx);
	assert.equal(tools.get("ask_baha").exposure, "hidden");
	assert.deepEqual(active, ["read", "bash", "edit", "write"]);
	handlers.get("before_agent_start")!(event, ctx);
	assert.equal(event.systemPromptOptions.sections.chief, undefined);
	handlers.get("session_shutdown")!({}, ctx);
	delete process.env.CHIEF_WATCH_MS;
});

test("start_worker runs herdr in order; tool registers watch", async () => {
	const calls: string[][] = [];
	setHerdr(async args => {
		calls.push(args);
		if (args[0] === "workspace" && args[1] === "create") return { root_pane: { pane_id: "w1:p1" } };
		return {};
	});
	for (const bad of ["dell-github-login", "Dell", "gh_login", "a", "really-long-name"]) {
		await assert.rejects(startWorker({ name: bad, cwd: "/tmp/proj", task: "x" }), /short kebab-case/);
	}
	const pane = await startWorker({ name: "worker1", cwd: "/tmp/proj", task: "do thing" });
	assert.equal(pane, "w1:p1");
	assert.deepEqual(calls.map(c => c.slice(0, 3)), [["workspace", "create", "--cwd"], ["agent", "start", "worker1"], ["agent", "prompt", "worker1"]]);
	store.addWatch({ target: "worker1", label: "proj", via: "local", owner: "chief" });
	assert.equal(store.activeWatches().length, 1);
});

test("watcher fires on working then done once", async () => {
	let status = "working";
	setHerdr(async () => ({ agent: { agent_status: status } }));
	store.addWatch({ target: "w1", label: "job", via: "local", owner: "chief" });
	const fired: string[] = [];
	await tickWatch(store, store.activeWatches()[0], m => fired.push(m));
	assert.equal(fired.length, 0);
	status = "done";
	const live = store.activeWatches()[0];
	await tickWatch(store, { ...live, sawWorking: true }, m => fired.push(m));
	assert.equal(fired.length, 1);
	assert.match(fired[0], /\[Herdr\] worker w1 \(job\) is now done/);
	assert.equal(store.activeWatches().length, 0);
});

test("watcher blocked fires immediately; idle respects 60s threshold", async () => {
	setWatchIdleMs(60_000);
	let t0 = 1_000_000;
	setNowMs(() => t0);
	setHerdr(async () => ({ agent: { agent_status: "blocked" } }));
	store.addWatch({ target: "b1", via: "local", owner: "chief", createdAt: t0 });
	const fired: string[] = [];
	await tickWatch(store, store.activeWatches()[0], m => fired.push(m));
	assert.equal(fired.length, 1);
	store.addWatch({ target: "i1", via: "local", owner: "chief", createdAt: t0 });
	setHerdr(async () => ({ agent: { agent_status: "idle" } }));
	await tickWatch(store, store.activeWatches()[0], m => fired.push(m));
	assert.equal(fired.length, 1);
	t0 += 61_000;
	store.addWatch({ target: "i2", via: "local", owner: "chief", createdAt: t0 - 61_000 });
	const i2 = store.activeWatches().find(w => w.target === "i2")!;
	await tickWatch(store, i2, m => fired.push(m));
	assert.equal(fired.length, 2);
});

test("watcher not-found fires exited; transient errors do not fire", async () => {
	setHerdr(async () => { throw new Error("agent_not_found: agent target w9 not found"); });
	store.addWatch({ target: "gone", via: "local", owner: "chief" });
	const fired: string[] = [];
	await tickWatch(store, store.activeWatches()[0], m => fired.push(m));
	assert.match(fired[0], /exited/);
	setHerdr(async () => { throw new Error("network timeout"); });
	store.addWatch({ target: "retry", via: "local", owner: "chief" });
	await tickWatch(store, store.activeWatches()[0], m => fired.push(m));
	assert.equal(fired.length, 1);
	assert.equal(store.activeWatches().length, 1);
});

test("watches persist across Store instances", () => {
	store.addWatch({ target: "persist", label: "x", via: "telegram", owner: "chief" });
	const dir = process.env.PI_CHIEF_DATA_DIR!;
	store.close();
	const again = new Store(dir);
	assert.equal(again.activeWatches()[0].target, "persist");
	again.close();
});

test("waiting_agents formats blocked/done and excludes own pane", async () => {
	setHerdr(async args => {
		if (args[0] === "agent" && args[1] === "list") {
			return { agents: [{ name: "chief", pane_id: "chief:p1", workspace_id: "w92", agent_status: "blocked" }, { pane_id: "w2:p1", workspace_id: "w2", agent_status: "done" }] };
		}
		if (args[0] === "workspace" && args[1] === "list") return { workspaces: [{ workspace_id: "w2", label: "proj" }, { workspace_id: "w92", label: "chief" }] };
		if (args[0] === "agent" && args[1] === "read") return "line1\nline2\nresult here\n";
		return {};
	});
	const text = await waitingAgentsText("chief:p1");
	assert.match(text, /^proj \/ w2:p1 \(done\) · unknown: line1 line2 result here$/);
	assert.doesNotMatch(text, /chief/);
	assert.equal(await waitingAgentsText("chief:p1", undefined, ["w2:p1"]), "Nothing is waiting on Baha.", "already-reported finished workers are skipped");
	assert.match(await waitingAgentsText(undefined, undefined, ["chief"]), /chief \/ chief \(blocked\) · unknown:/, "blocked agents always show");
	setHerdr(async args => {
		if (args[0] === "agent" && args[1] === "list") return { agents: [{ name: "ok", pane_id: "x", workspace_id: "w1", agent_status: "working" }] };
		if (args[0] === "workspace" && args[1] === "list") return { workspaces: [] };
		return {};
	});
	assert.equal(await waitingAgentsText(), "Nothing is waiting on Baha.");
});

test("fireMessage mentions reply_baha for telegram via", () => {
	assert.match(fireMessage("w", "lbl", "done", "telegram"), /reply_baha/);
	assert.doesNotMatch(fireMessage("w", null, "done", "local"), /reply_baha/);
});

test("non-owner chief session does not deliver watch fires", async () => {
	process.env.CHIEF_WATCH_MS = "30";
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const sent: string[] = [];
	const entries: any[] = [];
	let active: string[] = ["read", "bash"];
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerFlag: () => {},
		registerCommand: (name: string, c: any) => commands.set(name, c),
		on: (event: string, h: Function) => handlers.set(event, h),
		getFlag: () => false,
		appendEntry: () => {},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendUserMessage: (m: string) => sent.push(m),
	};
	const ctx1: any = { sessionManager: { getSessionId: () => "s1", getBranch: () => entries }, ui: { notify: () => {} } };
	const ctx2: any = { sessionManager: { getSessionId: () => "s2", getBranch: () => entries }, ui: { notify: () => {} } };
	setConfig("telegramUserId", ME);
	chief(pi);
	handlers.get("session_start")!({}, ctx1);
	await commands.get("chief").handler("on", ctx1);
	store.addWatch({ target: "w", label: "t", via: "local", owner: "chief" });
	store.setWatchSawWorking(store.activeWatches()[0].id);
	setHerdr(async () => ({ agent: { agent_status: "done" } }));
	await commands.get("chief").handler("on", ctx2);
	await new Promise(r => setTimeout(r, 120));
	assert.equal(sent.filter(m => m.includes("[Herdr]")).length, 0);
	await commands.get("chief").handler("off", ctx2);
	delete process.env.CHIEF_WATCH_MS;
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, loadConfig, looksLikeSecret, ovisLink, setConfig, type Config } from "../store.ts";
import { TelegramError, handleMessage, questionMessage, runWorker, sendOutbox, sendQueued, statusLine, type Api } from "../telegram.ts";
import { assignLead, fireMessage, setHerdr, setNowMs, setWatchIdleMs, startWorktree, startWorker, tickWatch, waitingAgentsText } from "../herdr.ts";
import { setModelsDeps } from "../models.ts";
import chief from "../index.ts";

const ME = "1912767327";
const config: Config = { ovisBaseUrl: "https://ovis.example.ts.net:8443/", machineId: "mac", telegramUserId: ME };
let store: Store;

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "chief-test-"));
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

test("inbox recipients: telegram and lead queues are separate", () => {
	store.queueInbox("to chief", "ctx", "chief");
	store.queueInbox("to lead", "Task from chief", "lead:botbox");
	assert.equal(store.countInboxQueued("chief"), 1);
	assert.equal(store.countInboxQueued("lead:botbox"), 1);
	assert.deepEqual(store.takeInbox("chief").map(i => i.text), ["to chief"]);
	assert.deepEqual(store.takeInbox("lead:botbox").map(i => i.text), ["to lead"]);
});

test("inbox ownership: latest enabler session receives lead mail", async () => {
	process.env.CHIEF_WATCH_MS = "5000";
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
		registerFlag: () => {},
		on: (event: string, h: Function) => handlers.set(event, h),
		getFlag: () => false,
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendUserMessage: (m: string) => sent.push(m),
	};
	const ctx1: any = { sessionManager: { getSessionId: () => "lead-a", getBranch: () => entries }, ui: { notify: () => {} } };
	const ctx2: any = { sessionManager: { getSessionId: () => "lead-b", getBranch: () => entries }, ui: { notify: () => {} } };
	process.env.PI_CHIEF_LEAD = "botbox";
	chief(pi);
	handlers.get("session_start")!({}, ctx1);
	store.upsertProject("botbox", "/tmp/botbox", "w1");
	store.queueInbox("task one", "Task from chief", "lead:botbox");
	await new Promise(r => setTimeout(r, 2100));
	assert.equal(sent.filter(m => m.includes("task one")).length, 1);
	delete process.env.PI_CHIEF_LEAD;
	process.env.PI_CHIEF_LEAD = "botbox";
	handlers.get("session_start")!({}, ctx2);
	store.queueInbox("task two", "Task from chief", "lead:botbox");
	await new Promise(r => setTimeout(r, 2100));
	assert.equal(sent.filter(m => m.includes("task two")).length, 1);
	assert.equal(sent.filter(m => m.includes("task one")).length, 1);
	delete process.env.PI_CHIEF_LEAD;
	delete process.env.CHIEF_WATCH_MS;
});

test("assign_lead starts lead, persists project, queues task", async () => {
	const calls: string[][] = [];
	setHerdr(async args => {
		calls.push(args);
		if (args[0] === "agent" && args[1] === "get") throw new Error("agent_not_found: botbox");
		if (args[0] === "workspace" && args[1] === "list") {
			return { workspaces: [{ workspace_id: "w9", label: "other", worktree: { checkout_path: "/tmp/other", is_linked_worktree: false } }] };
		}
		if (args[0] === "workspace" && args[1] === "create") return { workspace: { workspace_id: "w10" }, root_pane: { pane_id: "w10:p0" } };
		if (args[0] === "tab" && args[1] === "create") return { tab: { tab_id: "t1" }, root_pane: { pane_id: "w10:p1" } };
		return {};
	});
	const status = await assignLead(store, { project: "botbox", task: "ship feature", path: "/tmp/botbox", via: "telegram" });
	assert.equal(status, "started");
	assert.deepEqual(store.getProject("botbox"), { name: "botbox", path: "/tmp/botbox", workspaceId: "w10" });
	const leadMail = store.takeInbox("lead:botbox");
	assert.equal(leadMail[0].text, "ship feature");
	assert.match(leadMail[0].context!, /Telegram/);
	assert.ok(calls.some(c => c.includes("PI_CHIEF_LEAD=botbox")));
	calls.length = 0;
	setHerdr(async args => {
		calls.push(args);
		if (args[0] === "agent" && args[1] === "get") return { agent: { agent_status: "idle" } };
		return {};
	});
	assert.equal(await assignLead(store, { project: "botbox", task: "follow up" }), "running");
	assert.equal(calls.filter(c => c[0] === "tab").length, 0);
});

test("assign_lead requires path when lead is missing", async () => {
	setHerdr(async args => {
		if (args[0] === "agent" && args[1] === "get") throw new Error("agent_not_found");
		return {};
	});
	await assert.rejects(assignLead(store, { project: "newproj", task: "x" }), /path is required/);
});

test("start_worktree uses worktree path and composer model", async () => {
	const calls: string[][] = [];
	store.upsertProject("botbox", "/tmp/myrepo", "w1");
	setHerdr(async args => {
		calls.push(args);
		if (args[0] === "worktree" && args[1] === "create") {
			return { root_pane: { pane_id: "wt:p1" }, workspace: { workspace_id: "ww" }, worktree: { branch: "user-auth", path: `${process.env.HOME}/.herdr/worktrees/myrepo/user-auth` } };
		}
		return {};
	});
	const pane = await startWorktree("/tmp/myrepo", { name: "user-auth", task: "implement auth" });
	assert.equal(pane, "wt:p1");
	const wtCall = calls.find(c => c[0] === "worktree");
	assert.ok(wtCall?.includes(`${process.env.HOME}/.herdr/worktrees/myrepo/user-auth`));
	const startCall = calls.find(c => c[0] === "agent" && c[1] === "start");
	assert.ok(startCall?.includes("cursor-ide/composer-2.5:high"));
});

test("report_chief queues chief inbox", () => {
	store.queueInbox("done", "Report from lead botbox", "chief");
	assert.equal(store.takeInbox("chief")[0].text, "done");
});

test("watches tick only for matching owner", async () => {
	store.addWatch({ target: "a1", via: "local", owner: "chief" });
	store.addWatch({ target: "a2", via: "local", owner: "lead:botbox" });
	setHerdr(async () => ({ agent: { agent_status: "blocked" } }));
	const fired: string[] = [];
	for (const w of store.activeWatches("chief")) await tickWatch(store, w, m => fired.push(m));
	assert.equal(fired.length, 1);
	assert.match(fired[0], /a1/);
});

test("DB migration adds recipient and owner columns", () => {
	const dir = mkdtempSync(join(tmpdir(), "chief-old-"));
	const dbPath = join(dir, "chief.sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec(`CREATE TABLE inbox (id INTEGER PRIMARY KEY, text TEXT NOT NULL, context TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL);
		CREATE TABLE watches (id INTEGER PRIMARY KEY, target TEXT NOT NULL, machine TEXT, label TEXT, via TEXT NOT NULL, saw_working INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active');
		CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
	db.prepare("INSERT INTO inbox (text, context, status, created_at) VALUES ('old', NULL, 'queued', 1)").run();
	db.close();
	process.env.PI_CHIEF_DATA_DIR = dir;
	const migrated = new Store(dir);
	migrated.queueInbox("new", undefined, "lead:x");
	assert.deepEqual(migrated.takeInbox("chief").map(i => i.text), ["old"]);
	assert.deepEqual(migrated.takeInbox("lead:x").map(i => i.text), ["new"]);
	migrated.addWatch({ target: "t", via: "local", owner: "lead:x" });
	assert.equal(migrated.activeWatches("lead:x").length, 1);
	migrated.close();
});

test("lead role exposes start_worktree not assign_lead", async () => {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	let active: string[] = ["read", "bash", "edit", "write"];
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerFlag: () => {},
		registerCommand: (name: string, c: any) => commands.set(name, c),
		on: (event: string, h: Function) => handlers.set(event, h),
		getFlag: () => false,
		appendEntry: () => {},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		sendUserMessage: () => {},
	};
	const ctx: any = { sessionManager: { getSessionId: () => "s-lead", getBranch: () => entries }, ui: { notify: () => {} } };
	process.env.PI_CHIEF_LEAD = "botbox";
	chief(pi);
	handlers.get("session_start")!({}, ctx);
	assert.ok(active.includes("start_worktree"));
	assert.ok(!active.includes("assign_lead"));
	assert.ok(!active.includes("edit"));
	delete process.env.PI_CHIEF_LEAD;
	await commands.get("chief").handler("off", ctx);
	assert.ok(active.includes("edit"));
});
test("project leads aren't flagged as waiting just for being done", () => {
	store.upsertProject("botbox", "/tmp/botbox", "w1");
	store.addWatch({ target: "w2:p1", label: "api-fix", via: "local", owner: "chief" });
	assert.deepEqual(store.reportedTargets(), ["botbox"]);
	store.finishWatch(store.activeWatches()[0].id);
	assert.deepEqual(store.reportedTargets().sort(), ["botbox", "w2:p1"]);
});

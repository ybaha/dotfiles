import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionContextTokens } from "../agents.ts";
import {
	BIG_CONTEXT_TOKENS,
	BRIDGE_COMPACT_INSTRUCTIONS,
	bridgeAvailable,
	nextBigModel,
	parseModelChain,
	setModelsDeps,
	type ModelsDeps,
} from "../models.ts";
import { fireMessage, setHerdr, setNowMs, setResumeDeps, setWatchIdleMs, tickWatch } from "../herdr.ts";
import { Store } from "../store.ts";
import chief from "../index.ts";

let cacheDir: string;
let now: number;
let kv: Map<string, string>;
let deps: ModelsDeps;

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "chief-bridge-"));
	process.env.PI_CHIEF_CONFIG_DIR = join(root, "config");
	process.env.PI_CHIEF_DATA_DIR = join(root, "data");
	cacheDir = mkdtempSync(join(tmpdir(), "chief-bridge-quota-"));
	now = 1_700_000_000_000;
	kv = new Map();
	deps = { cacheDir, now: () => now, getKv: key => kv.get(key), setKv: (key, value) => kv.set(key, value) };
	setModelsDeps(deps);
	setHerdr(null);
	setResumeDeps(null);
	setWatchIdleMs(60_000);
	setNowMs(() => now);
});

function writeQuota(name: string, body: object): void {
	writeFileSync(join(cacheDir, name + ".json"), JSON.stringify(body));
}

function sessionFile(name: string, lines: object[]): string {
	const path = join(tmpdir(), "bridge-sess-" + name + "-" + process.pid + ".jsonl");
	writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
	return path;
}

function fakeChiefPi() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const sent: { text: string }[] = [];
	let compactCalls: { customInstructions?: string }[] = [];
	let current = { provider: "openai-codex", id: "gpt-6.1-sol" };
	let contextUsage = { tokens: 50_000, contextWindow: 200_000, percent: 25 };
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerFlag: () => {},
		registerCommand: (name: string, c: any) => commands.set(name, c),
		on: (event: string, h: Function) => handlers.set(event, h),
		getFlag: () => true,
		appendEntry: () => {},
		getActiveTools: () => ["read"],
		setActiveTools: () => {},
		sendUserMessage: (m: string) => sent.push({ text: m }),
		getModel: () => current,
		setModel: async (m: { provider: string; id: string }) => { current = m; },
		setThinkingLevel: () => {},
	};
	const ctx: any = {
		sessionManager: { getSessionId: () => "s1", getBranch: () => [{ type: "custom", customType: "chief", data: { enabled: true } }] },
		ui: { notify: () => {} },
		modelRegistry: { find: (p: string, id: string) => ({ provider: p, id }) },
		model: current,
		getContextUsage: () => contextUsage,
		compact: (opts?: { customInstructions?: string }) => { compactCalls.push(opts ?? {}); },
	};
	return {
		pi, ctx, handlers, commands, tools, sent, compactCalls,
		set contextUsage(v) { contextUsage = v; },
		set current(v) { current = v; ctx.model = v; },
		fireCompact: () => handlers.get("session_compact")!({}, ctx),
		fireCompactFailed: () => handlers.get("session_compact_failed")!({}, ctx),
	};
}

test("sessionContextTokens sums input, cacheRead, and output", () => {
	const path = sessionFile("tok", [{ type: "message", message: { role: "assistant", usage: { input: 1000, cacheRead: 2000, output: 500 } } }]);
	assert.equal(sessionContextTokens(path), 3500);
	assert.equal(BIG_CONTEXT_TOKENS, 100_000);
});

test("small context: limit switches to bridge without compact", async () => {
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 80, weeklyLeft: 80 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 80, weeklyLeft: 80 });
	const fake = fakeChiefPi();
	chief(fake.pi);
	await fake.commands.get("chief").handler("on", fake.ctx);
	fake.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit hit" }] }, fake.ctx);
	await new Promise(r => setTimeout(r, 30));
	assert.equal(fake.compactCalls.length, 0);
	assert.match(fake.sent[0]!.text, /you're on MiniMax now/);
	assert.match(fake.sent[0]!.text, /upgrade_model/);
	assert.match(fake.sent[0]!.text, /claude-bridge\/claude-opus-5-5:high/);
});

test("big context: compact then follow-up; compact failure still continues", async () => {
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 80, weeklyLeft: 80 });
	const fake = fakeChiefPi();
	fake.contextUsage = { tokens: 150_000, contextWindow: 200_000, percent: 75 };
	chief(fake.pi);
	await fake.commands.get("chief").handler("on", fake.ctx);
	const endPromise = fake.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit hit" }] }, fake.ctx);
	await new Promise(r => setTimeout(r, 5));
	assert.equal(fake.sent.length, 0);
	assert.equal(fake.compactCalls[0]!.customInstructions, BRIDGE_COMPACT_INSTRUCTIONS);
	fake.fireCompact();
	await endPromise;
	assert.match(fake.sent[0]!.text, /context compacted/);
	fake.sent.length = 0;
	fake.compactCalls.length = 0;
	kv.clear();
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 80, weeklyLeft: 80 });
	fake.current = { provider: "openai-codex", id: "gpt-6.1-sol" };
	fake.contextUsage = { tokens: 200_000, contextWindow: 200_000, percent: 99 };
	const end2 = fake.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit again" }] }, fake.ctx);
	await new Promise(r => setTimeout(r, 5));
	fake.fireCompactFailed();
	await end2;
	assert.doesNotMatch(fake.sent[0]!.text, /context compacted/);
});

test("big context: compact timeout continues without compacted claim", async () => {
	process.env.CHIEF_BRIDGE_COMPACT_TIMEOUT_MS = "50";
	try {
		writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 80, weeklyLeft: 80 });
		const fake = fakeChiefPi();
		fake.contextUsage = { tokens: 150_000, contextWindow: 200_000, percent: 75 };
		chief(fake.pi);
		await fake.commands.get("chief").handler("on", fake.ctx);
		const endPromise = fake.handlers.get("agent_end")!(
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit hit" }] },
			fake.ctx,
		);
		await new Promise(r => setTimeout(r, 80));
		await endPromise;
		assert.match(fake.sent[0]!.text, /you're on MiniMax now/);
		assert.doesNotMatch(fake.sent[0]!.text, /context compacted/);
	} finally {
		delete process.env.CHIEF_BRIDGE_COMPACT_TIMEOUT_MS;
	}
});

test("bridge unavailable keeps next-in-chain retry", async () => {
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 2, weeklyLeft: 2 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 80, weeklyLeft: 80 });
	const fake = fakeChiefPi();
	chief(fake.pi);
	await fake.commands.get("chief").handler("on", fake.ctx);
	fake.handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit hit" }] }, fake.ctx);
	await new Promise(r => setTimeout(r, 30));
	assert.match(fake.sent[0]!.text, /switched to claude-bridge/);
});

test("upgrade_model picks next big model or errors with refill time", async () => {
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 80, weeklyLeft: 80 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 80, weeklyLeft: 80 });
	const fake = fakeChiefPi();
	fake.current = { provider: "minimax", id: "MiniMax-M3.1-Flash" };
	chief(fake.pi);
	await fake.commands.get("chief").handler("on", fake.ctx);
	const out = await fake.tools.get("upgrade_model").execute("t", {}, undefined, undefined, fake.ctx);
	assert.match(out.content[0].text, /Switched to openai-codex\/gpt-6.1-sol:high/);
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 2, weeklyLeft: 2, primaryResetsAt: 1_700_050_000 });
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 2, weeklyLeft: 2, primaryResetsAt: 1_700_200_000 });
	await assert.rejects(fake.tools.get("upgrade_model").execute("t", {}, undefined, undefined, fake.ctx), /No bigger model has quota until/);
});

test("nextBigModel skips bridge provider", () => {
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 80, weeklyLeft: 80 });
	const chain = parseModelChain("openai-codex/gpt-6.1-sol:high, claude-bridge/claude-opus-5-5:high, minimax/MiniMax-M3.1-Flash:high");
	assert.equal(nextBigModel(chain, "minimax/MiniMax-M3.1-Flash:high", deps), "openai-codex/gpt-6.1-sol:high");
	assert.ok(bridgeAvailable("minimax/MiniMax-M3.1-Flash:high", deps));
});

test("worker resume: big context compacts then continues; small continues directly", async () => {
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 80, weeklyLeft: 80 });
	const store = new Store();
	const bigPath = sessionFile("big", [{ type: "message", message: { role: "assistant", provider: "cursor-ide", model: "composer-2.5", stopReason: "error", errorMessage: "rate limit", usage: { input: 80_000, cacheRead: 30_000, output: 10_000 } } }]);
	const smallPath = sessionFile("small", [{ type: "message", message: { role: "assistant", provider: "cursor-ide", model: "composer-2.5", stopReason: "error", errorMessage: "rate limit", usage: { input: 1000, cacheRead: 0, output: 100 } } }]);
	setResumeDeps({ quitPi: async () => {}, waitPiStopped: async () => {} });
	const calls: string[][] = [];
	setHerdr(async args => {
		calls.push(args);
		if (args[0] === "agent" && args[1] === "get" && args[2] === "worker1") {
			return { agent: { name: "worker1", pane_id: "w1:p1", workspace_id: "w1", agent: "pi", agent_status: "done", agent_session: { kind: "path", value: bigPath } } };
		}
		if (args[0] === "agent" && args[1] === "get" && args[2] === "worker2") {
			return { agent: { name: "worker2", pane_id: "w2:p1", workspace_id: "w1", agent: "pi", agent_status: "done", agent_session: { kind: "path", value: smallPath } } };
		}
		return {};
	});
	store.addWatch({ target: "worker1", label: "job", via: "local", owner: "chief", createdAt: now - 120_000 });
	store.setWatchSawWorking(store.activeWatches()[0].id);
	await tickWatch(store, store.activeWatches()[0], () => {});
	assert.ok(calls.some(c => String(c[3] ?? "").startsWith("/compact")));
	calls.length = 0;
	store.addWatch({ target: "worker2", label: "job2", via: "local", owner: "chief", createdAt: now - 120_000 });
	store.setWatchSawWorking(store.activeWatches()[1].id);
	await tickWatch(store, store.activeWatches()[1], () => {});
	assert.ok(!calls.some(c => String(c[3] ?? "").startsWith("/compact")));
	store.close();
});

test("worker finish with needs bigger model adds resume hint", async () => {
	writeQuota("cursor", { fetchedAt: now, live: true, state: "running" });
	const store = new Store();
	const sess = sessionFile("done", [{ type: "message", message: { role: "assistant", provider: "minimax", model: "MiniMax-M3.1-Flash", stopReason: "stop" } }]);
	setHerdr(async args => {
		if (args[0] === "agent" && args[1] === "get") return { agent: { name: "worker1", pane_id: "w1:p1", workspace_id: "w1", agent: "pi", agent_status: "done", agent_session: { kind: "path", value: sess } } };
		if (args[0] === "agent" && args[1] === "read") return "needs bigger model\n";
		return {};
	});
	store.addWatch({ target: "worker1", label: "job", via: "local", owner: "chief", createdAt: now - 120_000 });
	store.setWatchSawWorking(store.activeWatches()[0].id);
	const fired: string[] = [];
	await tickWatch(store, store.activeWatches()[0], m => fired.push(m));
	assert.match(fired[0], /resume_agent worker1 with cursor-ide\/composer-2.5:high/);
	assert.match(fireMessage("w", "l", "done", "local", " extra"), /extra$/);
	store.close();
});

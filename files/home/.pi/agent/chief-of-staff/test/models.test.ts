import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chainAllUnavailable,
	isUsageLimitError,
	lastAssistantLimit,
	markProviderExhausted,
	parseModelChain,
	pickModel,
	providerHasHeadroom,
	providerStatus,
	quotaLine,
	soonestRefill,
	setModelsDeps,
	type ModelsDeps,
} from "../models.ts";
import { assignLead, setHerdr, startWorktree, startWorker } from "../herdr.ts";
import { Store } from "../store.ts";
import chief from "../index.ts";

let cacheDir: string;
let now: number;
let kv: Map<string, string>;
let deps: ModelsDeps;

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "chief-quota-"));
	now = 1_700_000_000_000;
	kv = new Map();
	deps = {
		cacheDir,
		now: () => now,
		getKv: key => kv.get(key),
		setKv: (key, value) => kv.set(key, value),
	};
	setModelsDeps(deps);
	setHerdr(null);
});

function writeQuota(name: string, body: object): void {
	writeFileSync(join(cacheDir, `${name}.json`), JSON.stringify(body));
}

test("providerStatus thresholds, stale, cursor, minimax ms, exhausted kv", () => {
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 13, weeklyLeft: 30, primaryResetsAt: 1_700_010_000, weeklyResetsAt: 1_700_100_000 });
	assert.deepEqual(providerStatus("openai-codex", deps), { available: true, summary: "13%/30%", resetsAt: 1_700_010_000_000 });
	writeQuota("codex", { fetchedAt: now - 21 * 60_000, live: true, primaryLeft: 1, weeklyLeft: 1 });
	assert.equal(providerStatus("openai-codex", deps).summary, "unknown");
	assert.equal(providerStatus("openai-codex", deps).available, true);
	writeQuota("cursor", { fetchedAt: now, live: true, state: "running" });
	assert.equal(providerStatus("cursor-ide", deps).summary, "running");
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 96, weeklyLeft: 100, currentResetsAt: now + 3_600_000, weeklyResetsAt: now + 86_400_000 });
	assert.equal(providerStatus("minimax", deps).summary, "96%/100%");
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30 });
	assert.equal(providerStatus("openai-codex", deps).available, false);
	kv.set("exhausted:claude-bridge", String(now + 60_000));
	assert.equal(providerStatus("claude-bridge", deps).available, false);
	assert.equal(providerStatus("claude-bridge", deps).summary, "exhausted");
});

test("pickModel prefers first available and soonest reset when all out", () => {
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 1, weeklyLeft: 1, primaryResetsAt: 1_700_200_000 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 1, weeklyLeft: 1, primaryResetsAt: 1_700_050_000 });
	const chain = parseModelChain("openai-codex/gpt-6.1-sol:high, claude-bridge/claude-opus-5-5:high");
	assert.equal(pickModel(chain, deps), "claude-bridge/claude-opus-5-5:high");
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 50, weeklyLeft: 50 });
	assert.equal(pickModel(chain, deps), "openai-codex/gpt-6.1-sol:high");
});

test("quotaLine summarizes providers and refill when low", () => {
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 13, weeklyLeft: 30, primaryResetsAt: 1_700_010_000 });
	assert.match(quotaLine(deps), /codex 13%\/30% \(5h refills \d{2}:\d{2}\)/);
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 47, weeklyLeft: 72 });
	assert.match(quotaLine(deps), /claude 47%\/72%/);
	assert.doesNotMatch(quotaLine(deps), /claude 47%\/72% \(5h refills/);
});

test("pickModel headroom new vs continue and soonestRefill", () => {
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 16, weeklyLeft: 80, primaryResetsAt: 1_700_200_000 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 10, weeklyLeft: 80, primaryResetsAt: 1_700_050_000 });
	const chain = parseModelChain("openai-codex/gpt-6.1-sol:high, claude-bridge/claude-opus-5-5:high");
	assert.equal(pickModel(chain, { headroom: "new" }, deps), "openai-codex/gpt-6.1-sol:high");
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 12, weeklyLeft: 80 });
	assert.equal(pickModel(chain, { headroom: "new" }, deps), "claude-bridge/claude-opus-5-5:high");
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 80, primaryResetsAt: 1_700_200_000 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 80, primaryResetsAt: 1_700_050_000 });
	assert.equal(soonestRefill(chain, deps), 1_700_050_000_000);
	assert.equal(pickModel(chain, { headroom: "continue" }, deps), "claude-bridge/claude-opus-5-5:high");
});

test("limit detection ignores non-limit errors", () => {
	assert.ok(isUsageLimitError("error", "rate limit exceeded"));
	assert.ok(!isUsageLimitError("error", "context length"));
	assert.ok(!lastAssistantLimit([{ role: "user" }, { role: "assistant", stopReason: "stop" }]));
	assert.ok(lastAssistantLimit([{ role: "assistant", stopReason: "error", errorMessage: "429 too many requests" }]));
});

test("markProviderExhausted uses cache reset", () => {
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 1, weeklyLeft: 1, primaryResetsAt: 1_700_000_100 });
	markProviderExhausted("openai-codex", deps);
	assert.equal(kv.get("exhausted:openai-codex"), String(1_700_000_100_000));
});

test("herdr starts pass picked worker and lead models", async () => {
	writeQuota("cursor", { fetchedAt: now, live: true, state: "running" });
	const calls: string[][] = [];
	setHerdr(async args => {
		calls.push(args);
		if (args[0] === "workspace" && args[1] === "create") return { workspace: { workspace_id: "w10" }, root_pane: { pane_id: "w1:p1" } };
		if (args[0] === "worktree" && args[1] === "create") return { root_pane: { pane_id: "wt:p1" } };
		if (args[0] === "agent" && args[1] === "get") throw new Error("agent_not_found");
		if (args[0] === "workspace" && args[1] === "list") return { workspaces: [] };
		if (args[0] === "tab" && args[1] === "create") return { root_pane: { pane_id: "w10:p1" } };
		return {};
	});
	const root = mkdtempSync(join(tmpdir(), "chief-herdr-"));
	process.env.PI_CHIEF_CONFIG_DIR = join(root, "config");
	process.env.PI_CHIEF_DATA_DIR = join(root, "data");
	const st = new Store();
	await startWorker({ name: "job1", cwd: "/tmp/x", task: "do" });
	await startWorktree("/tmp/myrepo", { name: "feat1", task: "build" });
	await assignLead(st, { project: "botbox", task: "lead task", path: "/tmp/botbox" });
	const workerStart = calls.find(c => c[2] === "job1");
	const wtStart = calls.find(c => c[2] === "feat1");
	const leadStart = calls.find(c => c[0] === "agent" && c[1] === "start" && c[2] === "botbox");
	assert.ok(workerStart?.includes("cursor-ide/composer-2.5:high"));
	assert.ok(wtStart?.includes("cursor-ide/composer-2.5:high"));
	assert.ok(leadStart?.includes("openai-codex/gpt-6.1-sol:high"));
	st.close();
});

test("before_agent_start switches model; agent_end limit retries once", async () => {
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 1, weeklyLeft: 1 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 80, weeklyLeft: 80 });
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 80, weeklyLeft: 80 });
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const sent: string[] = [];
	const notifies: string[] = [];
	let current = { provider: "openai-codex", id: "gpt-6.1-sol" };
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerFlag: () => {},
		registerCommand: (name: string, c: any) => commands.set(name, c),
		on: (event: string, h: Function) => handlers.set(event, h),
		getFlag: () => true,
		appendEntry: () => {},
		getActiveTools: () => ["read"],
		setActiveTools: () => {},
		sendUserMessage: (m: string) => sent.push(m),
		getModel: () => current,
		setModel: async (m: { provider: string; id: string }) => { current = m; return true; },
		setThinkingLevel: () => {},
	};
	const ctx: any = {
		sessionManager: { getSessionId: () => "s1", getBranch: () => [{ type: "custom", customType: "chief", data: { enabled: true } }] },
		ui: { notify: (m: string) => notifies.push(m) },
		modelRegistry: {
			find: (provider: string, modelId: string) => ({ provider, id: modelId }),
		},
		model: current,
	};
	const root = mkdtempSync(join(tmpdir(), "chief-ext-"));
	process.env.PI_CHIEF_CONFIG_DIR = join(root, "config");
	process.env.PI_CHIEF_DATA_DIR = join(root, "data");
	chief(pi);
	await commands.get("chief").handler("on", ctx);
	notifies.length = 0;
	const event: any = { messageType: "user", prompt: "hi", systemPromptOptions: { sections: {} } };
	await handlers.get("before_agent_start")!(event, ctx);
	await new Promise(r => setTimeout(r, 50));
	assert.match(notifies.join(" "), /switched to claude-bridge/);
	handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit hit" }] }, ctx);
	await new Promise(r => setTimeout(r, 10));
	assert.equal(sent.length, 1);
	assert.match(sent[0], /you're on MiniMax/);
	assert.match(sent[0], /upgrade_model/);
	handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
	handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
	assert.equal(chainAllUnavailable(parseModelChain("openai-codex/gpt-6.1-sol:high, claude-bridge/claude-opus-5-5:high"), deps), false);
});

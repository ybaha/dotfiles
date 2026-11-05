import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	armWaitForModel,
	tickQuotaWake,
	wakeAtKey,
	wakeModelKey,
	wakeAgentKey,
	wakeTaskKey,
	parseModelChain,
	setModelsDeps,
	type ModelsDeps,
} from "../models.ts";
import { Store } from "../store.ts";
import { resumeAgent, setHerdr, setResumeDeps } from "../herdr.ts";
import { BIG_CONTEXT_TOKENS } from "../models.ts";

let cacheDir: string;
let now: number;
let store: Store;
let deps: ModelsDeps;

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "chief-waitmodel-"));
	process.env.PI_CHIEF_DATA_DIR = join(root, "data");
	cacheDir = mkdtempSync(join(tmpdir(), "chief-waitmodel-quota-"));
	now = 1_700_000_000_000;
	store = new Store();
	deps = {
		cacheDir,
		now: () => now,
		getKv: key => store.get(key),
		setKv: (key, value) => store.set(key, value),
		deleteKv: key => store.remove(key),
	};
	setModelsDeps(deps);
	setHerdr(null);
	setResumeDeps(null);
});

function writeQuota(name: string, body: object): void {
	writeFileSync(join(cacheDir, `${name}.json`), JSON.stringify(body));
}

const chain = parseModelChain("openai-codex/gpt-6.1-sol:high, claude-bridge/claude-opus-5-5:high");
const recipient = "chief";
const model = "claude-bridge/claude-opus-5-5:high";

function outboxTexts(): string[] {
	return (store.db.prepare("SELECT text FROM outbox ORDER BY id").all() as { text: string }[]).map(r => r.text);
}

test("armWaitForModel returns waiting line and replaces prior arm", () => {
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 0, weeklyLeft: 30, primaryResetsAt: 1_700_100_000 });
	const first = armWaitForModel(recipient, model, "implement feature A", "life-hq", deps);
	assert.match(first.waitLine, /Waiting for claude-bridge\/claude-opus-5-5:high until/);
	assert.match(first.waitLine, /resuming life-hq automatically/);
	assert.ok(first.shouldNotifyTelegram);
	store.queueOutbox(first.telegramLine);
	assert.equal(outboxTexts().length, 1);
	const second = armWaitForModel(recipient, model, "implement feature B", "life-hq", deps);
	assert.match(second.waitLine, /Waiting for/);
	assert.equal(store.get(wakeTaskKey(recipient)), "implement feature B");
	assert.equal(outboxTexts().length, 1);
});

test("not due sends nothing", async () => {
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 0, weeklyLeft: 30, primaryResetsAt: 1_700_100_000 });
	armWaitForModel(recipient, model, "task", "life-hq", deps);
	const wakeAt = Number(store.get(wakeAtKey(recipient)));
	now = wakeAt - 1;
	const sent: string[] = [];
	const telegram: string[] = [];
	await tickQuotaWake(
		recipient,
		chain,
		{ followUp: m => sent.push(m), telegram: m => telegram.push(m) },
		deps,
	);
	assert.equal(sent.length, 0);
	assert.equal(telegram.length, 0);
});

test("due but model still out re-arms without messages", async () => {
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 0, weeklyLeft: 30, primaryResetsAt: 1_700_100_000 });
	armWaitForModel(recipient, model, "task", "life-hq", deps);
	const wakeAt = Number(store.get(wakeAtKey(recipient)));
	now = wakeAt;
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 0, weeklyLeft: 30, primaryResetsAt: 1_700_150_000 });
	const sent: string[] = [];
	const telegram: string[] = [];
	await tickQuotaWake(
		recipient,
		chain,
		{ followUp: m => sent.push(m), telegram: m => telegram.push(m) },
		deps,
	);
	assert.equal(sent.length, 0);
	assert.equal(telegram.length, 0);
	assert.ok(Number(store.get(wakeAtKey(recipient))) >= wakeAt);
});

test("due with headroom resumes agent and sends one telegram", async () => {
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 0, weeklyLeft: 30, primaryResetsAt: 1_700_100_000 });
	armWaitForModel(recipient, model, "finish the migration", "life-hq", deps);
	const wakeAt = Number(store.get(wakeAtKey(recipient)));
	now = wakeAt;
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 80, weeklyLeft: 80 });
	const calls: string[][] = [];
	setHerdr(async args => {
		calls.push(args);
		if (args[0] === "agent" && args[1] === "get") {
			return {
				agent: {
					name: "life-hq",
					pane_id: "w9:p0",
					agent: "pi",
					agent_status: "idle",
					agent_session: { kind: "path", value: "/tmp/small-session.jsonl" },
				},
			};
		}
		return {};
	});
	setResumeDeps({ quitPi: async () => {}, waitPiStopped: async () => {} });
	writeFileSync("/tmp/small-session.jsonl", '{"type":"message","message":{"role":"assistant","usage":{"input":1,"output":1}}}\n');
	const sent: string[] = [];
	const telegram: string[] = [];
	await tickQuotaWake(recipient, chain, {
		followUp: m => sent.push(m),
		telegram: m => telegram.push(m),
		resumeAgent: async p => {
			await resumeAgent(store, { target: p.target, model: p.model, message: `Continue: ${p.task}`, compactIfLarge: true });
		},
	}, deps);
	await tickQuotaWake(recipient, chain, { followUp: m => sent.push(m), telegram: m => telegram.push(m) }, deps);
	assert.equal(sent.length, 0);
	assert.equal(telegram.length, 1);
	assert.match(telegram[0]!, /Claude quota is back/);
	assert.match(telegram[0]!, /resumed life-hq/);
	assert.equal(store.get(wakeAtKey(recipient)), undefined);
	assert.equal(store.get(wakeModelKey(recipient)), undefined);
	const prompt = calls.find(c => c[0] === "agent" && c[1] === "prompt" && c[2] === "life-hq");
	assert.ok(prompt?.[3]?.startsWith("Continue: finish the migration"));
	assert.ok(!calls.some(c => c[3]?.startsWith?.("/compact")));
});

test("due with headroom and no agent switches chief and follow-ups task", async () => {
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 0, weeklyLeft: 30, primaryResetsAt: 1_700_100_000 });
	armWaitForModel(recipient, model, "continue planning", undefined, deps);
	now = Number(store.get(wakeAtKey(recipient)));
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 80, weeklyLeft: 80 });
	let switched = "";
	const sent: string[] = [];
	const telegram: string[] = [];
	await tickQuotaWake(recipient, chain, {
		followUp: m => sent.push(m),
		telegram: m => telegram.push(m),
		wakeChief: async p => {
			switched = p.model;
			return true;
		},
	}, deps);
	assert.equal(switched, model);
	assert.deepEqual(sent, ["continue planning"]);
	assert.equal(telegram.length, 1);
	assert.match(telegram[0]!, /continued the task/);
});

test("resume failure re-arms without duplicate telegram error", async () => {
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 0, weeklyLeft: 30, primaryResetsAt: 1_700_100_000 });
	armWaitForModel(recipient, model, "task", "life-hq", deps);
	now = Number(store.get(wakeAtKey(recipient)));
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 80, weeklyLeft: 80 });
	const errors: string[] = [];
	await tickQuotaWake(recipient, chain, {
		followUp: () => {},
		telegramError: m => errors.push(m),
		resumeAgent: async () => {
			throw new Error("agent blocked");
		},
	}, deps);
	await tickQuotaWake(recipient, chain, {
		followUp: () => {},
		telegramError: m => errors.push(m),
		resumeAgent: async () => {
			throw new Error("agent blocked");
		},
	}, deps);
	assert.equal(errors.length, 1);
	assert.ok(store.get(wakeModelKey(recipient)));
});

test("compactIfLarge runs /compact before continue prompt", async () => {
	const sessionPath = mkdtempSync(join(tmpdir(), "chief-session-")) + ".jsonl";
	const bigUsage = BIG_CONTEXT_TOKENS + 50_000;
	writeFileSync(
		sessionPath,
		`{"type":"message","message":{"role":"assistant","usage":{"input":${bigUsage},"output":1}}}\n`,
	);
	const calls: string[][] = [];
	setHerdr(async args => {
		calls.push(args);
		if (args[0] === "agent" && args[1] === "get") {
			return {
				agent: {
					name: "life-hq",
					pane_id: "w9:p0",
					agent: "pi",
					agent_status: "idle",
					agent_session: { kind: "path", value: sessionPath },
				},
			};
		}
		return {};
	});
	setResumeDeps({ quitPi: async () => {}, waitPiStopped: async () => {} });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 80, weeklyLeft: 80 });
	await resumeAgent(store, {
		target: "life-hq",
		model,
		message: "Continue: big task",
		compactIfLarge: true,
	});
	const compactIdx = calls.findIndex(c => c[3]?.startsWith?.("/compact"));
	const continueIdx = calls.findIndex(c => c[3] === "Continue: big task");
	assert.ok(compactIdx >= 0);
	assert.ok(continueIdx > compactIdx);
});

test("wait_for_model kv survives store restart", async () => {
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 0, weeklyLeft: 30, primaryResetsAt: 1_700_100_000 });
	armWaitForModel(recipient, model, "task", "life-hq", deps);
	const wakeAt = store.get(wakeAtKey(recipient));
	store.close();
	store = new Store();
	deps = { ...deps, getKv: key => store.get(key), setKv: (k, v) => store.set(k, v), deleteKv: k => store.remove(k) };
	setModelsDeps(deps);
	assert.equal(store.get(wakeModelKey(recipient)), model);
	assert.equal(store.get(wakeAgentKey(recipient)), "life-hq");
	assert.equal(store.get(wakeAtKey(recipient)), wakeAt);
});

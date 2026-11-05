import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentModel, sessionContextTokens } from "../agents.ts";
import {
	agentsOverviewText,
	resumeAgent,
	setHerdr,
	setNowMs,
	setResumeDeps,
	setWatchIdleMs,
	tickWatch,
} from "../herdr.ts";
import { parseModelChain, setModelsDeps, type ModelsDeps } from "../models.ts";
import { Store } from "../store.ts";

let cacheDir: string;
let now: number;
let kv: Map<string, string>;
let deps: ModelsDeps;
let store: Store;

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "chief-agent-models-"));
	process.env.PI_CHIEF_CONFIG_DIR = join(root, "config");
	process.env.PI_CHIEF_DATA_DIR = join(root, "data");
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
	setResumeDeps(null);
	setWatchIdleMs(60_000);
	setNowMs(() => now);
	store = new Store();
});

function writeQuota(name: string, body: object): void {
	writeFileSync(join(cacheDir, `${name}.json`), JSON.stringify(body));
}

function sessionFile(name: string, lines: object[]): string {
	const path = join(tmpdir(), `sess-${name}-${process.pid}.jsonl`);
	writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
	return path;
}

const piAgent = (over: Record<string, unknown> = {}) => ({
	name: "worker1",
	pane_id: "w1:p1",
	workspace_id: "w1",
	agent: "pi",
	agent_status: "done",
	agent_session: { kind: "path", value: sessionFile("x", []) },
	...over,
});

test("agentModel reads model_change, assistant message, and usage limit", () => {
	const path = sessionFile("limit", [
		{ type: "model_change", provider: "openai-codex", modelId: "gpt-6-luna" },
		{
			type: "message",
			message: {
				role: "assistant",
				provider: "openai-codex",
				model: "gpt-6-luna",
				stopReason: "error",
				errorMessage: "429 usage limit exceeded",
			},
		},
	]);
	const info = agentModel(path);
	assert.deepEqual(info, {
		kind: "pi",
		provider: "openai-codex",
		modelId: "gpt-6-luna",
		ref: "openai-codex/gpt-6-luna",
		usageLimit: true,
	});
	const later = sessionFile("switch", [
		{ type: "model_change", provider: "openai-codex", modelId: "gpt-6-luna" },
		{ type: "message", message: { role: "assistant", provider: "claude-bridge", model: "claude-sonnet-5-5", stopReason: "stop" } },
	]);
	assert.equal(agentModel(later).ref, "claude-bridge/claude-sonnet-5-5");
	assert.equal(agentModel(later).usageLimit, false);
});

test("agents_overview excludes own pane and scopes leads", async () => {
	const sess = sessionFile("ov", [{ type: "model_change", provider: "cursor-ide", modelId: "composer-2.5" }]);
	store.upsertProject("botbox", "/tmp/myrepo", "w-lead");
	setHerdr(async args => {
		if (args[0] === "agent" && args[1] === "list") {
			return {
				agents: [
					{ name: "self", pane_id: "own:p1", workspace_id: "w-lead", agent: "pi", agent_status: "idle", agent_session: { kind: "path", value: sess } },
					{ name: "feat1", pane_id: "wt:p1", workspace_id: "w-wt", agent: "pi", agent_status: "working", agent_session: { kind: "path", value: sess } },
					{ name: "other", pane_id: "x:p1", workspace_id: "w-other", agent: "claude", agent_status: "idle" },
				],
			};
		}
		if (args[0] === "workspace" && args[1] === "list") {
			return {
				workspaces: [
					{ workspace_id: "w-lead", label: "botbox" },
					{
						workspace_id: "w-wt",
						label: "feat1",
						worktree: { checkout_path: `${process.env.HOME}/.herdr/worktrees/myrepo/feat1` },
					},
					{ workspace_id: "w-other", label: "other" },
				],
			};
		}
		return {};
	});
	const chief = await agentsOverviewText({ role: "chief" }, "own:p1", undefined, store);
	assert.match(chief, /feat1 \/ feat1 · working · cursor-ide\/composer-2\.5/);
	assert.match(chief, /other \/ other · idle · claude/);
	assert.doesNotMatch(chief, /own:p1/);
	const lead = await agentsOverviewText({ role: "lead", project: "botbox" }, "own:p1", undefined, store);
	assert.match(lead, /feat1 · working/);
	assert.doesNotMatch(lead, /other \/ other/);
});

test("resume_agent quits pi then starts session on picked model", async () => {
	writeQuota("cursor", { fetchedAt: now, live: true, state: "down" });
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 80, weeklyLeft: 80 });
	const sess = sessionFile("resume", [
		{ type: "message", message: { role: "assistant", provider: "cursor-ide", model: "composer-2.5", stopReason: "error", errorMessage: "usage limit" } },
	]);
	const calls: string[][] = [];
	let quit = 0;
	setResumeDeps({
		quitPi: async () => { quit++; },
		waitPiStopped: async () => {},
	});
	setHerdr(async args => {
		calls.push(args);
		if (args[0] === "agent" && args[1] === "get") {
			return {
				agent: {
					name: "worker1",
					pane_id: "w1:p1",
					workspace_id: "w1",
					agent: "pi",
					agent_status: "done",
					agent_session: { kind: "path", value: sess },
				},
			};
		}
		return {};
	});
	const msg = await resumeAgent(store, { target: "worker1" });
	assert.equal(quit, 1);
	assert.match(msg, /Resumed worker1 on minimax\/MiniMax-M3\.1-Flash:high/);
	const start = calls.find(c => c[0] === "agent" && c[1] === "start");
	assert.ok(start?.includes("--session"));
	assert.ok(start?.includes(sess));
	assert.ok(start?.includes("minimax/MiniMax-M3.1-Flash:high"));
	assert.ok(calls.some(c => c[0] === "agent" && c[1] === "prompt"));
});

test("watcher usage limit resumes on next model and keeps watch", async () => {
	writeQuota("cursor", { fetchedAt: now, live: true, state: "running" });
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 80, weeklyLeft: 80 });
	const sess = sessionFile("watch-resume", [
		{ type: "message", message: { role: "assistant", provider: "cursor-ide", model: "composer-2.5", stopReason: "error", errorMessage: "rate limit" } },
	]);
	setResumeDeps({ quitPi: async () => {}, waitPiStopped: async () => {} });
	const calls: string[][] = [];
	setHerdr(async args => {
		calls.push(args);
		if (args[0] === "agent" && args[1] === "get") {
			return { agent: { ...piAgent({ agent_session: { kind: "path", value: sess } }), agent_status: "done" } };
		}
		return {};
	});
	store.addWatch({ target: "worker1", label: "job", via: "local", owner: "chief", createdAt: now - 120_000 });
	store.setWatchSawWorking(store.activeWatches()[0].id);
	const fired: string[] = [];
	await tickWatch(store, store.activeWatches()[0], m => fired.push(m));
	assert.match(fired[0], /hit the usage limit on cursor-ide\/composer-2\.5; resumed on minimax/);
	assert.equal(store.activeWatches().length, 1);
	assert.ok(calls.some(c => c[0] === "agent" && c[1] === "start"));
});

test("watcher all models out sets resume_at and resumes after refill", async () => {
	const refillAt = now + 3_600_000;
	writeQuota("cursor", { fetchedAt: now, live: true, state: "down", primaryResetsAt: refillAt + 86_400_000 });
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 2, weeklyLeft: 2, currentResetsAt: refillAt });
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 2, weeklyLeft: 2, primaryResetsAt: refillAt + 7_200_000 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 2, weeklyLeft: 2, primaryResetsAt: refillAt + 7_200_000 });
	const sess = sessionFile("watch-pause", [
		{ type: "message", message: { role: "assistant", provider: "cursor-ide", model: "composer-2.5", stopReason: "error", errorMessage: "quota exceeded" } },
	]);
	setResumeDeps({ quitPi: async () => {}, waitPiStopped: async () => {} });
	setHerdr(async args => {
		if (args[0] === "agent" && args[1] === "get") {
			return { agent: piAgent({ name: "w2", pane_id: "w2:p1", agent_session: { kind: "path", value: sess } }) };
		}
		return {};
	});
	store.addWatch({ target: "w2", label: "pause-job", via: "local", owner: "chief", createdAt: now - 120_000 });
	store.setWatchSawWorking(store.activeWatches()[0].id);
	const fired: string[] = [];
	await tickWatch(store, store.activeWatches()[0], m => fired.push(m));
	assert.match(fired[0], /paused: all worker models out until/);
	const w = store.activeWatches()[0];
	assert.equal(w.resumeAt, refillAt);
	await tickWatch(store, w, m => fired.push(m));
	assert.equal(fired.length, 1, "pause note is sent once");
	now = refillAt + 1;
	writeQuota("minimax", { fetchedAt: now, live: true, currentLeft: 80, weeklyLeft: 80 });
	await tickWatch(store, store.activeWatches()[0], m => fired.push(m));
	assert.equal(store.activeWatches().length, 1);
});

test("watcher normal finish still finishes watch", async () => {
	const sess = sessionFile("ok", [{ type: "message", message: { role: "assistant", provider: "cursor-ide", model: "composer-2.5", stopReason: "stop" } }]);
	setHerdr(async () => ({
		agent: piAgent({ agent_session: { kind: "path", value: sess } }),
	}));
	store.addWatch({ target: "worker1", label: "job", via: "local", owner: "chief", createdAt: now - 120_000 });
	store.setWatchSawWorking(store.activeWatches()[0].id);
	const fired: string[] = [];
	await tickWatch(store, store.activeWatches()[0], m => fired.push(m));
	assert.match(fired[0], /is now done/);
	assert.equal(store.activeWatches().length, 0);
});

test("session context size uses the largest recent usage, not a usage-less limit error", () => {
	const path = sessionFile("ctx", [
		{ type: "message", message: { role: "assistant", usage: { input: 2000, cacheRead: 180000, output: 500 } } },
		{ type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "usage limit" } },
	]);
	assert.equal(sessionContextTokens(path), 182500);
});

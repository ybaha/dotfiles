import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	armQuotaWake,
	armWaitForModel,
	tickQuotaWake,
	wakeAtKey,
	wakeTaskKey,
	parseModelChain,
	setModelsDeps,
	QUOTA_WAKE_RECHECK_MS,
	type ModelsDeps,
} from "../models.ts";
import { Store } from "../store.ts";

let cacheDir: string;
let now: number;
let store: Store;
let deps: ModelsDeps;

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "chief-wake-"));
	process.env.PI_CHIEF_DATA_DIR = join(root, "data");
	cacheDir = mkdtempSync(join(tmpdir(), "chief-wake-quota-"));
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
});

function writeQuota(name: string, body: object): void {
	writeFileSync(join(cacheDir, `${name}.json`), JSON.stringify(body));
}

const chain = parseModelChain("openai-codex/gpt-6.1-sol:high, claude-bridge/claude-opus-5-5:high");
const recipient = "chief";

async function tickFollowUp(sent: string[]): Promise<void> {
	await tickQuotaWake(recipient, chain, m => sent.push(m), deps);
}

test("armed but not due sends no wake message", async () => {
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_050_000 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_200_000 });
	armQuotaWake(recipient, chain, "fix the bug", "usage limit", deps);
	const wakeAt = Number(store.get(wakeAtKey(recipient)));
	assert.ok(wakeAt > now);
	now = wakeAt - 1;
	const sent: string[] = [];
	await tickFollowUp(sent);
	assert.equal(sent.length, 0);
	assert.ok(store.get(wakeAtKey(recipient)));
});

test("due with provider available sends once and clears timer", async () => {
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_050_000 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_200_000 });
	armQuotaWake(recipient, chain, "fix the bug", "usage limit", deps);
	const wakeAt = Number(store.get(wakeAtKey(recipient)));
	now = wakeAt;
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 80, weeklyLeft: 80 });
	const sent: string[] = [];
	await tickFollowUp(sent);
	await tickFollowUp(sent);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!, /quota is back \(openai-codex\/gpt-6\.1-sol:high\)/);
	assert.match(sent[0]!, /fix the bug/);
	assert.equal(store.get(wakeAtKey(recipient)), undefined);
});

test("due but still unavailable re-arms without message", async () => {
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_050_000 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_200_000 });
	armQuotaWake(recipient, chain, "task", "limit", deps);
	const wakeAt = Number(store.get(wakeAtKey(recipient)));
	now = wakeAt;
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_050_000 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_200_000 });
	const sent: string[] = [];
	await tickFollowUp(sent);
	assert.equal(sent.length, 0);
	const next = Number(store.get(wakeAtKey(recipient)));
	assert.ok(next >= wakeAt);
	assert.equal(store.get(wakeTaskKey(recipient)), "task");
});

test("survives new Store instance (restart)", async () => {
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_050_000 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_200_000 });
	armQuotaWake(recipient, chain, "resume work", "limit", deps);
	const wakeAt = Number(store.get(wakeAtKey(recipient)));
	store.close();
	store = new Store();
	deps = { ...deps, getKv: key => store.get(key), setKv: (k, v) => store.set(k, v), deleteKv: k => store.remove(k) };
	setModelsDeps(deps);
	now = wakeAt;
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 80, weeklyLeft: 80 });
	const sent: string[] = [];
	await tickFollowUp(sent);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!, /resume work/);
});

test("wait line mentions refill time and provider", () => {
	writeQuota("codex", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_050_000 });
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 3, weeklyLeft: 30, primaryResetsAt: 1_700_200_000 });
	const { waitLine, shouldNotify } = armQuotaWake(recipient, chain, "task", "limit", deps);
	assert.ok(shouldNotify);
	assert.match(waitLine, /Out of quota until \d{2}:\d{2}/);
	assert.match(waitLine, /when Codex refills/);
	assert.equal(armQuotaWake(recipient, chain, "task", "limit", deps).shouldNotify, false);
});


test("a wake whose provider is still empty rechecks soon instead of waiting for a far reset", async () => {
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 0, weeklyLeft: 69, primaryResetsAt: now / 1000 + 7 * 86400 });
	armWaitForModel("chief", "claude-bridge/claude-opus-5-5", "task", "life-hq", deps);
	now += QUOTA_WAKE_RECHECK_MS + 1000;
	store.set(wakeAtKey("chief"), String(now - 1000)); // the wake is due now
	let fired = 0;
	await tickQuotaWake("chief", parseModelChain("claude-bridge/claude-opus-5-5"), { followUp: () => { fired++; }, resumeAgent: async () => { fired++; } }, deps);
	assert.equal(fired, 0, "still no quota, so nothing resumes");
	const wakeAt = Number(store.get(wakeAtKey("chief")));
	assert.ok(wakeAt - now <= QUOTA_WAKE_RECHECK_MS + 1000, `re-check scheduled soon, got ${wakeAt - now}ms`);

	// Quota comes back: the next tick resumes the work.
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 100, weeklyLeft: 69 });
	now += QUOTA_WAKE_RECHECK_MS + 1000;
	await tickQuotaWake("chief", parseModelChain("claude-bridge/claude-opus-5-5"), { followUp: () => { fired++; }, resumeAgent: async () => { fired++; } }, deps);
	assert.equal(fired, 1, "the task resumes once quota returns");
});

test("a wait for a model that already has quota wakes immediately", () => {
	writeQuota("claude", { fetchedAt: now, live: true, primaryLeft: 100, weeklyLeft: 69 });
	const armed = armWaitForModel("chief", "claude-bridge/claude-opus-5-5", "task", "life-hq", deps);
	assert.ok(armed.wakeAt <= now + 1000, `wakes now, got ${armed.wakeAt - now}ms`);
	assert.match(armed.waitLine, /now/);
});

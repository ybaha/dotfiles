import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

import { resolvePiRoot } from "./pi-test-runtime.mjs";

const piRoot = resolvePiRoot();
const requireFromPi = createRequire(join(piRoot, "package.json"));
const loadModule = requireFromPi("jiti")(import.meta.url, {
	moduleCache: false,
	alias: { "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js") },
});
const extPath = join(here, "../files/home/.pi/agent/extensions/worktree-lead.ts");
const {
	default: installWorktreeLead,
	parseLogLine,
	lineTimeMs,
	latestRelevant,
	decideNotify,
	isLeadFor,
	formatMessage,
	footerText,
	writeNotifiedAtomic,
} = await loadModule.import(extPath);

const { default: installWatcherStatus } = await loadModule.import(join(here, "../files/home/.pi/agent/extensions/worktree-watcher-status.ts"));

test("legacy watcher status is excluded and inert without the old runtime", () => {
	const settings = JSON.parse(readFileSync(join(here, "../files/home/.pi/agent/settings.json"), "utf8"));
	assert.ok(settings.extensions.includes("-extensions/worktree-watcher-status.ts"));
	const saved = Object.fromEntries(["HC_TERMINAL_ID", "HERDR_ENV", "PATH"].map(key => [key, process.env[key]]));
	const dir = mkdtempSync(join(tmpdir(), "watcher-disabled-"));
	const pi = new Proxy({}, { get: () => assert.fail("disabled watcher must not register handlers or start polling") });
	try {
		process.env.PATH = dir;
		process.env.HERDR_ENV = "1";
		delete process.env.HC_TERMINAL_ID;
		installWatcherStatus(pi); // Missing herdr executable, even with stale legacy env.
		const executable = join(dir, "herdr");
		writeFileSync(executable, "#!/bin/sh\nexit 99\n");
		chmodSync(executable, 0o700);
		delete process.env.HERDR_ENV;
		installWatcherStatus(pi); // Missing legacy env, even with an installed executable.
		process.env.HERDR_ENV = "1";
		process.env.HC_TERMINAL_ID = "t7";
		installWatcherStatus(pi); // hc wins over inherited legacy env/executable.
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hc and non-Herdr startup are inert, even with old watcher state", () => {
	const saved = { HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HERDR_ENV: process.env.HERDR_ENV };
	try {
		for (const hc of ["t7", undefined]) {
			if (hc) process.env.HC_TERMINAL_ID = hc; else delete process.env.HC_TERMINAL_ID;
			if (hc) process.env.HERDR_ENV = "1"; else delete process.env.HERDR_ENV;
			installWorktreeLead(new Proxy({}, { get: () => assert.fail("must register nothing") }));
		}
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
});

function fixedNow(h, mi, s) {
	const d = new Date(2026, 10, 11, h, mi, s, 0);
	return d.getTime();
}

const slug = "ui-harmony";
const L = (t, body) => `[${t}] ${slug}: ${body}`;

const stateLead = {
	slug: "ui-harmony",
	logFile: "/tmp/x.log",
	worktreePath: "/wt/ui-harmony",
	base: "main",
	lead: { paneId: "pane-1", cwd: "/lead/cwd" },
};

test("parseLogLine kinds", () => {
	assert.deepEqual(parseLogLine(L("16:32:56", "status=working agent=pi")), { time: "16:32:56", kind: "status", status: "working" });
	assert.equal(parseLogLine(L("16:33:00", "BLOCKED — needs user input"))?.kind, "blocked");
	assert.equal(parseLogLine(L("16:33:01", "pane exited"))?.kind, "exited");
	assert.equal(parseLogLine(L("16:33:02", "subscribed pane=1"))?.kind, "other");
});

test("decideNotify hold and blip", () => {
	const now = fixedNow(16, 40, 0);
	const workingFirst = L("16:38:00", "status=working agent=pi");
	const doneLine = L("16:39:00", "status=done agent=pi");
	const workingBlip = L("16:39:20", "status=working agent=pi");
	const afterStart = [workingFirst, doneLine];
	assert.equal(decideNotify({ lines: afterStart, nowMs: fixedNow(16, 39, 25), holdMs: 30_000 }).notify, false);
	const held = decideNotify({ lines: afterStart, nowMs: now, holdMs: 30_000 });
	assert.equal(held.notify, true);
	assert.equal(held.kind, "done");
	assert.equal(decideNotify({ lines: afterStart, notified: doneLine, nowMs: now }).notify, false);
	const blip = [workingFirst, doneLine, workingBlip];
	assert.equal(decideNotify({ lines: blip, nowMs: now + 60_000 }).notify, false);
});

test("formatMessage and footerText", () => {
	const now = fixedNow(12, 28, 0);
	const working = L("12:16:00", "status=working agent=pi");
	const done = L("16:13:00", "status=done agent=pi");
	const blockedLine = L("10:00:00", "BLOCKED — q");
	const msg = formatMessage(stateLead, { kind: "done", time: "16:13:00" });
	assert.match(msg, /herdr agent read ui-harmony/);
	assert.match(msg, /git -C \/wt\/ui-harmony log --oneline main\.\.HEAD/);
	assert.match(msg, /diff main\.\.\.HEAD/);
	assert.match(formatMessage(stateLead, { kind: "blocked", time: "10:00" }), /needs input/);
	assert.match(formatMessage(stateLead, { kind: "exited", time: "09:00" }), /exited unexpectedly/);
	assert.match(footerText("ui-harmony", [working], now), /Working · 12m/);
	assert.match(footerText("follower-fix", [done], now), /Done · 16:13:00/);
	assert.equal(footerText("x", [], now), "x · Starting");
	assert.match(footerText("x", [blockedLine], now), /Needs input/);
});

test("isLeadFor", () => {
	const noLead = { slug: "a", logFile: "/l" };
	assert.equal(isLeadFor(noLead, { cwd: "/lead/cwd" }), false);
	assert.equal(isLeadFor(stateLead, { paneId: "pane-1" }), true);
	assert.equal(isLeadFor(stateLead, { paneId: "other" }), false);
	assert.equal(isLeadFor(stateLead, { cwd: "/lead/cwd" }), true);
	assert.equal(isLeadFor(stateLead, { cwd: "/else" }), false);
});

test("lineTimeMs midnight wrap", () => {
	const now = fixedNow(0, 5, 0);
	const t = lineTimeMs("23:59:00", now);
	assert.ok(t < now);
	assert.ok(now - t < 10 * 60_000);
});

test("writeNotifiedAtomic", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-lead-"));
	const file = join(dir, "w.json");
	writeFileSync(file, JSON.stringify({ slug: "s", logFile: "/l", extra: 1 }));
	writeNotifiedAtomic(file, { slug: "s", logFile: "/l" }, "line-a");
	const j = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(j.notified, "line-a");
	assert.equal(j.extra, 1);
	rmSync(dir, { recursive: true });
});

test("latestRelevant skips other", () => {
	const lines = [L("12:00:00", "subscribed pane=x"), L("12:01:00", "status=idle agent=pi")];
	assert.equal(latestRelevant(lines)?.parsed.status, "idle");
});

test("decideNotify idle/done require prior working", () => {
	const subscribe = L("11:40:02", "subscribed pane=w1X:p1 label=home-analyzer");
	const preIdle = L("11:40:02", "status=idle agent=pi");
	const preStart = decideNotify({
		lines: [subscribe, preIdle],
		nowMs: fixedNow(11, 42, 2),
		holdMs: 30_000,
	});
	assert.equal(preStart.notify, false);

	const idle1 = L("11:40:02", "status=idle agent=pi");
	const working = L("11:40:58", "status=working agent=pi");
	const idle2 = L("11:41:58", "status=idle agent=pi");
	const finished = decideNotify({
		lines: [idle1, working, idle2],
		nowMs: fixedNow(11, 42, 58),
		holdMs: 30_000,
	});
	assert.equal(finished.notify, true);
	assert.equal(finished.kind, "idle");

	const blockedLine = L("11:40:05", "BLOCKED — needs user input");
	const blockedEarly = decideNotify({
		lines: [subscribe, blockedLine],
		nowMs: fixedNow(11, 41, 10),
		holdMs: 30_000,
	});
	assert.equal(blockedEarly.notify, true);
	assert.equal(blockedEarly.kind, "blocked");

	const doneLine = L("11:40:20", "status=done agent=pi");
	const workingBeforeDone = L("11:40:00", "status=working agent=pi");
	assert.equal(
		decideNotify({ lines: [workingBeforeDone, doneLine], nowMs: fixedNow(11, 40, 25), holdMs: 30_000 }).notify,
		false,
	);
});

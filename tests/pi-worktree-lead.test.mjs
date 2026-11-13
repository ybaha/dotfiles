import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

function resolvePiRoot() {
	const localRequire = createRequire(import.meta.url);
	const candidates = [];
	try {
		candidates.push(dirname(localRequire.resolve("@earendil-works/pi-coding-agent/package.json")));
	} catch {}
	try {
		candidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).trim(), "@earendil-works/pi-coding-agent"));
	} catch {}
	const miseNode = join(process.env.HOME ?? "", ".local/share/mise/installs/node");
	if (existsSync(miseNode)) {
		for (const ver of readdirSync(miseNode)) {
			candidates.push(join(miseNode, ver, "lib/node_modules/@earendil-works/pi-coding-agent"));
		}
	}
	const seen = new Set();
	for (const root of candidates) {
		if (!root || seen.has(root)) continue;
		seen.add(root);
		try {
			createRequire(join(root, "package.json"))("jiti");
			return root;
		} catch {}
	}
	throw new Error("pi-coding-agent with jiti not found");
}

const piRoot = resolvePiRoot();
const requireFromPi = createRequire(join(piRoot, "package.json"));
const loadModule = requireFromPi("jiti")(import.meta.url, {
	moduleCache: false,
	alias: { "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js") },
});
const extPath = join(here, "../files/home/.pi/agent/extensions/worktree-lead.ts");
const {
	parseLogLine,
	lineTimeMs,
	latestRelevant,
	decideNotify,
	isLeadFor,
	formatMessage,
	footerText,
	writeNotifiedAtomic,
} = await loadModule.import(extPath);

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

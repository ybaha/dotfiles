/** Lead session supervises worktree workers (state in ~/.pi/agent/state/worktree-watchers). */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const STATE_DIR = join(process.env.HOME ?? "~", ".pi/agent/state/worktree-watchers");
const POLL_MS = 2000, RESCAN_MS = 15_000, TAIL_BYTES = 16_384, MAX_STATUS_LEN = 72;

export type ParsedLine =
	| { time: string; kind: "status"; status: string }
	| { time: string; kind: "blocked" | "exited" | "other" };
export type WatcherState = {
	slug: string; logFile: string; worktreePath?: string; base?: string; notified?: string;
	lead?: { paneId?: string; cwd: string };
};
type NotifyKind = "done" | "idle" | "blocked" | "exited";

const intervals = new Map<string, ReturnType<typeof setInterval>>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let ui: { setStatus(k: string, t: string | undefined): void; notify?(t: string, l: string): void } | undefined;
let sessionCwd: string | undefined, sessionPaneId: string | undefined;
const memNotified = new Map<string, string>();

const canon = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const compact = (t: string) => (t.length <= MAX_STATUS_LEN ? t : t.slice(0, MAX_STATUS_LEN - 1) + "…");

export function parseLogLine(line: string): ParsedLine | null {
	const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+[^:]+:\s+(.*)$/);
	if (!m) return null;
	const [, time, body] = m;
	if (body.includes("pane exited")) return { time, kind: "exited" };
	if (body.includes("BLOCKED")) return { time, kind: "blocked" };
	const status = body.match(/^status=(\w+)/)?.[1];
	return status ? { time, kind: "status", status } : { time, kind: "other" };
}

export function lineTimeMs(time: string, nowMs: number): number {
	const [h, mi, s] = time.split(":").map(Number);
	const d = new Date(nowMs);
	d.setHours(h, mi, s, 0);
	let ms = d.getTime();
	return ms > nowMs + 60_000 ? ms - 86_400_000 : ms;
}

export function latestRelevant(lines: string[]) {
	let last: { line: string; parsed: ParsedLine } | null = null;
	for (const line of lines) {
		const parsed = parseLogLine(line);
		if (parsed && parsed.kind !== "other") last = { line, parsed };
	}
	return last;
}

export function decideNotify(opts: { lines: string[]; notified?: string; nowMs: number; holdMs?: number }) {
	const hold = opts.holdMs ?? 30_000;
	const latest = latestRelevant(opts.lines);
	if (!latest) return { notify: false as const };
	const { line, parsed } = latest;
	let kind: NotifyKind | null = null;
	if (parsed.kind === "status") {
		if (parsed.status === "working") return { notify: false as const };
		if (parsed.status === "done" || parsed.status === "idle" || parsed.status === "blocked") kind = parsed.status;
		else return { notify: false as const };
	} else if (parsed.kind === "blocked" || parsed.kind === "exited") kind = parsed.kind;
	else return { notify: false as const };
	if (kind === "idle" || kind === "done") {
		let latestIdx = -1;
		for (let i = 0; i < opts.lines.length; i++) {
			const p = parseLogLine(opts.lines[i]);
			if (p && p.kind !== "other") latestIdx = i;
		}
		let sawWorking = false;
		for (let i = 0; i < latestIdx; i++) {
			const p = parseLogLine(opts.lines[i]);
			if (p?.kind === "status" && p.status === "working") {
				sawWorking = true;
				break;
			}
		}
		if (!sawWorking) return { notify: false as const };
	}
	if (opts.nowMs - lineTimeMs(parsed.time, opts.nowMs) < hold || line === opts.notified) return { notify: false as const };
	return { notify: true as const, line, kind, time: parsed.time };
}

export function isLeadFor(state: WatcherState, opts: { paneId?: string; cwd?: string }) {
	if (!state.lead) return false;
	if (opts.paneId !== undefined) return state.lead.paneId === opts.paneId;
	return opts.cwd ? canon(state.lead.cwd) === canon(opts.cwd) : false;
}

export function formatMessage(state: WatcherState, d: { kind: NotifyKind; time: string }) {
	const base = state.base ?? "master", path = state.worktreePath ?? "?", slug = state.slug;
	if (d.kind === "blocked") return `Worktree worker ${slug} needs input (blocked at ${d.time}). Read: herdr agent read ${slug} · Answer with: ~/.pi/agent/skills/lead/scripts/prompt.sh ${slug} --text "<answer>"`;
	if (d.kind === "exited") return `Worktree worker ${slug} pane exited unexpectedly (at ${d.time}). Check: herdr agent list; git -C ${path} log --oneline ${base}..HEAD`;
	return `Worktree worker ${slug} finished (${d.kind} at ${d.time}). Read its report: herdr agent read ${slug} · Review: git -C ${path} log --oneline ${base}..HEAD; git -C ${path} diff ${base}...HEAD`;
}

function ageFmt(sec: number) {
	return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h`;
}

export function footerText(slug: string, lines: string[], nowMs: number) {
	const latest = latestRelevant(lines);
	if (!latest) return `${slug} · Starting`;
	const p = latest.parsed;
	if (p.kind === "status" && p.status === "working") {
		const sec = Math.max(0, Math.floor((nowMs - lineTimeMs(p.time, nowMs)) / 1000));
		return compact(`${slug} · Working · ${ageFmt(sec)}`);
	}
	const lab: Record<string, string> = { done: "Done", idle: "Idle", blocked: "Needs input" };
	if (p.kind === "status") return compact(`${slug} · ${lab[p.status] ?? p.status} · ${p.time}`);
	if (p.kind === "blocked") return compact(`${slug} · Needs input · ${p.time}`);
	if (p.kind === "exited") return compact(`${slug} · Exited · ${p.time}`);
	return compact(`${slug} · Starting`);
}

export function writeNotifiedAtomic(stateFile: string, state: WatcherState, line: string) {
	let merged: WatcherState;
	try {
		merged = existsSync(stateFile)
			? { ...JSON.parse(readFileSync(stateFile, "utf-8")), notified: line }
			: { ...state, notified: line };
	} catch { merged = { ...state, notified: line }; }
	mkdirSync(join(stateFile, ".."), { recursive: true });
	const tmp = `${stateFile}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(merged, null, 2));
	renameSync(tmp, stateFile);
}

function tailLines(path: string) {
	try {
		const st = statSync(path);
		if (!st.size) return [] as string[];
		const start = Math.max(0, st.size - TAIL_BYTES);
		const fd = openSync(path, "r");
		const buf = Buffer.alloc(Math.min(TAIL_BYTES, st.size));
		readSync(fd, buf, 0, buf.length, start);
		closeSync(fd);
		return buf.toString("utf-8").split("\n").filter((l) => l.trim());
	} catch { return [] as string[]; }
}

function gitMetric(path: string, base: string, cmd: "ahead" | "dirty") {
	try {
		if (cmd === "ahead") return execFileSync("git", ["-C", path, "rev-list", "--count", `${base}..HEAD`], { encoding: "utf-8", timeout: 5000 }).trim();
		return String(execFileSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf-8", timeout: 5000 }).split("\n").filter((l) => l.trim() && !l.slice(3).startsWith(".herdr-")).length);
	} catch { return "?"; }
}

function loadLeadWorkers(): WatcherState[] {
	try {
		if (!existsSync(STATE_DIR)) return [];
		const opts = { paneId: sessionPaneId, cwd: sessionCwd };
		return readdirSync(STATE_DIR).filter((f) => f.endsWith(".json")).map((f) => {
			try { return JSON.parse(readFileSync(join(STATE_DIR, f), "utf-8")) as WatcherState; } catch { return null; }
		}).filter((w): w is WatcherState => w !== null && !!w.lead && !!w.logFile && isLeadFor(w, opts));
	} catch { return []; }
}

export default function (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) {
	// hc owns status; stale watcher files must not trigger turns or close old panes.
	if (process.env.HC_TERMINAL_ID || process.env.HERDR_ENV !== "1") return;
	const workerBySlug = (slug: string) => loadLeadWorkers().find((x) => x.slug === slug);
	function poll(w: WatcherState) {
		const fresh = workerBySlug(w.slug) ?? w;
		const lines = tailLines(fresh.logFile);
		const now = Date.now();
		ui?.setStatus(`lead-${fresh.slug}`, footerText(fresh.slug, lines, now));
		const decision = decideNotify({ lines, notified: fresh.notified, nowMs: now });
		if (!decision.notify || memNotified.get(fresh.slug) === decision.line) return;
		const stateFile = join(STATE_DIR, `${fresh.slug}.json`);
		try {
			const onDisk = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf-8")) as WatcherState : fresh;
			if (onDisk.notified === decision.line) { memNotified.set(fresh.slug, decision.line); return; }
			writeNotifiedAtomic(stateFile, onDisk, decision.line);
		} catch { return; }
		memNotified.set(fresh.slug, decision.line);
		pi.sendMessage({ customType: "worktree-lead", display: true, content: formatMessage(fresh, decision) }, { triggerTurn: true, deliverAs: "followUp" });
	}
	function refresh() {
		const workers = loadLeadWorkers(), seen = new Set<string>();
		for (const w of workers) {
			seen.add(w.slug);
			if (!intervals.has(w.slug)) { poll(w); intervals.set(w.slug, setInterval(() => poll(workerBySlug(w.slug) ?? w), POLL_MS)); }
			else poll(w);
		}
		for (const [slug, h] of intervals) {
			if (!seen.has(slug)) { clearInterval(h); intervals.delete(slug); ui?.setStatus(`lead-${slug}`, undefined); memNotified.delete(slug); }
		}
	}
	pi.on("session_start", (_e, ctx) => {
		if (!ctx.ui?.setStatus || !ctx.cwd) return;
		ui = ctx.ui; sessionCwd = ctx.cwd; sessionPaneId = process.env.HERDR_PANE_ID;
		refresh();
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(refresh, RESCAN_MS);
	});
	pi.on("session_shutdown", () => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		for (const h of intervals.values()) clearInterval(h);
		intervals.clear(); memNotified.clear();
		sessionCwd = sessionPaneId = ui = undefined;
	});
	pi.registerCommand("workers", {
		description: "List or close worktree workers for this lead",
		handler: async (args, ctx) => {
			const p = args.trim().split(/\s+/).filter(Boolean);
			if (p[0] === "close") {
				if (!p[1]) { ctx.ui.notify?.("Usage: /workers close <slug> [--force]", "warning"); return; }
				const script = join(process.env.HOME ?? "~", ".pi/agent/skills/lead/scripts/close.sh");
				try {
					const out = execFileSync("bash", [script, p[1], ...(p.includes("--force") ? ["--force"] : [])], { encoding: "utf-8", timeout: 60_000 });
					ctx.ui.notify?.(out.trim() || `Closed ${p[1]}`, "info");
				} catch (e) { ctx.ui.notify?.(e instanceof Error ? e.message : String(e), "error"); }
				return;
			}
			const now = Date.now(), rows = ["slug\tstate\tage\tahead\tdirty"];
			for (const w of loadLeadWorkers()) {
				const lines = tailLines(w.logFile), footer = footerText(w.slug, lines, now);
				const st = footer.split(" · ")[1] ?? "?";
				const lat = latestRelevant(lines);
				const age = lat ? ageFmt(Math.max(0, Math.floor((now - lineTimeMs(lat.parsed.time, now)) / 1000))) : "-";
				const base = w.base ?? "master", path = w.worktreePath ?? "";
				rows.push(`${w.slug}\t${st}\t${age}\t${path ? gitMetric(path, base, "ahead") : "?"}\t${path ? gitMetric(path, base, "dirty") : "?"}`);
			}
			ctx.ui.notify?.(rows.join("\n"), "info");
		},
	});
}

/**
 * Watcher status — polls worktree watcher logs and shows the last event in the
 * pi footer via setStatus. Pairs with the `worktree` skill, which writes a
 * JSON marker to ~/.pi/agent/state/worktree-watchers/<slug>.json when it spawns
 * a background watcher.
 *
 * Footer shows a human-readable entry only in the matching worktree session, e.g.:
 *   social-slides · Working · 21:45:09
 *
 * Stops polling when the session ends.
 */

import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const STATE_DIR = join(process.env.HOME ?? "~", ".pi/agent/state/worktree-watchers");
const POLL_MS = 2000;
const MAX_STATUS_LEN = 60;

type Watcher = {
	slug: string;
	logFile: string;
	paneId: string;
	agentLabel: string;
	worktreePath?: string;
};

const intervals = new Map<string, ReturnType<typeof setInterval>>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let ui: { setStatus(key: string, text: string | undefined): void } | undefined;
let sessionCwd: string | undefined;

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isRelated(watcher: Watcher): boolean {
	if (!sessionCwd) return false;
	const worktreePath = watcher.worktreePath ?? dirname(watcher.logFile);
	return canonicalPath(worktreePath) === canonicalPath(sessionCwd);
}

function loadWatchers(): Watcher[] {
	try {
		if (!existsSync(STATE_DIR)) return [];
		return readdirSync(STATE_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					return JSON.parse(readFileSync(join(STATE_DIR, f), "utf-8")) as Watcher;
				} catch {
					return null;
				}
			})
			.filter((w): w is Watcher => w !== null && Boolean(w.logFile) && isRelated(w));
	} catch {
		return [];
	}
}

function tailLastLine(path: string): string | null {
	try {
		const st = statSync(path);
		if (!st.size) return null;
		// Tail ~4KB to find the last line without reading the whole log.
		const BUF = 4096;
		const fd = openSync(path, "r");
		const start = Math.max(0, st.size - BUF);
		const buf = Buffer.alloc(Math.min(BUF, st.size));
		readSync(fd, buf, 0, buf.length, start);
		closeSync(fd);
		const text = buf.toString("utf-8");
		const lines = text.split("\n").filter((l) => l.trim());
		return lines.at(-1) ?? null;
	} catch {
		return null;
	}
}

function compact(text: string): string {
	if (text.length <= MAX_STATUS_LEN) return text;
	return text.slice(0, MAX_STATUS_LEN - 1) + "…";
}

function humanStatus(slug: string, line: string): string {
	const event = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+[^:]+:\s+(.*)$/);
	if (!event) return compact(`${slug} · ${line}`);

	const [, time, body] = event;
	const status = body.match(/^status=([a-z_]+)/)?.[1];
	const labels: Record<string, string> = {
		working: "Working",
		idle: "Idle",
		done: "Done",
		blocked: "Needs input",
	};
	const state = status ? labels[status] ?? status : body.includes("BLOCKED") ? "Needs input" : body;
	return compact(`${slug} · ${state} · ${time}`);
}

export default function (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) {
	function poll(slug: string, watcher: Watcher) {
		const last = tailLastLine(watcher.logFile);
		if (!last) {
			ui?.setStatus(`wt-${slug}`, `${slug} · Waiting for updates`);
			return;
		}
		ui?.setStatus(`wt-${slug}`, humanStatus(slug, last));
	}

	function refresh() {
		const watchers = loadWatchers();
		const seen = new Set<string>();

		for (const w of watchers) {
			seen.add(w.slug);
			if (intervals.has(w.slug)) {
				poll(w.slug, w); // refresh now too
				continue;
			}
			poll(w.slug, w);
			intervals.set(w.slug, setInterval(() => poll(w.slug, w), POLL_MS));
		}

		// Clear watchers that were removed from state.
		for (const [slug, handle] of intervals) {
			if (!seen.has(slug)) {
				clearInterval(handle);
				intervals.delete(slug);
				ui?.setStatus(`wt-${slug}`, undefined); // remove from footer
			}
		}
	}

	pi.on("session_start", (_event, sessionCtx) => {
		if (sessionCtx.mode !== "tui") return;
		ui = sessionCtx.ui;
		sessionCwd = sessionCtx.cwd;
		refresh();
		// Also re-scan every 30s in case new worktrees spawn mid-session.
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(refresh, 30_000);
	});

	pi.on("session_shutdown", () => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		for (const handle of intervals.values()) clearInterval(handle);
		intervals.clear();
		sessionCwd = undefined;
		ui = undefined;
	});
}

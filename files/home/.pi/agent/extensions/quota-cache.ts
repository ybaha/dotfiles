/**
 * quota-cache — single-writer quota cache with per-provider TTLs.
 *
 * Owns all rate-limit budgets for Claude, Codex, MiniMax, and the Cursor IDE
 * launchd service. Each provider writes its last good reading to
 * ~/.cache/pi-orchestra/quota/<provider>.json on its own timer plus jitter.
 * The pi footer reads those files; it never blocks on a network call.
 *
 * - Stale threshold: 2 × TTL. Past it, the footer renders a `stale` warning.
 * - agent_settled only nudges a refresh when the cache is older than ½ TTL.
 * - Coalescing: a refresh-in-flight guard prevents duplicate concurrent calls.
 * - Persists across sessions; survives Pi restarts. Idempotent on shutdown.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CACHE_DIR = join(homedir(), ".cache", "pi-orchestra", "quota");
const SCRIPT = join(homedir(), ".pi", "agent", "extensions", "quota-fetch.py");

type Provider = "claude" | "codex" | "minimax" | "cursor";

type Snapshot = {
	fetchedAt: number;
	live: boolean;
	[extra: string]: unknown;
};

type Slots = Partial<Record<Provider, Snapshot>>;

const TTL_MS: Record<Provider, number> = {
	claude: 60_000,
	codex: 90_000,
	minimax: 60_000,
	cursor: 15_000,
};

const STALE_MS = 1_000;
const refreshInFlight = new Set<Provider>();
let intervals: ReturnType<typeof setInterval>[] = [];
let ui: ExtensionContext["ui"] | undefined;
let requestRender: (() => void) | undefined;

function ensureCacheDir(): void {
	if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function pathFor(provider: Provider): string {
	return join(CACHE_DIR, `${provider}.json`);
}

function readCache(provider: Provider): Snapshot | undefined {
	try {
		return JSON.parse(readFileSync(pathFor(provider), "utf-8")) as Snapshot;
	} catch {
		return undefined;
	}
}

function writeCache(provider: Provider, snap: Snapshot): void {
	ensureCacheDir();
	try {
		writeFileSync(pathFor(provider), JSON.stringify(snap, null, 2));
	} catch {
		/* cache write is best-effort */
	}
}

function runFetcher(provider: Provider): Promise<Snapshot | undefined> {
	return new Promise((resolve) => {
		const child = spawn("python3", [SCRIPT, provider], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			resolve(undefined);
		}, 20_000);
		child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf-8")));
		child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf-8")));
		child.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(stdout) as Snapshot);
			} catch {
				resolve(undefined);
			}
		});
	});
}

async function refresh(provider: Provider, { force = false }: { force?: boolean } = {}): Promise<void> {
	if (refreshInFlight.has(provider)) return;
	const cached = readCache(provider);
	const age = cached ? Date.now() - cached.fetchedAt : Infinity;
	const halfTtl = TTL_MS[provider] / 2;
	if (!force && age < halfTtl) return; // coalesce: skip if cache is fresh enough
	refreshInFlight.add(provider);
	try {
		const next = await runFetcher(provider);
		if (next) writeCache(provider, next);
	} finally {
		refreshInFlight.delete(provider);
		requestRender?.();
	}
}

function start(): void {
	stop();
	for (const provider of Object.keys(TTL_MS) as Provider[]) {
		const jitter = Math.floor(Math.random() * 5_000);
		intervals.push(
			setInterval(() => void refresh(provider), TTL_MS[provider] + jitter),
		);
		// Initial fire (jittered) so the footer isn't blank on startup.
		setTimeout(() => void refresh(provider, { force: true }), Math.random() * 2_000);
	}
}

function stop(): void {
	for (const handle of intervals) clearInterval(handle);
	intervals = [];
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		start();
	});

	pi.on("session_shutdown", () => {
		stop();
		ui = undefined;
	});

	pi.on("agent_settled", () => {
		// Nudge, but the per-provider guard inside refresh() decides whether to fetch.
		for (const provider of Object.keys(TTL_MS) as Provider[]) void refresh(provider);
	});

	pi.registerCommand("usage-cache", {
		description: "Force-refresh Claude/Codex/MiniMax quota and Cursor IDE proxy cache",
		handler: async (_args, ctx) => {
			const tasks: Promise<void>[] = [];
			for (const provider of Object.keys(TTL_MS) as Provider[]) {
				tasks.push(refresh(provider, { force: true }));
			}
			await Promise.all(tasks);
			ctx.ui.notify("Quota cache refreshed.", "info");
		},
	});

	pi.registerCommand("usage", {
		description: "Print the current quota cache to the transcript",
		handler: async (_args, ctx) => {
			try {
				const result = await pi.exec("bash", [join(homedir(), ".pi", "agent", "extensions", "quota-status.sh")], { timeout: 5_000 });
				ctx.ui.notify(result.stdout || "(empty)", "info");
			} catch {
				ctx.ui.notify("Failed to read quota cache.", "warning");
			}
		},
	});

	// Expose cache reads + a render trigger so the usage-status footer can subscribe.
	pi.events.on("footer_subscribe", (handler: (slots: Slots) => void) => {
		const tick = () => {
			const slots: Slots = {};
			for (const provider of Object.keys(TTL_MS) as Provider[]) {
				const snap = readCache(provider);
				if (snap) slots[provider] = snap;
			}
			handler(slots);
		};
		tick();
		const interval = setInterval(tick, 2_000);
		return () => clearInterval(interval);
	});
}

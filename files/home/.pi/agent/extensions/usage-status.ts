/**
 * Compact pi footer.
 *
 * Line 1: active provider/model, reasoning level, current context use.
 * Line 2: 5h/7d quota for Claude and Codex, MiniMax quota, Cursor IDE proxy state.
 *
 * Reads from ~/.cache/pi-orchestra/quota/<provider>.json which is owned and
 * refreshed by the quota-cache extension. This extension never blocks the
 * renderer on a network call; stale entries are dimmed to warn.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const CACHE_DIR = join(homedir(), ".cache", "pi-orchestra", "quota");

type Codex = { primaryLeft: number; weeklyLeft: number; live: boolean; fetchedAt: number };
type Claude = { primaryLeft: number; weeklyLeft: number; live: boolean; fetchedAt: number };
type MiniMax = { currentLeft: number; weeklyLeft: number; live: boolean; fetchedAt: number };
type Cursor = { state: "running" | "stopped" | "unknown"; live: boolean; fetchedAt: number };

type Quota = {
	codex?: Codex;
	claude?: Claude;
	minimax?: MiniMax;
	cursor?: Cursor;
};

const TTL_MS = 60_000; // matches cache default; used purely for stale colouring

function readJson<T>(provider: string): T | undefined {
	const path = join(CACHE_DIR, `${provider}.json`);
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function compactNumber(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000).toFixed(1)}M`;
}

function shortModel(provider?: string, id?: string): string {
	const name = id ?? "no model";
	if (provider === "openai-codex") return `Codex / ${name.replace(/^gpt-[\d.]+-/, "")}`;
	if (provider === "claude-bridge") return `Claude / ${name.replace(/^claude-/, "")}`;
	if (provider === "minimax") return `MiniMax / ${name.replace(/^MiniMax-/, "")}`;
	return provider ? `${provider} / ${name}` : name;
}

function quotaColour(theme: any, remaining: number, text: string): string {
	if (remaining <= 15) return theme.fg("error", text);
	if (remaining <= 35) return theme.fg("warning", text);
	return theme.fg("success", text);
}

function staleColour(theme: any, text: string): string {
	return theme.fg("warning", text);
}

function ageString(fetchedAt: number): string {
	const ms = Date.now() - fetchedAt;
	if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
	return `${Math.round(ms / 3_600_000)}h ago`;
}

function isStale(snap?: { fetchedAt: number }): boolean {
	if (!snap) return true;
	return Date.now() - snap.fetchedAt > 2 * TTL_MS;
}

function fit(parts: string[], width: number): string {
	return truncateToWidth(parts.join(""), width, "…");
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let activeModel: { provider?: string; id?: string } | undefined;
	let thinkingLevel: string | undefined;
	let requestRender: (() => void) | undefined;

	const redraw = () => requestRender?.();

	function readQuota(): Quota {
		const codex = readJson<Codex>("codex");
		const claude = readJson<Claude>("claude");
		const minimax = readJson<MiniMax>("minimax");
		const cursor = readJson<Cursor>("cursor");
		return { codex, claude, minimax, cursor };
	}

	pi.on("session_start", (_event, sessionCtx) => {
		if (sessionCtx.mode !== "tui") return;
		ctx = sessionCtx;
		activeModel = sessionCtx.model;
		thinkingLevel = sessionCtx.thinkingLevel;

		sessionCtx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			const cacheTick = setInterval(redraw, 5_000);

			return {
				dispose() {
					unsubscribeBranch();
					clearInterval(cacheTick);
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const model = activeModel ?? ctx?.model;
					const modelText = theme.bold(theme.fg("accent", shortModel(model?.provider, model?.id)));
					const level = thinkingLevel ?? ctx?.thinkingLevel ?? "off";
					const thinking = theme.fg(level === "off" ? "dim" : `thinking${level[0]?.toUpperCase()}${level.slice(1)}`, ` · ${level}`);
					const usage = ctx?.getContextUsage();
					const contextText = usage?.tokens === null || usage?.percent === null || !usage
						? theme.fg("dim", "Ctx calculating…")
						: quotaColour(
								theme,
								100 - usage.percent,
								`Ctx ${Math.round(usage.percent)}% (${compactNumber(usage.tokens)}/${compactNumber(usage.contextWindow)})`,
							);
					const branch = footerData.getGitBranch();
					const location = theme.fg("dim", ` · ${branch ? `${ctx?.cwd?.split("/").pop()} (${branch})` : ctx?.cwd?.split("/").pop() ?? ""}`);
					const lineOne = fit([modelText, thinking, theme.fg("dim", "   "), contextText, location], width);

					const quota = readQuota();
					const ultraCompact = width < 120;
					const compact = width < 150;
					const codex = quota.codex
						? compact
							? (isStale(quota.codex) ? staleColour : quotaColour)(theme, quota.codex.primaryLeft, `${quota.codex.primaryLeft}%`) + theme.fg("dim", "/") + (isStale(quota.codex) ? staleColour : quotaColour)(theme, quota.codex.weeklyLeft, `${quota.codex.weeklyLeft}%`)
							: theme.fg("dim", "Codex ") + (isStale(quota.codex) ? staleColour : quotaColour)(theme, quota.codex.primaryLeft, `${quota.codex.primaryLeft}%`) + theme.fg("dim", ` 5h · `) + (isStale(quota.codex) ? staleColour : quotaColour)(theme, quota.codex.weeklyLeft, `${quota.codex.weeklyLeft}%`) + theme.fg("dim", " week")
						: theme.fg("warning", "Codex ?");
					const claude = quota.claude
						? ultraCompact
							? theme.fg("dim", "Claude 5h") + (isStale(quota.claude) ? staleColour : quotaColour)(theme, quota.claude.primaryLeft, `${quota.claude.primaryLeft}%`) + theme.fg("dim", "/7d") + (isStale(quota.claude) ? staleColour : quotaColour)(theme, quota.claude.weeklyLeft, `${quota.claude.weeklyLeft}%`)
							: compact
								? theme.fg("dim", "Claude 5h ") + (isStale(quota.claude) ? staleColour : quotaColour)(theme, quota.claude.primaryLeft, `${quota.claude.primaryLeft}%`) + theme.fg("dim", "/7d ") + (isStale(quota.claude) ? staleColour : quotaColour)(theme, quota.claude.weeklyLeft, `${quota.claude.weeklyLeft}%`)
								: theme.fg("dim", "Claude 5h ") + (isStale(quota.claude) ? staleColour : quotaColour)(theme, quota.claude.primaryLeft, `${quota.claude.primaryLeft}%`) + theme.fg("dim", " · 7d ") + (isStale(quota.claude) ? staleColour : quotaColour)(theme, quota.claude.weeklyLeft, `${quota.claude.weeklyLeft}%`) + theme.fg("dim", ` · ${ageString(quota.claude.fetchedAt)}${quota.claude.live ? "" : " · cached"}`)
						: theme.fg("warning", "Claude ?");
					const minimax = quota.minimax
						? ultraCompact
							? theme.fg("dim", "Mini ") + (isStale(quota.minimax) ? staleColour : quotaColour)(theme, quota.minimax.currentLeft, `${quota.minimax.currentLeft}%`) + theme.fg("dim", "/") + (isStale(quota.minimax) ? staleColour : quotaColour)(theme, quota.minimax.weeklyLeft, `${quota.minimax.weeklyLeft}%`)
							: compact
								? theme.fg("dim", "MiniMax ") + (isStale(quota.minimax) ? staleColour : quotaColour)(theme, quota.minimax.currentLeft, `${quota.minimax.currentLeft}%`) + theme.fg("dim", "/") + (isStale(quota.minimax) ? staleColour : quotaColour)(theme, quota.minimax.weeklyLeft, `${quota.minimax.weeklyLeft}%`)
								: theme.fg("dim", "MiniMax ") + (isStale(quota.minimax) ? staleColour : quotaColour)(theme, quota.minimax.currentLeft, `${quota.minimax.currentLeft}%`) + theme.fg("dim", " now · ") + (isStale(quota.minimax) ? staleColour : quotaColour)(theme, quota.minimax.weeklyLeft, `${quota.minimax.weeklyLeft}%`) + theme.fg("dim", " week")
						: theme.fg("warning", "MiniMax ?");
					const cursor = quota.cursor
						? quota.cursor.state === "running"
							? theme.fg("success", "Cursor IDE running")
							: theme.fg("warning", `Cursor IDE ${quota.cursor.state === "stopped" ? "stopped" : "?"}`)
						: theme.fg("warning", "Cursor ?");
					const sep = theme.fg("dim", ultraCompact ? " | " : "   |   ");
					const lineTwo = fit([theme.bold(theme.fg("muted", "Usage  ")), codex, sep, claude, sep, minimax, sep, cursor, ultraCompact ? "" : theme.fg("dim", "   ↻ /usage-cache")], width);

					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size === 0) return [lineOne, lineTwo];
					const statusLine = Array.from(extensionStatuses.entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/[\\r\\n\\t]/g, " ").replace(/ +/g, " ").trim())
						.join(" ");
					return [lineOne, lineTwo, truncateToWidth(statusLine, width, "...")];
				},
			};
		});
	});

	pi.on("model_select", (event, eventCtx) => {
		activeModel = event.model;
		thinkingLevel = eventCtx.thinkingLevel;
		redraw();
	});
	pi.on("thinking_level_select", (event) => {
		thinkingLevel = event.level;
		redraw();
	});
	pi.on("session_compact", () => redraw());
	pi.on("session_shutdown", () => {
		requestRender = undefined;
		ctx = undefined;
	});
}

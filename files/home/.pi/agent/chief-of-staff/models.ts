import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LEAD_MODELS =
	"openai-codex/gpt-6.1-sol:high, claude-bridge/claude-opus-5-5:high, minimax/MiniMax-M3.1-Flash:high";
export const DEFAULT_WORKER_MODELS =
	"cursor-ide/composer-2.5:high, minimax/MiniMax-M3.1-Flash:high, openai-codex/gpt-6-luna:high, claude-bridge/claude-sonnet-5-5:high";

export const NEW_WORK_HEADROOM = 15;
export const CONTINUE_HEADROOM = 5;
export const BIG_CONTEXT_TOKENS = 100_000;
export const DEFAULT_BRIDGE_MODEL = "minimax/MiniMax-M3.1-Flash:high";
export const BRIDGE_COMPACT_INSTRUCTIONS =
	"Handoff summary: keep the task, decisions, constraints, files touched, and exact next steps.";

const STALE_MS = 20 * 60_000;
export const QUOTA_WAKE_FALLBACK_MS = 30 * 60_000;
/** Re-check a pending wake this often: quota windows can free up before their published reset. */
export const QUOTA_WAKE_RECHECK_MS = 2 * 60_000;
const LOW_QUOTA_PCT = 30;
const LIMIT_RE = /usage limit|rate limit|quota|429|too many requests|insufficient|exceeded/i;
const MODEL_ENTRY = /^[\w.-]+\/[\w.-]+(?::\w+)?$/;

type CacheName = "codex" | "claude" | "minimax" | "cursor";

type QuotaSnap = {
	fetchedAt: number;
	live: boolean;
	primaryLeft?: number;
	weeklyLeft?: number;
	currentLeft?: number;
	primaryResetsAt?: number;
	weeklyResetsAt?: number;
	currentResetsAt?: number;
	state?: string;
};

export type ModelsDeps = {
	cacheDir: string;
	now: () => number;
	getKv: (key: string) => string | undefined;
	setKv: (key: string, value: string) => void;
	deleteKv?: (key: string) => void;
};

export type PickModelOpts = { headroom?: "new" | "continue" };

let deps: ModelsDeps = defaultDeps();

export function defaultDeps(): ModelsDeps {
	return {
		cacheDir: join(homedir(), ".cache", "pi-orchestra", "quota"),
		now: () => Date.now(),
		getKv: () => undefined,
		setKv: () => {},
	};
}

export function setModelsDeps(next: ModelsDeps | null): void {
	deps = next ?? defaultDeps();
}

export function getModelsDeps(): ModelsDeps {
	return deps;
}

function isModelsDeps(v: PickModelOpts | ModelsDeps): v is ModelsDeps {
	return "cacheDir" in v;
}

export function parseModelChain(raw: string): string[] {
	return raw.split(",").map(s => s.trim()).filter(Boolean);
}

export function validateModelChain(raw: string): void {
	const parts = parseModelChain(raw);
	if (!parts.length) throw new Error("Model chain must list at least one provider/model entry");
	for (const entry of parts) {
		if (!MODEL_ENTRY.test(entry)) throw new Error(`Bad model entry "${entry}"; use provider/model or provider/model:thinking`);
	}
}

export function parseModelRef(ref: string): { provider: string; modelId: string; thinking?: string } {
	const m = /^([^/]+)\/([^:]+)(?::(\w+))?$/.exec(ref.trim());
	if (!m) throw new Error(`Bad model ref "${ref}"`);
	return { provider: m[1], modelId: m[2], thinking: m[3] };
}

export function cacheNameForProvider(provider: string): CacheName | undefined {
	if (provider === "openai-codex") return "codex";
	if (provider === "claude-bridge") return "claude";
	if (provider === "cursor-ide") return "cursor";
	if (provider.startsWith("minimax")) return "minimax";
	return undefined;
}

function readSnap(name: CacheName, d: ModelsDeps): QuotaSnap | undefined {
	try {
		return JSON.parse(readFileSync(join(d.cacheDir, `${name}.json`), "utf8")) as QuotaSnap;
	} catch {
		return undefined;
	}
}

function exhaustedUntil(provider: string, d: ModelsDeps): number | undefined {
	const raw = d.getKv(`exhausted:${provider}`);
	if (!raw) return undefined;
	const until = Number(raw);
	return Number.isFinite(until) && until > d.now() ? until : undefined;
}

function resetMs(snap: QuotaSnap, d: ModelsDeps): number | undefined {
	const candidates: number[] = [];
	for (const key of ["primaryResetsAt", "weeklyResetsAt", "currentResetsAt"] as const) {
		const v = snap[key];
		if (typeof v !== "number") continue;
		candidates.push(v < 1e12 ? v * 1000 : v);
	}
	if (!candidates.length) return undefined;
	const future = candidates.filter(t => t > d.now());
	if (!future.length) return undefined;
	return Math.min(...future);
}

function shortResetMs(snap: QuotaSnap, name: CacheName, d: ModelsDeps): number | undefined {
	const key = name === "minimax" ? "currentResetsAt" : "primaryResetsAt";
	const v = snap[key];
	if (typeof v !== "number") return undefined;
	const ms = v < 1e12 ? v * 1000 : v;
	return ms > d.now() ? ms : undefined;
}

export function providerResetAt(provider: string, d: ModelsDeps = deps): number | undefined {
	const name = cacheNameForProvider(provider);
	if (!name) return undefined;
	const snap = readSnap(name, d);
	return snap ? resetMs(snap, d) : undefined;
}

export function markProviderExhausted(provider: string, d: ModelsDeps = deps): void {
	const reset = providerResetAt(provider, d);
	const until = reset ?? d.now() + 30 * 60_000;
	d.setKv(`exhausted:${provider}`, String(until));
}

export function providerStatus(
	provider: string,
	d: ModelsDeps = deps,
): { available: boolean; summary: string; resetsAt?: number } {
	if (exhaustedUntil(provider, d)) {
		const reset = providerResetAt(provider, d) ?? exhaustedUntil(provider, d);
		return { available: false, summary: "exhausted", resetsAt: reset };
	}
	const name = cacheNameForProvider(provider);
	if (!name) return { available: true, summary: "unknown" };
	const snap = readSnap(name, d);
	if (!snap || d.now() - snap.fetchedAt > STALE_MS) return { available: true, summary: "unknown" };
	if (name === "cursor") {
		const ok = snap.state === "running";
		return { available: ok, summary: ok ? "running" : String(snap.state ?? "down"), resetsAt: resetMs(snap, d) };
	}
	const short = name === "minimax" ? snap.currentLeft : snap.primaryLeft;
	const week = snap.weeklyLeft;
	const summary =
		typeof short === "number" && typeof week === "number" ? `${short}%/${week}%` : "unknown";
	const available = typeof short === "number" && typeof week === "number" ? short > CONTINUE_HEADROOM && week > CONTINUE_HEADROOM : true;
	return { available, summary, resetsAt: resetMs(snap, d) };
}

function headroomPct(kind: "new" | "continue"): number {
	return kind === "new" ? NEW_WORK_HEADROOM : CONTINUE_HEADROOM;
}

export function providerHasHeadroom(provider: string, kind: "new" | "continue", d: ModelsDeps = deps): boolean {
	if (exhaustedUntil(provider, d)) return false;
	const name = cacheNameForProvider(provider);
	if (!name) return true;
	const snap = readSnap(name, d);
	if (!snap || d.now() - snap.fetchedAt > STALE_MS) return true;
	if (name === "cursor") return snap.state === "running";
	const short = name === "minimax" ? snap.currentLeft : snap.primaryLeft;
	if (typeof short !== "number") return true;
	return short > headroomPct(kind);
}

export function pickModel(chain: string[], optsOrDeps?: PickModelOpts | ModelsDeps, maybeDeps?: ModelsDeps): string {
	let opts: PickModelOpts = {};
	let d = deps;
	if (optsOrDeps) {
		if (isModelsDeps(optsOrDeps)) d = optsOrDeps;
		else {
			opts = optsOrDeps;
			d = maybeDeps ?? deps;
		}
	}
	const kind = opts.headroom ?? "continue";
	if (!chain.length) throw new Error("Empty model chain");
	let fallback = chain[0];
	let bestReset = Infinity;
	for (const ref of chain) {
		const { provider } = parseModelRef(ref);
		const st = providerStatus(provider, d);
		const reset = st.resetsAt ?? exhaustedUntil(provider, d) ?? Infinity;
		if (reset < bestReset) {
			bestReset = reset;
			fallback = ref;
		}
		if (providerHasHeadroom(provider, kind, d)) return ref;
	}
	return fallback;
}

function quotaBit(name: CacheName, d: ModelsDeps): string {
	const provider =
		name === "codex" ? "openai-codex" : name === "claude" ? "claude-bridge" : name === "minimax" ? "minimax" : "cursor-ide";
	const st = providerStatus(provider, d);
	if (name === "cursor") return `cursor ${st.summary}`;
	const snap = readSnap(name, d);
	let suffix = "";
	if (snap && d.now() - snap.fetchedAt <= STALE_MS) {
		const short = name === "minimax" ? snap.currentLeft : snap.primaryLeft;
		const week = snap.weeklyLeft;
		const low = st.summary === "exhausted" || (typeof short === "number" && short < LOW_QUOTA_PCT) || (typeof week === "number" && week < LOW_QUOTA_PCT);
		if (low) {
			const reset = st.resetsAt ?? shortResetMs(snap, name, d) ?? exhaustedUntil(provider, d);
			if (reset) suffix = ` (5h refills ${formatQuotaUntil(reset)})`;
		}
	}
	return `${name} ${st.summary}${suffix}`;
}

export function quotaLine(d: ModelsDeps = deps): string {
	const bits = (["codex", "claude", "minimax", "cursor"] as CacheName[]).map(name => quotaBit(name, d));
	return `Model quota (5h/week left): ${bits.join(" · ")}`;
}

export function soonestRefill(chain: string[], d: ModelsDeps = deps): number | undefined {
	let best: number | undefined;
	for (const ref of chain) {
		const { provider } = parseModelRef(ref);
		if (providerHasHeadroom(provider, "continue", d)) continue;
		const reset = exhaustedUntil(provider, d) ?? providerResetAt(provider, d);
		if (typeof reset === "number" && (!best || reset < best)) best = reset;
	}
	return best;
}

export function isUsageLimitError(stopReason: string | undefined, errorMessage: string | undefined): boolean {
	return stopReason === "error" && Boolean(errorMessage && LIMIT_RE.test(errorMessage));
}

export function lastAssistantLimit(messages: { role?: string; stopReason?: string; errorMessage?: string }[] | undefined): boolean {
	if (!messages?.length) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		return isUsageLimitError(m.stopReason, m.errorMessage);
	}
	return false;
}

export function chainAllUnavailable(chain: string[], d: ModelsDeps = deps): boolean {
	return chain.every(ref => !providerHasHeadroom(parseModelRef(ref).provider, "continue", d));
}

export function formatQuotaUntil(ms: number): string {
	const t = new Date(ms);
	return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

export function bridgeModelRef(raw?: string): string {
	const ref = (raw ?? DEFAULT_BRIDGE_MODEL).trim();
	validateModelChain(ref);
	return ref;
}

export function bridgeProvider(ref: string): string {
	return parseModelRef(ref).provider;
}

export function bridgeAvailable(ref: string, d: ModelsDeps = deps): boolean {
	return providerHasHeadroom(bridgeProvider(ref), "continue", d);
}

/** First chain entry that is not the bridge provider and has continuing headroom. */
export function nextBigModel(chain: string[], bridgeRef: string, d: ModelsDeps = deps): string | undefined {
	const skip = bridgeProvider(bridgeRef);
	for (const entry of chain) {
		const { provider } = parseModelRef(entry);
		if (provider === skip) continue;
		if (providerHasHeadroom(provider, "continue", d)) return entry;
	}
	return undefined;
}

function providerHasFreshHeadroom(provider: string, kind: "new" | "continue", d: ModelsDeps): boolean {
	if (exhaustedUntil(provider, d)) return false;
	const name = cacheNameForProvider(provider);
	if (!name) return false;
	const snap = readSnap(name, d);
	if (!snap || d.now() - snap.fetchedAt > STALE_MS) return false;
	if (name === "cursor") return snap.state === "running";
	const short = name === "minimax" ? snap.currentLeft : snap.primaryLeft;
	if (typeof short !== "number") return false;
	return short > headroomPct(kind);
}

export function chainHasFreshHeadroom(chain: string[], d: ModelsDeps = deps): boolean {
	return chain.some(ref => providerHasFreshHeadroom(parseModelRef(ref).provider, "continue", d));
}

export function wakeAtKey(recipient: string): string {
	return `wake_at:${recipient}`;
}

export function wakeReasonKey(recipient: string): string {
	return `wake_reason:${recipient}`;
}

export function wakeTaskKey(recipient: string): string {
	return `wake_task:${recipient}`;
}

export function wakeModelKey(recipient: string): string {
	return `wake_model:${recipient}`;
}

export function wakeAgentKey(recipient: string): string {
	return `wake_agent:${recipient}`;
}

function wakeNoticeKey(recipient: string): string {
	return `wake_notice:${recipient}`;
}

function wakeErrorKey(recipient: string): string {
	return `wake_error:${recipient}`;
}

export function providerDisplayName(provider: string): string {
	if (provider.startsWith("minimax")) return "MiniMax";
	if (provider === "openai-codex") return "Codex";
	if (provider === "claude-bridge") return "Claude";
	if (provider === "cursor-ide") return "Cursor";
	return provider;
}

/** Soonest quota reset among chain providers that lack continuing headroom. */
export function soonestRefillProvider(
	chain: string[],
	d: ModelsDeps = deps,
): { provider: string; display: string; at: number } | undefined {
	let best: { provider: string; display: string; at: number } | undefined;
	for (const ref of chain) {
		const { provider } = parseModelRef(ref);
		if (providerHasHeadroom(provider, "continue", d)) continue;
		const reset = exhaustedUntil(provider, d) ?? providerResetAt(provider, d);
		if (typeof reset !== "number") continue;
		if (!best || reset < best.at) best = { provider, display: providerDisplayName(provider), at: reset };
	}
	return best;
}

function clearWakeKv(recipient: string, d: ModelsDeps): void {
	for (const key of [
		wakeAtKey(recipient),
		wakeReasonKey(recipient),
		wakeTaskKey(recipient),
		wakeNoticeKey(recipient),
		wakeModelKey(recipient),
		wakeAgentKey(recipient),
		wakeErrorKey(recipient),
	]) {
		if (d.deleteKv) d.deleteKv(key);
		else d.setKv(key, "");
	}
}

export function clearQuotaWake(recipient: string, d: ModelsDeps = deps): void {
	clearWakeKv(recipient, d);
}

export function armQuotaWake(
	recipient: string,
	chain: string[],
	task: string,
	reason: string,
	d: ModelsDeps = deps,
): { wakeAt: number; providerLabel: string; waitLine: string; shouldNotify: boolean } {
	const taskTrim = task.trim().slice(0, 500) || "Continue the blocked work.";
	const refill = soonestRefillProvider(chain, d);
	const providerLabel = refill?.display ?? "the next provider";
	const existingModel = d.getKv(wakeModelKey(recipient));
	if (existingModel) {
		const prevWake = Number(d.getKv(wakeAtKey(recipient)));
		const newWakeAt = soonestRefill(chain, d) ?? d.now() + QUOTA_WAKE_FALLBACK_MS;
		if (Number.isFinite(prevWake) && newWakeAt < prevWake) d.setKv(wakeAtKey(recipient), String(newWakeAt));
		d.setKv(wakeTaskKey(recipient), taskTrim);
		d.setKv(wakeReasonKey(recipient), reason.trim().slice(0, 300));
		const wakeAt = Number(d.getKv(wakeAtKey(recipient)));
		const waitLine = `Out of quota until ${formatQuotaUntil(wakeAt)}; I'll start it automatically when ${providerLabel} refills.`;
		return { wakeAt, providerLabel, waitLine, shouldNotify: false };
	}
	const wakeAt = soonestRefill(chain, d) ?? d.now() + QUOTA_WAKE_FALLBACK_MS;
	const prevTask = d.getKv(wakeTaskKey(recipient)) ?? "";
	const prevNotice = d.getKv(wakeNoticeKey(recipient));
	d.setKv(wakeAtKey(recipient), String(wakeAt));
	d.setKv(wakeReasonKey(recipient), reason.trim().slice(0, 300));
	d.setKv(wakeTaskKey(recipient), taskTrim);
	const shouldNotify = prevNotice !== String(wakeAt) || prevTask !== taskTrim;
	if (shouldNotify) d.setKv(wakeNoticeKey(recipient), String(wakeAt));
	const waitLine = `Out of quota until ${formatQuotaUntil(wakeAt)}; I'll start it automatically when ${providerLabel} refills.`;
	return { wakeAt, providerLabel, waitLine, shouldNotify };
}

export function armWaitForModel(
	recipient: string,
	modelRef: string,
	task: string,
	agent: string | undefined,
	d: ModelsDeps = deps,
): { wakeAt: number; waitLine: string; shouldNotifyTelegram: boolean; telegramLine: string } {
	const ref = modelRef.trim();
	validateModelChain(ref);
	const { provider } = parseModelRef(ref);
	// If the window already has room, wake now; otherwise wait for its reset.
	const readyNow = providerHasFreshHeadroom(provider, "continue", d);
	const wakeAt = readyNow
		? d.now()
		: providerResetAt(provider, d) ?? exhaustedUntil(provider, d) ?? d.now() + QUOTA_WAKE_FALLBACK_MS;
	const taskTrim = task.trim().slice(0, 4000) || "Continue the blocked work.";
	const agentTrim = agent?.trim() ?? "";
	const prevNotice = d.getKv(wakeNoticeKey(recipient));
	const prevTask = d.getKv(wakeTaskKey(recipient)) ?? "";
	d.setKv(wakeAtKey(recipient), String(wakeAt));
	d.setKv(wakeModelKey(recipient), ref);
	d.setKv(wakeTaskKey(recipient), taskTrim);
	if (agentTrim) d.setKv(wakeAgentKey(recipient), agentTrim);
	else if (d.deleteKv) d.deleteKv(wakeAgentKey(recipient));
	else d.setKv(wakeAgentKey(recipient), "");
	const shouldNotifyTelegram = prevNotice !== String(wakeAt) || prevTask !== taskTrim;
	if (shouldNotifyTelegram) d.setKv(wakeNoticeKey(recipient), String(wakeAt));
	const agentBit = agentTrim ? ` (resuming ${agentTrim} automatically)` : "";
	const whenBit = readyNow ? "now" : `until ${formatQuotaUntil(wakeAt)}`;
	const waitLine = `Waiting for ${ref} ${whenBit}${agentBit}.`;
	const telegramLine = readyNow
		? `${ref} has quota again — resuming now.`
		: `Holding "${taskTrim.slice(0, 80)}" until ${ref} is back at ${formatQuotaUntil(wakeAt)}.`;
	return { wakeAt, waitLine, shouldNotifyTelegram, telegramLine };
}

export function formatQuotaBackTelegram(model: string, agent?: string): string {
	const { provider } = parseModelRef(model);
	const label = providerDisplayName(provider);
	const tail = agent ? `resumed ${agent}` : "continued the task";
	return `${label} quota is back — switched to ${model} and ${tail}.`;
}

export type TickQuotaWakeHooks = {
	followUp: (msg: string) => void;
	resumeAgent?: (p: { target: string; model: string; task: string }) => Promise<void>;
	wakeChief?: (p: { model: string }) => Promise<boolean>;
	telegram?: (msg: string) => void;
	telegramError?: (msg: string) => void;
};

function modelRefHasFreshHeadroom(ref: string, d: ModelsDeps): boolean {
	return providerHasFreshHeadroom(parseModelRef(ref).provider, "continue", d);
}

function rearmProviderWake(recipient: string, provider: string, d: ModelsDeps): void {
	// A window can free up before its published reset (the cache refreshes every few minutes),
	// so retry soon instead of waiting a week for the weekly reset.
	const reset = exhaustedUntil(provider, d) ?? providerResetAt(provider, d) ?? d.now() + QUOTA_WAKE_FALLBACK_MS;
	d.setKv(wakeAtKey(recipient), String(Math.min(reset, d.now() + QUOTA_WAKE_RECHECK_MS)));
}

/** When wake_at is due, resume chief/lead work if quota allows. */
export async function tickQuotaWake(
	recipient: string,
	chain: string[],
	hooksOrFollowUp: TickQuotaWakeHooks | ((msg: string) => void),
	d: ModelsDeps = deps,
): Promise<void> {
	const hooks: TickQuotaWakeHooks =
		typeof hooksOrFollowUp === "function" ? { followUp: hooksOrFollowUp } : hooksOrFollowUp;
	const rawAt = d.getKv(wakeAtKey(recipient));
	if (!rawAt) return;
	const wakeAt = Number(rawAt);
	if (!Number.isFinite(wakeAt) || d.now() < wakeAt) return;

	const wakeModel = d.getKv(wakeModelKey(recipient))?.trim();
	if (wakeModel) {
		const { provider } = parseModelRef(wakeModel);
		if (!modelRefHasFreshHeadroom(wakeModel, d)) {
			rearmProviderWake(recipient, provider, d);
			return;
		}
		const task = d.getKv(wakeTaskKey(recipient)) ?? "Continue the blocked work.";
		const agent = d.getKv(wakeAgentKey(recipient))?.trim() || undefined;
		try {
			if (agent) {
				if (!hooks.resumeAgent) throw new Error("resumeAgent hook missing");
				await hooks.resumeAgent({ target: agent, model: wakeModel, task });
			} else {
				if (hooks.wakeChief) {
					const ok = await hooks.wakeChief({ model: wakeModel });
					if (!ok) throw new Error("could not switch chief model");
				}
				hooks.followUp(task);
			}
			clearQuotaWake(recipient, d);
			if (hooks.telegram) hooks.telegram(formatQuotaBackTelegram(wakeModel, agent));
		} catch (e) {
			rearmProviderWake(recipient, provider, d);
			if (hooks.telegramError && d.getKv(wakeErrorKey(recipient)) !== rawAt) {
				d.setKv(wakeErrorKey(recipient), rawAt);
				hooks.telegramError(`Quota is back for ${providerDisplayName(provider)} but resume failed: ${(e as Error).message}`);
			}
		}
		return;
	}

	const rearm = (): void => {
		const next = soonestRefill(chain, d) ?? d.now() + QUOTA_WAKE_FALLBACK_MS;
		d.setKv(wakeAtKey(recipient), String(next));
	};

	if (!chainHasFreshHeadroom(chain, d)) {
		rearm();
		return;
	}

	const model = pickModel(chain, { headroom: "continue" }, d);
	const { provider } = parseModelRef(model);
	if (!providerHasFreshHeadroom(provider, "continue", d)) {
		rearm();
		return;
	}

	const task = d.getKv(wakeTaskKey(recipient)) ?? "Continue the blocked work.";
	const label = providerDisplayName(provider);
	try {
		if (hooks.wakeChief) {
			const ok = await hooks.wakeChief({ model });
			if (!ok) throw new Error("could not switch chief model");
		}
		clearQuotaWake(recipient, d);
		hooks.followUp(`[Chief] ${label} quota is back (${model}). ${task}`);
		if (hooks.telegram) hooks.telegram(formatQuotaBackTelegram(model));
	} catch (e) {
		rearm();
		if (hooks.telegramError && d.getKv(wakeErrorKey(recipient)) !== rawAt) {
			d.setKv(wakeErrorKey(recipient), rawAt);
			hooks.telegramError(`Quota is back for ${label} but resume failed: ${(e as Error).message}`);
		}
	}
}

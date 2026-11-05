/**
 * /cheap-compact — compact the session using a cheap summarizer model.
 *
 * Pi's own /compact summarizes with the currently active model (Opus/Sol),
 * which spends the expensive quota. This command runs the same native
 * compaction pipeline but delegates the summarization to a cheaper model, in
 * this order:
 *
 *   1. minimax/MiniMax-M3.1-Flash
 *   2. claude-bridge/claude-haiku-5-5
 *   3. openai-codex/gpt-6-luna
 *
 * The active session model and thinking level are never changed. Only the
 * one-off summarization request uses a cheap model.
 *
 * Implementation notes:
 * - Uses only public exports of @earendil-works/pi-coding-agent. A previous
 *   draft imported the private subpath dist/core/compaction/index.js, which is
 *   not in the package "exports" map and broke extension loading for every
 *   pi session.
 * - The native compact() helper is reused so previous-summary merging, split
 *   turns, cut-point selection, file-op tracking and usage accounting behave
 *   exactly like a normal /compact.
 * - If every candidate fails, compaction is cancelled instead of silently
 *   falling back to the expensive active model.
 */

import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";

type CompactionPreparation = Parameters<typeof compact>[0];
type StreamFn = NonNullable<Parameters<typeof compact>[7]>;
type Model = Parameters<typeof compact>[1];
type ThinkingLevel = NonNullable<Parameters<typeof compact>[6]>;

/** Marker stored in compaction details so later compactions can carry file lists forward. */
export const OWNED_COMPACTION_MARKER = "cheap-compact" as const;

export const CHEAP_SUMMARIZER_CANDIDATES = [
	{ provider: "minimax", modelId: "MiniMax-M3.1-Flash" },
	{ provider: "claude-bridge", modelId: "claude-haiku-5-5" },
	{ provider: "openai-codex", modelId: "gpt-6-luna" },
] as const;

export type SummarizerCandidate = (typeof CHEAP_SUMMARIZER_CANDIDATES)[number];

/** Thinking level used for the cheap summarization request only. */
export const SUMMARY_THINKING_LEVEL: ThinkingLevel = "low";

export interface CheapCompactDetails {
	readFiles: string[];
	modifiedFiles: string[];
	cheapCompactOwner: typeof OWNED_COMPACTION_MARKER;
	summarizerProvider: string;
	summarizerModelId: string;
}

export interface CheapCompactDeps {
	modelRegistry: {
		find(provider: string, modelId: string): Model | undefined;
		hasConfiguredAuth(model: Model): boolean;
		streamSimple(model: Model, context: any, options?: any): any;
	};
	/** Override for tests. Defaults to the native compact() helper. */
	compactFn?: typeof compact;
	streamFn?: StreamFn;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
	candidates?: readonly SummarizerCandidate[];
}

export function isOwnedCheapCompactDetails(
	details: unknown,
): details is CheapCompactDetails {
	if (!details || typeof details !== "object") return false;
	const record = details as Record<string, unknown>;
	return record.cheapCompactOwner === OWNED_COMPACTION_MARKER;
}

/**
 * Find the newest compaction entry on the branch.
 *
 * Pi carries a compaction's file lists into the next compaction only when the
 * entry was NOT produced by an extension hook (fromHook). Our own entries are
 * hook-produced, so Pi skips them. We merge them back ourselves to keep the
 * cumulative read/modified file list intact.
 */
export function findLatestCompactionEntry(branchEntries: unknown[]): any | undefined {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i] as any;
		if (entry && entry.type === "compaction") return entry;
	}
	return undefined;
}

export function mergeOwnedFileLists(preparation: any, branchEntries: unknown[]): void {
	const previous = findLatestCompactionEntry(branchEntries);
	if (!previous || !isOwnedCheapCompactDetails(previous.details)) return;
	const fileOps = preparation?.fileOps;
	if (!fileOps || !fileOps.read || !fileOps.edited) return;
	for (const path of previous.details.readFiles ?? []) fileOps.read.add(path);
	for (const path of previous.details.modifiedFiles ?? []) fileOps.edited.add(path);
}

/**
 * A summary produced by an aborted or failed request must never be persisted
 * as a compaction checkpoint.
 */
export function summarizationResponseFailure(
	response: { stopReason?: string; errorMessage?: string },
	label = "Summarization",
): string | undefined {
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	if (response.stopReason === "aborted") {
		return `${label} aborted`;
	}
	return undefined;
}

export function assertUsableCompactionResult(result: CompactionResult): string | undefined {
	if (!result.summary || !result.summary.trim()) return "Compaction summary was empty";
	if (!result.firstKeptEntryId) return "Compaction result is missing firstKeptEntryId";
	return undefined;
}

function isAbortFailure(error: unknown, signal: AbortSignal | undefined): boolean {
	if (signal?.aborted) return true;
	if (error instanceof Error && error.name === "AbortError") return true;
	return false;
}

/**
 * Wrap a stream function so a failed/aborted/empty response is rejected before
 * it can become a persisted compaction checkpoint.
 */
function createValidatingStreamFn(base: StreamFn): StreamFn {
	return (async (model: any, context: any, options: any) => {
		const stream = await base(model, context, options);
		const originalResult = stream.result.bind(stream);
		const validating = {
			...stream,
			async result() {
				const response = await originalResult();
				const failure = summarizationResponseFailure(response);
				if (failure) throw new Error(failure);
				if (response.content?.some((block: any) => block.type === "toolCall")) {
					throw new Error("Summarization attempted to call a tool");
				}
				const text = (response.content ?? [])
					.filter((block: any) => block.type === "text")
					.map((block: any) => block.text)
					.join("\n");
				if (!text.trim()) throw new Error("Compaction summary was empty");
				return response;
			},
		};
		return validating;
	}) as StreamFn;
}

function attachCheapCompactDetails(
	result: CompactionResult,
	model: Model,
): CompactionResult<CheapCompactDetails> {
	const base = (result.details ?? {}) as Partial<CheapCompactDetails>;
	return {
		...result,
		details: {
			readFiles: base.readFiles ?? [],
			modifiedFiles: base.modifiedFiles ?? [],
			cheapCompactOwner: OWNED_COMPACTION_MARKER,
			summarizerProvider: model.provider,
			summarizerModelId: model.id,
		},
	};
}

export interface CheapCompactEvent {
	preparation: CompactionPreparation;
	branchEntries?: unknown[];
	customInstructions?: string;
	signal?: AbortSignal;
}

/**
 * Run compaction with the cheap summarizer chain.
 *
 * Returns the compaction payload for the session_before_compact hook, or
 * { cancel: true } when no candidate could produce a usable summary.
 */
export async function runCheapCompaction(
	event: CheapCompactEvent,
	deps: CheapCompactDeps,
): Promise<SessionBeforeCompactResult> {
	const { signal, customInstructions } = event;
	// Keep cumulative file tracking: our own hook-produced entries are skipped
	// by Pi's native carry-forward, so merge them back in.
	if (event.branchEntries) mergeOwnedFileLists(event.preparation, event.branchEntries);
	const compactImpl = deps.compactFn ?? compact;
	const baseStream =
		deps.streamFn ??
		((model: any, context: any, options: any) => deps.modelRegistry.streamSimple(model, context, options));
	const streamFn = createValidatingStreamFn(baseStream);
	const candidates = deps.candidates ?? CHEAP_SUMMARIZER_CANDIDATES;
	const notify = deps.notify;

	let lastError: string | undefined;

	for (let index = 0; index < candidates.length; index++) {
		if (signal?.aborted) {
			notify?.("Cheap compaction cancelled", "warning");
			return { cancel: true };
		}

		const candidate = candidates[index]!;
		const model = deps.modelRegistry.find(candidate.provider, candidate.modelId);
		if (!model) {
			lastError = `Summarizer unavailable: ${candidate.provider}/${candidate.modelId}`;
			continue;
		}
		if (!deps.modelRegistry.hasConfiguredAuth(model)) {
			lastError = `Summarizer not authenticated: ${candidate.provider}/${candidate.modelId}`;
			continue;
		}

		notify?.(
			index === 0
				? `Compacting with ${candidate.provider}/${candidate.modelId}`
				: `Retrying compaction with ${candidate.provider}/${candidate.modelId}`,
			index === 0 ? "info" : "warning",
		);

		try {
			const result = await compactImpl(
				event.preparation,
				model,
				undefined,
				undefined,
				customInstructions,
				signal,
				SUMMARY_THINKING_LEVEL,
				streamFn,
			);
			const unusable = assertUsableCompactionResult(result);
			if (unusable) throw new Error(unusable);
			if (signal?.aborted) {
				notify?.("Cheap compaction cancelled", "warning");
				return { cancel: true };
			}
			return { compaction: attachCheapCompactDetails(result, model) };
		} catch (error) {
			if (isAbortFailure(error, signal)) {
				notify?.("Cheap compaction cancelled", "warning");
				return { cancel: true };
			}
			lastError = error instanceof Error ? error.message : String(error);
		}
	}

	notify?.(
		lastError
			? `Cheap compaction failed (${lastError}); not using the active model.`
			: "No cheap summarizer is available; cheap compaction cancelled.",
		"error",
	);
	return { cancel: true };
}

export default function (pi: ExtensionAPI) {
	/**
	 * /cheap-compact is implemented by intercepting the compaction that the
	 * command itself triggers. Pi has no public API to compact with a specific
	 * summarizer model, but session_before_compact lets an extension supply
	 * the summary content.
	 *
	 * A counter (not a boolean) marks how many pending cheap compactions exist,
	 * so overlapping invocations cannot steal each other's flag. The counter is
	 * reset when a compaction fails before the hook runs (for example when the
	 * session is too small to compact), which would otherwise leave a stale
	 * flag that would silently reroute the user's next normal /compact.
	 */
	let pendingCheapCompaction = 0;

	pi.registerCommand("cheap-compact", {
		description:
			"Compact the session using a cheap summarizer (MiniMax M3.1 Flash, falling back to Haiku, then Luna)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const instructions = args.trim() || undefined;
			pendingCheapCompaction++;
			try {
				// ctx.compact() is fire-and-forget; the hook runs inside it.
				ctx.compact({ customInstructions: instructions });
			} catch (error) {
				pendingCheapCompaction = Math.max(0, pendingCheapCompaction - 1);
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Cheap compaction failed: ${message}`, "error");
			}
		},
	});

	pi.on("session_compact_failed", async () => {
		// A compaction that failed before the hook consumed the flag must not
		// affect the next /compact.
		pendingCheapCompaction = 0;
	});

	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (pendingCheapCompaction <= 0) {
			// Normal /compact or automatic compaction: leave Pi's behavior untouched.
			return undefined;
		}
		pendingCheapCompaction--;
		try {
			return await runCheapCompaction(
				{
					preparation: event.preparation,
					branchEntries: event.branchEntries as unknown[],
					customInstructions: event.customInstructions,
					signal: event.signal,
				},
				{
					modelRegistry: ctx.modelRegistry,
					notify: ctx.hasUI ? (message, type) => ctx.ui.notify(message, type) : undefined,
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Cheap compaction failed: ${message}`, "error");
			return { cancel: true };
		}
	});
}

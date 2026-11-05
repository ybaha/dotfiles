import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isUsageLimitError } from "./models.ts";

const TAIL_BYTES = 200_000;

export type AgentModelInfo =
	| { kind: "pi"; provider: string; modelId: string; ref: string; usageLimit: boolean }
	| { kind: "unknown" };

function readTail(path: string, maxBytes: number): string {
	const size = statSync(path).size;
	const start = Math.max(0, size - maxBytes);
	const len = size - start;
	const buf = Buffer.alloc(len);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buf, 0, len, start);
	} finally {
		closeSync(fd);
	}
	return buf.toString("utf8");
}

/** Infer model from the tail of a Pi session JSONL file (no message bodies). */
export function agentModel(sessionPath: string): AgentModelInfo {
	let tail: string;
	try {
		tail = readTail(sessionPath, TAIL_BYTES);
	} catch {
		return { kind: "unknown" };
	}
	const lines = tail.split("\n").filter(Boolean);
	let model: { provider: string; modelId: string } | undefined;
	let usageLimit = false;
	let lastAssistantIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		let entry: { type?: string; provider?: string; modelId?: string; message?: { role?: string; provider?: string; model?: string; stopReason?: string; errorMessage?: string } };
		try {
			entry = JSON.parse(lines[i]!);
		} catch {
			continue;
		}
		if (entry.type === "model_change" && entry.provider && entry.modelId) {
			model = { provider: entry.provider, modelId: entry.modelId };
		}
		if (entry.type === "message" && entry.message?.role === "assistant") {
			lastAssistantIdx = i;
			if (entry.message.provider && entry.message.model) {
				model = { provider: entry.message.provider, modelId: entry.message.model };
			}
		}
	}
	if (lastAssistantIdx >= 0) {
		try {
			const msg = JSON.parse(lines[lastAssistantIdx]!).message;
			usageLimit = isUsageLimitError(msg?.stopReason, msg?.errorMessage);
		} catch {
			usageLimit = false;
		}
	}
	if (!model) return { kind: "unknown" };
	return { kind: "pi", provider: model.provider, modelId: model.modelId, ref: `${model.provider}/${model.modelId}`, usageLimit };
}

export function formatModelLabel(info: AgentModelInfo): string {
	return info.kind === "pi" ? info.ref : "unknown";
}

/** Context size from the session tail: the largest recent assistant usage (input + cacheRead + output).
 * A limit-error message carries no usage, so the newest entry alone under-reports a long session. */
export function sessionContextTokens(sessionPath: string): number {
	let tail: string;
	try {
		tail = readTail(sessionPath, TAIL_BYTES);
	} catch {
		return 0;
	}
	const lines = tail.split("\n").filter(Boolean);
	let biggest = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry: { type?: string; message?: { role?: string; usage?: Record<string, number> } };
		try {
			entry = JSON.parse(lines[i]!);
		} catch {
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const u = entry.message.usage;
		if (!u || typeof u !== "object") continue;
		biggest = Math.max(biggest, (u.input ?? 0) + (u.cacheRead ?? 0) + (u.output ?? 0));
		if (biggest > 0) break;
	}
	return biggest;
}

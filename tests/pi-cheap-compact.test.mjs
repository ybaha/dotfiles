import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

function resolvePiRoot() {
	const localRequire = createRequire(import.meta.url);
	try {
		return dirname(localRequire.resolve("@earendil-works/pi-coding-agent/package.json"));
	} catch {
		const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
		return join(globalRoot, "@earendil-works/pi-coding-agent");
	}
}

const piRoot = resolvePiRoot();
const requireFromPi = createRequire(join(piRoot, "package.json"));
const createJiti = requireFromPi("jiti");
// Mirror the aliases Pi's own extension loader applies, so the extension
// resolves the package by its public name instead of a private subpath.
const loadModule = createJiti(import.meta.url, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js"),
		"@earendil-works/pi-ai": join(piRoot, "dist/core/extensions/pi-ai-extension-view.js"),
		"@earendil-works/pi-ai/compat": join(piRoot, "dist/core/extensions/pi-ai-extension-view.js"),
	},
});

const extPath = join(here, "../files/home/.pi/agent/extensions/cheap-compact.ts");
const mod = await loadModule.import(extPath);
// The real native helper, used so the stream-validation path is exercised
// end-to-end instead of being bypassed by a mock.
const nativeCompact = requireFromPi(join(piRoot, "dist/index.js")).compact;

const {
	CHEAP_SUMMARIZER_CANDIDATES,
	OWNED_COMPACTION_MARKER,
	SUMMARY_THINKING_LEVEL,
	assertUsableCompactionResult,
	findLatestCompactionEntry,
	isOwnedCheapCompactDetails,
	mergeOwnedFileLists,
	runCheapCompaction,
	summarizationResponseFailure,
} = mod;

function basePreparation(overrides = {}) {
	return {
		firstKeptEntryId: "keep-1",
		messagesToSummarize: [{ role: "user", content: "hello", timestamp: 1 }],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 1000,
		previousSummary: "prior summary",
		fileOps: { read: new Set(["a.ts"]), written: new Set(), edited: new Set(["b.ts"]) },
		settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		...overrides,
	};
}

function mockRegistry(models) {
	const byKey = new Map(models.map((m) => [`${m.provider}/${m.id}`, m]));
	return {
		find(provider, modelId) {
			const hit = byKey.get(`${provider}/${modelId}`);
			return hit ? { provider, id: modelId } : undefined;
		},
		hasConfiguredAuth(model) {
			return byKey.get(`${model.provider}/${model.id}`)?.authed !== false;
		},
		streamSimple() {
			throw new Error("streamSimple should not be called when streamFn is injected");
		},
	};
}

function okStreamFn(text = "## Goal\nDone") {
	return async () => ({
		async result() {
			return {
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason: "stop",
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
			};
		},
	});
}

function failingStreamFn(stopReason, extra = {}) {
	return async () => ({
		async result() {
			return {
				role: "assistant",
				content:
					stopReason === "toolUse"
						? [{ type: "toolCall", name: "read", arguments: { path: "x" } }]
						: [{ type: "text", text: stopReason === "length" ? "partial" : "" }],
				stopReason,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				...extra,
			};
		},
	});
}

function successResult(prep) {
	return {
		summary: "## Goal\nok",
		firstKeptEntryId: prep.firstKeptEntryId,
		tokensBefore: prep.tokensBefore,
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
		details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
	};
}

test("candidate order short-circuits on first success", async () => {
	const calls = [];
	const compactFn = async (prep, model) => {
		calls.push(`${model.provider}/${model.id}`);
		return successResult(prep);
	};

	const result = await runCheapCompaction(
		{ preparation: basePreparation(), customInstructions: "focus files" },
		{
			modelRegistry: mockRegistry([
				{ provider: "minimax", id: "MiniMax-M3.1-Flash" },
				{ provider: "claude-bridge", id: "claude-haiku-5-5" },
			]),
			compactFn,
			streamFn: okStreamFn(),
		},
	);

	assert.equal(calls.length, 1);
	assert.equal(calls[0], "minimax/MiniMax-M3.1-Flash");
	assert.ok(result.compaction);
	assert.equal(result.compaction.details.summarizerProvider, "minimax");
	assert.equal(result.compaction.details.summarizerModelId, "MiniMax-M3.1-Flash");
	assert.equal(result.compaction.details.cheapCompactOwner, OWNED_COMPACTION_MARKER);
	assert.equal(result.compaction.usage.totalTokens, 3);
	assert.ok(isOwnedCheapCompactDetails(result.compaction.details));
});

test("skips missing or unauthenticated models then succeeds", async () => {
	const calls = [];
	const compactFn = async (prep, model) => {
		calls.push(`${model.provider}/${model.id}`);
		return successResult(prep);
	};

	await runCheapCompaction(
		{ preparation: basePreparation() },
		{
			modelRegistry: mockRegistry([
				{ provider: "minimax", id: "MiniMax-M3.1-Flash", authed: false },
				{ provider: "claude-bridge", id: "claude-haiku-5-5" },
			]),
			compactFn,
			streamFn: okStreamFn(),
		},
	);

	assert.deepEqual(calls, ["claude-bridge/claude-haiku-5-5"]);
});

test("runtime failures try next candidate; all fail cancels instead of using active model", async () => {
	let attempts = 0;
	const compactFn = async () => {
		attempts++;
		throw new Error(`fail-${attempts}`);
	};

	const result = await runCheapCompaction(
		{ preparation: basePreparation() },
		{
			modelRegistry: mockRegistry(
				CHEAP_SUMMARIZER_CANDIDATES.map((c) => ({ provider: c.provider, id: c.modelId })),
			),
			compactFn,
			streamFn: okStreamFn(),
		},
	);

	assert.equal(attempts, CHEAP_SUMMARIZER_CANDIDATES.length);
	assert.equal(result.cancel, true);
	assert.equal(result.compaction, undefined);
});

test("abort before the first attempt does not call any candidate", async () => {
	const controller = new AbortController();
	controller.abort();
	const calls = [];
	const compactFn = async (prep, model) => {
		calls.push(model.id);
		return successResult(prep);
	};

	const result = await runCheapCompaction(
		{ preparation: basePreparation(), signal: controller.signal },
		{
			modelRegistry: mockRegistry(
				CHEAP_SUMMARIZER_CANDIDATES.map((c) => ({ provider: c.provider, id: c.modelId })),
			),
			compactFn,
			streamFn: okStreamFn(),
		},
	);

	assert.equal(calls.length, 0);
	assert.equal(result.cancel, true);
});

test("abort mid-second attempt stops without a third call", async () => {
	const controller = new AbortController();
	let calls = 0;
	const compactFn = async (prep) => {
		calls++;
		if (calls === 2) controller.abort();
		throw new Error("nope");
	};

	const result = await runCheapCompaction(
		{ preparation: basePreparation(), signal: controller.signal },
		{
			modelRegistry: mockRegistry(
				CHEAP_SUMMARIZER_CANDIDATES.map((c) => ({ provider: c.provider, id: c.modelId })),
			),
			compactFn,
			streamFn: okStreamFn(),
		},
	);

	assert.equal(calls, 2);
	assert.equal(result.cancel, true);
});

test("rejects error, length, aborted, tool-call and empty stream responses", async () => {
	const cases = [
		["length", failingStreamFn("length")],
		["error", failingStreamFn("error", { errorMessage: "boom" })],
		["aborted", failingStreamFn("aborted")],
		["toolUse", failingStreamFn("toolUse")],
		["empty", failingStreamFn("stop")],
	];

	for (const [name, streamFn] of cases) {
		// No compactFn override: the native helper runs and must reject the
		// bad response rather than persisting it as a checkpoint.
		const result = await runCheapCompaction(
			{ preparation: basePreparation() },
			{
				modelRegistry: mockRegistry([{ provider: "minimax", id: "MiniMax-M3.1-Flash" }]),
				compactFn: nativeCompact,
				streamFn,
				candidates: [{ provider: "minimax", modelId: "MiniMax-M3.1-Flash" }],
			},
		);
		assert.equal(result.cancel, true, `expected cancel for ${name}`);
	}

	assert.equal(
		assertUsableCompactionResult({ summary: "  ", firstKeptEntryId: "k", tokensBefore: 1 }),
		"Compaction summary was empty",
	);
	assert.ok(summarizationResponseFailure({ stopReason: "aborted" }, "Summarization"));
});

test("native compact() with a good response yields a usable checkpoint", async () => {
	const result = await runCheapCompaction(
		{ preparation: basePreparation() },
		{
			modelRegistry: mockRegistry([{ provider: "minimax", id: "MiniMax-M3.1-Flash" }]),
			compactFn: nativeCompact,
			streamFn: okStreamFn("## Goal\nnative summary"),
			candidates: [{ provider: "minimax", modelId: "MiniMax-M3.1-Flash" }],
		},
	);

	assert.ok(result.compaction, "expected a compaction result");
	assert.match(result.compaction.summary, /native summary/);
	assert.equal(result.compaction.firstKeptEntryId, "keep-1");
	assert.equal(result.compaction.details.summarizerModelId, "MiniMax-M3.1-Flash");
	assert.ok(result.compaction.usage, "expected usage to be recorded");
});

test("passes preparation, instructions and low thinking level to compact", async () => {
	let seen = {};
	const prep = basePreparation({
		isSplitTurn: true,
		turnPrefixMessages: [{ role: "user", content: "split", timestamp: 2 }],
	});

	await runCheapCompaction(
		{ preparation: prep, customInstructions: "keep tests" },
		{
			modelRegistry: mockRegistry([{ provider: "minimax", id: "MiniMax-M3.1-Flash" }]),
			compactFn: async (passedPrep, _model, _key, _headers, instructions, _signal, thinking) => {
				seen = { passedPrep, instructions, thinking };
				return successResult(passedPrep);
			},
			streamFn: okStreamFn(),
			candidates: [{ provider: "minimax", modelId: "MiniMax-M3.1-Flash" }],
		},
	);

	assert.equal(seen.instructions, "keep tests");
	assert.equal(seen.thinking, SUMMARY_THINKING_LEVEL);
	assert.equal(seen.passedPrep.previousSummary, "prior summary");
	assert.equal(seen.passedPrep.firstKeptEntryId, "keep-1");
	assert.equal(seen.passedPrep.isSplitTurn, true);
	assert.equal(seen.passedPrep.turnPrefixMessages.length, 1);
});

test("owned details carry native file lists and are recognizable", () => {
	const result = {
		summary: "s",
		firstKeetEntryId: "k",
		tokensBefore: 1,
		details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
	};
	assert.equal(isOwnedCheapCompactDetails(result.details), false);
	assert.equal(isOwnedCheapCompactDetails({ cheapCompactOwner: OWNED_COMPACTION_MARKER }), true);
	assert.equal(isOwnedCheapCompactDetails(undefined), false);
	assert.equal(isOwnedCheapCompactDetails(null), false);
});

test("own file lists are merged back so cumulative tracking survives", () => {
	const branchEntries = [
		{ type: "message", id: "m1" },
		{
			type: "compaction",
			id: "cmp-1",
			summary: "s",
			firstKeptEntryId: "x",
			tokensBefore: 1,
			fromHook: true,
			details: {
				readFiles: ["kept-read.ts"],
				modifiedFiles: ["kept-edit.ts"],
				cheapCompactOwner: OWNED_COMPACTION_MARKER,
				summarizerProvider: "minimax",
				summarizerModelId: "MiniMax-M3.1-Flash",
			},
		},
	];
	const prep = basePreparation();
	mergeOwnedFileLists(prep, branchEntries);
	assert.ok(prep.fileOps.read.has("kept-read.ts"));
	assert.ok(prep.fileOps.edited.has("kept-edit.ts"));
	assert.ok(prep.fileOps.read.has("a.ts"));
	assert.equal(findLatestCompactionEntry(branchEntries)?.id, "cmp-1");
});

test("file lists are not merged from a native (non-owned) compaction", () => {
	const branchEntries = [
		{
			type: "compaction",
			id: "cmp-native",
			summary: "s",
			firstKeptEntryId: "x",
			tokensBefore: 1,
			details: { readFiles: ["native-read.ts"], modifiedFiles: [] },
		},
	];
	const prep = basePreparation();
	mergeOwnedFileLists(prep, branchEntries);
	assert.equal(prep.fileOps.read.has("native-read.ts"), false);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, symlinkSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(import.meta.url);
let piRoot;
try {
	piRoot = dirname(localRequire.resolve("@earendil-works/pi-coding-agent/package.json"));
} catch {
	piRoot = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10000 }).trim(), "@earendil-works/pi-coding-agent");
}
const requireFromPi = createRequire(join(piRoot, "package.json"));
const createJiti = requireFromPi("jiti");
const loadModule = createJiti(import.meta.url, { moduleCache: false });
const { createEventBus, DefaultPackageManager, SettingsManager } = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const extensionDir = join(here, "../files/home/.pi/agent/extensions");
const extensionPath = join(extensionDir, "herdr-subagent-state/index.ts");
const settings = JSON.parse(readFileSync(join(here, "../files/home/.pi/agent/settings.json"), "utf8"));
const wrapper = await loadModule.import(extensionPath);
const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function withEnvironment(overrides, run) {
	const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return await run();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function mockPi() {
	const handlers = new Map();
	const bus = createEventBus();
	const listenerCounts = new Map();
	return {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event).add(handler);
			return () => handlers.get(event).delete(handler);
		},
		events: {
			emit: bus.emit,
			on(channel, handler) {
				const unsubscribe = bus.on(channel, handler);
				listenerCounts.set(channel, (listenerCounts.get(channel) ?? 0) + 1);
				let active = true;
				return () => {
					if (!active) return;
					active = false;
					listenerCounts.set(channel, listenerCounts.get(channel) - 1);
					unsubscribe();
				};
			},
		},
		listenerCount: (channel) => listenerCounts.get(channel) ?? 0,
		handlerCount: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
		async trigger(event, ctx, extra = {}) {
			for (const handler of [...(handlers.get(event) ?? [])]) await handler({ type: event, ...extra }, ctx);
		},
	};
}

function context(mode = "tui") {
	let idle = true;
	return {
		mode,
		isIdle: () => idle,
		setIdle(value) { idle = value; },
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => "/tmp/herdr-test-session.jsonl",
		},
	};
}

function managedFixture(states) {
	return (pi) => {
		let root = false;
		let active = false;
		let blocked = 0;
		const publish = () => {
			const state = blocked > 0 ? "blocked" : active ? "working" : "idle";
			if (states.at(-1) !== state) states.push(state);
		};
		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			root = true;
			active = !ctx.isIdle();
			publish();
		});
		pi.on("agent_start", () => {
			if (!root) return;
			active = true;
			publish();
		});
		pi.on("agent_settled", (_event, ctx) => {
			if (!root || !ctx.isIdle()) return;
			active = false;
			publish();
		});
		pi.events.on("herdr:blocked", (event) => {
			if (!root) return;
			blocked = Math.max(0, blocked + (event.active ? 1 : -1));
			publish();
		});
	};
}

async function harness(run, { mode = "tui", initialIdle = true, initialChildren = [] } = {}) {
	return withEnvironment({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/not-a-real-herdr-test.sock", HERDR_PANE_ID: "test-pane" }, async () => {
		const savedManager = globalThis[MANAGER_KEY];
		const records = new Map(initialChildren);
		globalThis[MANAGER_KEY] = { hasRunning: () => [...records.values()].some((status) => status === "running" || status === "queued") };
		const pi = mockPi();
		const ctx = context(mode);
		ctx.setIdle(initialIdle);
		const states = [];
		const originalOn = pi.on;
		try {
			await wrapper.installHerdrSubagentState(pi, managedFixture(states));
			assert.equal(pi.on, originalOn, "the real ExtensionAPI is not mutated");
			await pi.trigger("session_start", ctx, { reason: "startup" });
			await flush();
			await run({ pi, ctx, states, records, flush });
		} finally {
			await pi.trigger("session_shutdown", ctx, { reason: "reload" });
			await flush();
			if (savedManager === undefined) delete globalThis[MANAGER_KEY];
			else globalThis[MANAGER_KEY] = savedManager;
		}
	});
}

async function startMain(pi, ctx) {
	ctx.setIdle(false);
	await pi.trigger("agent_start", ctx);
}
async function settleMain(pi, ctx) {
	ctx.setIdle(true);
	await pi.trigger("agent_settled", ctx);
	await flush();
}

// Uses Pi's actual resolver, not a string-only approximation of exclusions.
test("resource discovery enables only the wrapper, with relative and symlinked agent paths", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-resources-"));
	try {
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "project");
		mkdirSync(join(agentDir, "extensions/herdr-subagent-state"), { recursive: true });
		mkdirSync(cwd);
		writeFileSync(join(agentDir, "extensions/herdr-agent-state.ts"), "export default function () {}\n");
		writeFileSync(join(agentDir, "extensions/herdr-subagent-state/index.ts"), "export default function () {}\n");
		const alias = join(dir, "agent-link");
		symlinkSync(agentDir, alias, "dir");
		const paths = [agentDir, alias];
		if (existsSync(join(extensionDir, "herdr-agent-state.ts"))) paths.push(join(here, "../files/home/.pi/agent"));
		for (const path of paths) {
			const manager = new DefaultPackageManager({ cwd, agentDir: path, settingsManager: SettingsManager.inMemory({ extensions: settings.extensions }) });
			const resources = await manager.resolve();
			const managed = resources.extensions.filter((entry) => entry.path.endsWith("/herdr-agent-state.ts"));
			const wrapped = resources.extensions.filter((entry) => entry.path.endsWith("/herdr-subagent-state/index.ts"));
			assert.equal(managed.length, 1);
			assert.equal(managed[0].enabled, false);
			assert.equal(wrapped.length, 1);
			assert.equal(wrapped[0].enabled, true);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no initialization outside Herdr, even if the host has inherited pane variables", async () => {
	await withEnvironment({ HERDR_ENV: undefined }, async () => {
		const pi = mockPi();
		await wrapper.default(pi);
		await wrapper.installHerdrSubagentState(pi, () => assert.fail("managed reporter must not load"));
		assert.equal(pi.handlerCount(), 0);
	});
});

test("a machine without the ignored Herdr integration can load the wrapper", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-missing-"));
	try {
		mkdirSync(join(dir, "herdr-subagent-state"));
		const copied = join(dir, "herdr-subagent-state/index.ts");
		copyFileSync(extensionPath, copied);
		await withEnvironment({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/missing-test.sock", HERDR_PANE_ID: "test-pane" }, async () => {
			const fresh = await loadModule.import(copied);
			const pi = mockPi();
			await fresh.default(pi);
			assert.equal(pi.handlerCount(), 0);
		});
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const mode of ["rpc", "json", "print"]) {
	test(`${mode} children never report state to the parent pane`, async () => {
		await harness(async ({ pi, states, records }) => {
			records.set("a", "running");
			pi.events.emit("subagents:started", { id: "a" });
			await flush();
			assert.deepEqual(states, []);
			assert.equal(pi.listenerCount("subagents:started"), 0);
		}, { mode });
	});
}

test("main activity alone is unchanged", async () => {
	await harness(async ({ pi, ctx, states }) => {
		await startMain(pi, ctx);
		await settleMain(pi, ctx);
		assert.deepEqual(states, ["idle", "working", "idle"]);
	});
});

for (const [channel, terminal] of [["subagents:completed", "completed"], ["subagents:failed", "error"], ["subagents:failed", "stopped"], ["subagents:failed", "aborted"]]) {
	test(`main settles before last child becomes ${terminal}: working then idle`, async () => {
		await harness(async ({ pi, ctx, states, records }) => {
			await startMain(pi, ctx);
			records.set("a", "running");
			pi.events.emit("subagents:started", { id: "a" });
			await flush(); // Deliberately finish the child's start event while root is busy.
			await settleMain(pi, ctx);
			assert.equal(ctx.isIdle(), true, "Pi itself must remain available for input");
			assert.deepEqual(states, ["idle", "working"]);
			records.set("a", terminal);
			pi.events.emit(channel, { id: "a", status: terminal });
			await flush();
			assert.deepEqual(states, ["idle", "working", "idle"]);
		});
	});
}

test("a completed child cannot settle a still-running main agent", async () => {
	await harness(async ({ pi, ctx, states, records }) => {
		await startMain(pi, ctx);
		records.set("a", "running");
		pi.events.emit("subagents:started", { id: "a" });
		await flush();
		records.set("a", "completed");
		pi.events.emit("subagents:completed", { id: "a" });
		await flush();
		assert.equal(states.at(-1), "working");
		await settleMain(pi, ctx);
		assert.equal(states.at(-1), "idle");
	});
});

test("running and queued children keep the pane working until all finish", async () => {
	await harness(async ({ pi, states, records }) => {
		records.set("a", "running");
		records.set("b", "queued");
		pi.events.emit("subagents:started", { id: "a" });
		pi.events.emit("subagents:created", { id: "b" });
		await flush();
		records.set("a", "completed");
		pi.events.emit("subagents:completed", { id: "a" });
		await flush();
		assert.deepEqual(states, ["idle", "working"]);
		records.set("b", "running");
		pi.events.emit("subagents:started", { id: "b" });
		await flush();
		records.set("b", "completed");
		pi.events.emit("subagents:completed", { id: "b" });
		await flush();
		assert.deepEqual(states, ["idle", "working", "idle"]);
	});
});

test("idle scheduler fires and resumed/handoff duplicate events are idempotent", async () => {
	await harness(async ({ pi, states, records }) => {
		pi.events.emit("subagents:scheduled", { type: "added", jobId: "later" });
		await flush();
		assert.deepEqual(states, ["idle"]);
		for (let run = 0; run < 2; run++) {
			records.set("a", "running");
			pi.events.emit("subagents:started", { id: "a" }); // RPC/scheduler does not emit created.
			await flush();
			pi.events.emit("subagents:created", { id: "a" }); // Resume/handoff can emit created late.
			pi.events.emit("subagents:started", { id: "a" });
			await flush();
			records.set("a", "completed");
			pi.events.emit("subagents:completed", { id: "a" });
			pi.events.emit("subagents:created", { id: "a" }); // Stale event must not revive terminal work.
			await flush();
		}
		assert.deepEqual(states, ["idle", "working", "idle", "working", "idle"]);
	});
});

test("rehydrates running manager state on session start and ready", async () => {
	await harness(async ({ pi, states, records }) => {
		assert.deepEqual(states, ["working"]);
		records.clear();
		pi.events.emit("subagents:completed", { id: "a" });
		await flush();
		records.set("b", "queued");
		pi.events.emit("subagents:ready", {});
		await flush();
		assert.deepEqual(states, ["working", "idle", "working"]);
	}, { initialChildren: [["a", "running"]] });
});

test("blocked overrides children, including when the last child finishes", async () => {
	await harness(async ({ pi, states, records }) => {
		records.set("a", "running");
		pi.events.emit("subagents:started", { id: "a" });
		await flush();
		pi.events.emit("herdr:blocked", { active: true, label: "Approval" });
		await flush();
		records.set("a", "completed");
		pi.events.emit("subagents:completed", { id: "a" });
		await flush();
		assert.equal(states.at(-1), "blocked");
		pi.events.emit("herdr:blocked", { active: false });
		await flush();
		assert.deepEqual(states, ["idle", "working", "blocked", "idle"]);
	});
});

test("shutdown cancels deferred work, unsubscribes, and session replacement has no duplicates", async () => {
	await harness(async ({ pi, ctx, states, records }) => {
		assert.equal(pi.listenerCount("subagents:started"), 1);
		records.set("a", "running");
		pi.events.emit("subagents:started", { id: "a" });
		await pi.trigger("session_shutdown", ctx, { reason: "reload" });
		await flush();
		assert.deepEqual(states, ["idle"]);
		assert.equal(pi.listenerCount("subagents:started"), 0);
		pi.events.emit("subagents:started", { id: "a" });
		await flush();
		assert.deepEqual(states, ["idle"]);
		records.clear();
		await pi.trigger("session_start", ctx, { reason: "new" });
		await flush();
		assert.equal(pi.listenerCount("subagents:started"), 1);
		records.set("b", "running");
		pi.events.emit("subagents:started", { id: "b" });
		await flush();
		assert.deepEqual(states, ["idle", "working"]);
	});
});

test("actual managed reporter uses only a fake socket and preserves blocked/session/sequence behavior", { timeout: 10000 }, async (t) => {
	const managedPath = join(extensionDir, "herdr-agent-state.ts");
	try { readFileSync(managedPath); } catch { t.skip("Install the host's Herdr Pi integration for this test"); return; }
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-socket-"));
	const sockets = new Set();
	const reports = [];
	const waiters = [];
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			if (!buffer.includes("\n")) return;
			const report = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
			reports.push(report);
			socket.end(JSON.stringify({ id: report.id, result: {} }) + "\n");
			for (const notify of [...waiters]) notify();
		});
	});
	function waitFor(predicate) {
		if (predicate()) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { remove(); reject(new Error("Timed out waiting for managed state")); }, 1500);
			function remove() { clearTimeout(timer); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); }
			function check() { if (predicate()) { remove(); resolve(); } }
			waiters.push(check);
		});
	}
	const stateReports = () => reports.filter((report) => report.method === "pane.report_agent");
	const savedManager = globalThis[MANAGER_KEY];
	let pi;
	let ctx;
	try {
		const socketPath = join(dir, "fake.sock");
		await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
		await withEnvironment({ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "fake-pane-only" }, async () => {
			let running = false;
			globalThis[MANAGER_KEY] = { hasRunning: () => running };
			pi = mockPi();
			ctx = context();
			// The wrapper has not imported managed code before this point, so module-level
			// Herdr constants can only capture this test socket, never inherited host IPC.
			await wrapper.default(pi);
			await pi.trigger("session_start", ctx, { reason: "startup" });
			await waitFor(() => stateReports().at(-1)?.params.state === "idle");
			await startMain(pi, ctx);
			await waitFor(() => stateReports().at(-1)?.params.state === "working");
			running = true;
			pi.events.emit("subagents:started", { id: "a" });
			await flush();
			await settleMain(pi, ctx);
			assert.equal(stateReports().at(-1).params.state, "working");
			pi.events.emit("herdr:blocked", { active: true, label: "Approval" });
			await waitFor(() => stateReports().at(-1)?.params.state === "blocked");
			running = false;
			pi.events.emit("subagents:failed", { id: "a", status: "stopped" });
			await flush();
			assert.equal(stateReports().at(-1).params.state, "blocked");
			pi.events.emit("herdr:blocked", { active: false });
			await waitFor(() => stateReports().at(-1)?.params.state === "idle");
			assert.deepEqual(stateReports().map((report) => report.params.state), ["idle", "working", "blocked", "idle"]);
			for (const report of reports) {
				assert.equal(report.params.pane_id, "fake-pane-only");
				assert.equal(report.params.source, "herdr:pi");
				assert.equal(report.params.agent_session_path, ctx.sessionManager.getSessionFile());
			}
			const seq = stateReports().map((report) => report.params.seq);
			assert.ok(seq.every((value, i) => i === 0 || value > seq[i - 1]));
			await pi.trigger("session_shutdown", ctx, { reason: "reload" });
		});
	} finally {
		if (pi) await pi.trigger("session_shutdown", ctx, { reason: "quit" });
		await flush();
		if (savedManager === undefined) delete globalThis[MANAGER_KEY]; else globalThis[MANAGER_KEY] = savedManager;
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	}
});

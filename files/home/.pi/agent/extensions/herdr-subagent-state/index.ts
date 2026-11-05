import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const ACTIVITY_EVENTS = [
	"subagents:ready",
	"subagents:created",
	"subagents:started",
	"subagents:completed",
	"subagents:failed",
] as const;

type Manager = { hasRunning(): boolean };
type ManagedFactory = (pi: ExtensionAPI) => void | Promise<void>;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Register = (event: string, handler: Handler) => () => void;

function herdrEnabled(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
}

function hasSubagentsRunning(): boolean {
	const manager = (globalThis as Record<symbol, Manager | undefined>)[MANAGER_KEY];
	return manager?.hasRunning() === true;
}

// Only the reporter sees aggregate idleness; Pi remains available for new input.
export function viewCtxForManaged(ctx: ExtensionContext): ExtensionContext {
	return { ...ctx, isIdle: () => ctx.isIdle() && !hasSubagentsRunning() };
}

export async function installHerdrSubagentState(pi: ExtensionAPI, registerManaged: ManagedFactory): Promise<void> {
	if (!herdrEnabled()) return;

	const on = pi.on.bind(pi) as Register;
	const starts = new Set<Handler>();
	const settles = new Set<Handler>();
	const subscriptions: Array<() => void> = [];
	let rootCtx: ExtensionContext | undefined;
	let initialized = false;
	let reportedWorking = false;
	let pending: ReturnType<typeof setImmediate> | undefined;
	let generation = 0;

	function cleanup(): void {
		generation++;
		rootCtx = undefined;
		initialized = false;
		reportedWorking = false;
		if (pending !== undefined) clearImmediate(pending);
		pending = undefined;
		for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
	}

	async function reconcile(): Promise<void> {
		if (!initialized || !rootCtx) return;
		const ctx = viewCtxForManaged(rootCtx);
		const working = !ctx.isIdle();
		if (working === reportedWorking) return;
		reportedWorking = working;
		const handlers = working ? starts : settles;
		const event = working ? { type: "agent_start" } : { type: "agent_settled", aborted: false };
		const currentGeneration = generation;
		// Call only the managed reporter, not Pi's engine or other extensions.
		for (const handler of handlers) {
			if (currentGeneration !== generation) return;
			await handler(event, ctx);
		}
	}

	function scheduleReconcile(): void {
		if (!rootCtx || pending !== undefined) return;
		// Completion can immediately promote a queued child. Reconcile after that handoff.
		pending = setImmediate(() => {
			pending = undefined;
			void reconcile().catch((error) => console.error("Herdr subagent state:", error));
		});
	}

	on("session_start", (_event, ctx) => {
		cleanup();
		if (ctx.mode !== "tui") return;
		rootCtx = ctx;
		for (const channel of ACTIVITY_EVENTS) {
			subscriptions.push(pi.events.on(channel, scheduleReconcile));
		}
	});
	on("session_shutdown", cleanup);

	// Keep Herdr's managed factory as the sole socket/session authority.
	const decorated = Object.create(pi) as ExtensionAPI;
	Object.defineProperty(decorated, "on", {
		value: (event: string, handler: Handler) => {
			if (event !== "session_start" && event !== "agent_start" && event !== "agent_settled") {
				return on(event, handler);
			}
			const callbacks = event === "agent_start" ? starts : event === "agent_settled" ? settles : undefined;
			callbacks?.add(handler);
			const unsubscribe = on(event, async (ev, ctx) => {
				const currentGeneration = generation;
				if (rootCtx && ctx.mode === "tui") rootCtx = ctx;
				const result = await handler(ev, viewCtxForManaged(ctx));
				if (currentGeneration !== generation || !rootCtx) return result;
				if (event === "session_start" || event === "agent_start" || event === "agent_settled") {
					initialized = true;
					reportedWorking = event === "agent_start" || !viewCtxForManaged(ctx).isIdle();
					scheduleReconcile();
				}
				return result;
			});
			return () => {
				callbacks?.delete(handler);
				unsubscribe();
			};
		},
	});
	await registerManaged(decorated);
}

export default async function (pi: ExtensionAPI): Promise<void> {
	if (!herdrEnabled()) return;
	const managedURL = new URL("../herdr-agent-state.ts", import.meta.url);
	if (!existsSync(fileURLToPath(managedURL))) return;
	const managed = await import(managedURL.href);
	await installHerdrSubagentState(pi, managed.default);
}

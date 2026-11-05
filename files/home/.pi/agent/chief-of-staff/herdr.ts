import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { Store } from "./store.ts";
import { loadConfig } from "./store.ts";
import { agentModel, formatModelLabel, sessionContextTokens, type AgentModelInfo } from "./agents.ts";
import {
	BIG_CONTEXT_TOKENS,
	BRIDGE_COMPACT_INSTRUCTIONS,
	bridgeAvailable,
	bridgeModelRef,
	formatQuotaUntil,
	markProviderExhausted,
	nextBigModel,
	parseModelChain,
	parseModelRef,
	pickModel,
	providerResetAt,
	providerHasHeadroom,
	quotaLine,
	soonestRefill,
} from "./models.ts";

const execFileAsync = promisify(execFile);

export type HerdrFn = (args: string[], opts?: { machine?: string; timeoutMs?: number }) => Promise<any>;

export type HerdrAgent = {
	name?: string;
	pane_id: string;
	workspace_id: string;
	agent: string;
	agent_status: string;
	agent_session?: { kind: string; value: string; agent?: string };
};

export type WatchRow = {
	id: number;
	target: string;
	machine: string | null;
	label: string | null;
	via: string;
	sawWorking: boolean;
	createdAt: number;
	owner: string;
	resumeAt: number | null;
	quotaPauseNotified: boolean;
};

let herdrImpl: HerdrFn = defaultHerdr;
export let nowMs = () => Date.now();
export let watchIdleMs = 60_000;

export type ResumeDeps = {
	quitPi: (target: string, opts?: { machine?: string }) => Promise<void>;
	waitPiStopped: (target: string, pane: string, opts?: { machine?: string; timeoutMs?: number }) => Promise<void>;
};

let resumeDeps: ResumeDeps = defaultResumeDeps();

export function setHerdr(fn: HerdrFn | null): void {
	herdrImpl = fn ?? defaultHerdr;
}

export function setResumeDeps(fn: Partial<ResumeDeps> | null): void {
	resumeDeps = fn ? { ...defaultResumeDeps(), ...fn } : defaultResumeDeps();
}

export function setNowMs(fn: () => number): void {
	nowMs = fn;
}

export function setWatchIdleMs(ms: number): void {
	watchIdleMs = ms;
}

/** Runs herdr and returns `.result` from its JSON output; `agent read` prints plain text, which is returned as-is. */
async function defaultHerdr(args: string[], opts?: { machine?: string; timeoutMs?: number }): Promise<any> {
	const full = opts?.machine ? ["--machine", opts.machine, ...args] : args;
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("herdr", full, { timeout: opts?.timeoutMs ?? 15_000, maxBuffer: 10 * 1024 * 1024 }));
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; message: string };
		const raw = err.stderr?.trim() || err.stdout?.trim() || err.message;
		try {
			const { code, message } = JSON.parse(raw).error;
			throw new Error(`${code}: ${message}`);
		} catch (parsed) {
			throw parsed instanceof SyntaxError ? new Error(raw) : parsed;
		}
	}
	if (args[0] === "agent" && args[1] === "read") return stdout;
	return JSON.parse(stdout).result;
}

function defaultResumeDeps(): ResumeDeps {
	return {
		async quitPi(target, opts) {
			await herdr(["agent", "prompt", target, "/quit"], opts);
		},
		/** Done when the pane's foreground is its shell again; agent_not_found alone can precede Herdr freeing the name. */
		async waitPiStopped(target, pane, opts) {
			const deadline = nowMs() + (opts?.timeoutMs ?? 20_000);
			while (nowMs() < deadline) {
				const { process_info: info } = (await herdr(["pane", "process-info", "--pane", pane], opts)) as {
					process_info: { shell_pid: number; foreground_process_group_id: number };
				};
				if (info.foreground_process_group_id === info.shell_pid) return;
				await sleep(250);
			}
			throw new Error(`Timed out waiting for ${target} to exit Pi`);
		},
	};
}

export function herdr(args: string[], opts?: { machine?: string; timeoutMs?: number }): Promise<any> {
	return herdrImpl(args, opts);
}

export const WORKER_NAME = /^(?=.{2,12}$)[a-z][a-z0-9]*(-[a-z0-9]+)?$/;

export function validateWorkerName(name: string, label = "name"): void {
	if (!WORKER_NAME.test(name)) {
		throw new Error(`Bad ${label} "${name}": use short kebab-case, 1-2 words, ≤12 chars (e.g. gh-login, api-fix)`);
	}
}

export function expandCwd(cwd: string): string {
	if (cwd.startsWith("~/")) return `${process.env.HOME}${cwd.slice(1)}`;
	return cwd;
}

function resolvePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function workerModelArg(): string {
	return pickModel(parseModelChain(loadConfig().workerModels), { headroom: "new" });
}

function leadModelArg(): string {
	return pickModel(parseModelChain(loadConfig().leadModels), { headroom: "new" });
}

function modelChainForAgent(store: Store, agentName: string | undefined): string[] {
	if (agentName && store.isLeadName(agentName)) return parseModelChain(loadConfig().leadModels);
	return parseModelChain(loadConfig().workerModels);
}

function sessionPathOf(agent: HerdrAgent): string | undefined {
	const sess = agent.agent_session;
	if (!sess || sess.kind !== "path" || !sess.value) return undefined;
	return sess.value;
}

function modelInfoForAgent(agent: HerdrAgent): AgentModelInfo {
	if (agent.agent !== "pi") return { kind: "unknown" };
	const path = sessionPathOf(agent);
	return path ? agentModel(path) : { kind: "unknown" };
}

function outUntilLabel(info: AgentModelInfo): string {
	if (info.kind !== "pi" || !info.usageLimit) return "";
	const until = providerResetAt(info.provider);
	return until ? ` · OUT until ${formatQuotaUntil(until)}` : " · OUT";
}

export async function startWorker(p: { name: string; cwd: string; task: string }): Promise<string> {
	validateWorkerName(p.name, "worker name");
	const cwd = expandCwd(p.cwd.trim());
	const ws = await herdr(["workspace", "create", "--cwd", cwd, "--label", p.name, "--no-focus"]);
	const pane = ws.root_pane.pane_id as string;
	await herdr([
		"agent", "start", p.name, "--kind", "pi", "--pane", pane, "--timeout", "60000",
		"--", "--model", workerModelArg(),
	]);
	await herdr(["agent", "prompt", p.name, p.task]);
	return pane;
}

export async function assignLead(
	store: Store,
	p: { project: string; task: string; path?: string; via?: string },
): Promise<"started" | "running"> {
	validateWorkerName(p.project, "project name");
	const saved = store.getProject(p.project);
	let path = p.path ? expandCwd(p.path.trim()) : saved?.path;
	let status: "started" | "running" = "running";
	try {
		await herdr(["agent", "get", p.project]);
	} catch (e) {
		if (!isGoneError(e)) throw e;
		if (!path) throw new Error(`path is required the first time you assign lead "${p.project}"`);
		const wantPath = resolvePath(path);
		const { workspaces } = (await herdr(["workspace", "list"])) as {
			workspaces: { workspace_id: string; label?: string; worktree?: { checkout_path: string; is_linked_worktree?: boolean } }[];
		};
		let workspaceId = saved?.workspaceId;
		const match = workspaces.find(w => {
			const wt = w.worktree;
			return wt && !wt.is_linked_worktree && resolvePath(wt.checkout_path) === wantPath;
		}) ?? workspaces.find(w => w.label === p.project);
		if (match) workspaceId = match.workspace_id;
		else {
			const created = await herdr(["workspace", "create", "--cwd", path, "--label", p.project, "--no-focus"]);
			workspaceId = created.workspace.workspace_id as string;
		}
		if (!workspaceId) throw new Error(`Could not resolve workspace for lead "${p.project}"`);
		const tab = await herdr([
			"tab", "create", "--workspace", workspaceId, "--cwd", path, "--label", "lead",
			"--env", `PI_CHIEF_LEAD=${p.project}`, "--no-focus",
		]);
		const pane = tab.root_pane.pane_id as string;
		await herdr([
			"agent", "start", p.project, "--kind", "pi", "--pane", pane, "--timeout", "60000",
			"--", "--model", leadModelArg(),
		]);
		store.upsertProject(p.project, path, workspaceId);
		status = "started";
	}
	let context = "Task from chief";
	if (p.via === "telegram") context += " · Baha asked via Telegram";
	store.queueInbox(p.task, context, `lead:${p.project}`);
	return status;
}

export async function startWorktree(projectPath: string, p: { name: string; task: string }): Promise<string> {
	validateWorkerName(p.name, "worker name");
	const cwd = expandCwd(projectPath.trim());
	const repo = basename(cwd);
	const wtPath = join(homedir(), ".herdr", "worktrees", repo, p.name);
	const wt = await herdr([
		"worktree", "create", "--cwd", cwd, "--branch", p.name, "--path", wtPath, "--label", p.name, "--no-focus",
	]);
	const pane = wt.root_pane.pane_id as string;
	await herdr([
		"agent", "start", p.name, "--kind", "pi", "--pane", pane, "--timeout", "60000",
		"--", "--model", workerModelArg(),
	]);
	await herdr(["agent", "prompt", p.name, p.task]);
	return pane;
}

export async function resumeAgent(
	store: Store,
	p: {
		target: string;
		model?: string;
		message?: string;
		machine?: string;
		sendPrompt?: boolean;
		compactIfLarge?: boolean;
	},
): Promise<string> {
	const opts = p.machine ? { machine: p.machine } : undefined;
	const { agent } = (await herdr(["agent", "get", p.target], opts)) as { agent: HerdrAgent };
	if (agent.agent !== "pi") throw new Error(`resume_agent only supports Pi agents (got ${agent.agent})`);
	const name = agent.name ?? p.target;
	const sessionPath = sessionPathOf(agent);
	if (!sessionPath) throw new Error(`No Pi session path for ${p.target}`);
	const chain = modelChainForAgent(store, agent.name);
	const oldInfo = modelInfoForAgent(agent);
	const oldRef = oldInfo.kind === "pi" ? oldInfo.ref : "unknown";
	const model = p.model?.trim() || pickModel(chain, { headroom: "continue" });
	const { provider } = parseModelRef(model);
	if (!providerHasHeadroom(provider, "continue")) {
		const until = soonestRefill(chain);
		throw new Error(`No model with continuing headroom${until ? ` until ${formatQuotaUntil(until)}` : ""}`);
	}
	// A blocked agent is waiting on an approval/question UI; typing /quit there could answer it, so only resume settled agents.
	if (agent.agent_status !== "idle" && agent.agent_status !== "done") {
		throw new Error(`${name} is ${agent.agent_status}; resume_agent needs it idle or done`);
	}
	await resumeDeps.quitPi(p.target, opts);
	await resumeDeps.waitPiStopped(p.target, agent.pane_id, { ...opts, timeoutMs: 20_000 });
	const start = ["agent", "start", name, "--kind", "pi", "--pane", agent.pane_id, "--timeout", "60000", "--", "--session", sessionPath, "--model", model];
	for (let attempt = 0; ; attempt++) {
		try {
			await herdr(start, opts);
			break;
		} catch (e) {
			// Herdr can hold the old agent's name briefly after Pi exits.
			if (attempt >= 20 || !/agent_name_taken/.test((e as Error).message)) throw e;
			await sleep(250);
		}
	}
	let compacted = false;
	if (p.compactIfLarge && sessionContextTokens(sessionPath) > BIG_CONTEXT_TOKENS) {
		await herdr(["agent", "prompt", name, `/compact ${BRIDGE_COMPACT_INSTRUCTIONS}`], opts);
		await herdr(["agent", "wait", name, "--until", "idle", "--until", "done"], { ...opts, timeoutMs: 300_000 });
		compacted = true;
	}
	const msg =
		p.message?.trim() ||
		`Continue where you left off. (Resumed on ${model} because ${oldRef} ran out of quota${compacted ? ", context compacted" : ""}.)`;
	if (p.sendPrompt !== false) await herdr(["agent", "prompt", name, msg], opts);
	return `Resumed ${name} on ${model}.`;
}

function isGoneError(e: unknown): boolean {
	const m = (e as Error).message?.toLowerCase() ?? "";
	return /not_found|not found|agent_not_found/.test(m);
}

function isTransient(e: unknown): boolean {
	const m = (e as Error).message?.toLowerCase() ?? "";
	return /timeout|timed out|econn|network|temporarily|busy/.test(m);
}

export function fireMessage(target: string, label: string | null, status: string, via: string, extra = ""): string {
	const tail = via === "telegram" ? " with reply_baha" : "";
	return `[Herdr] worker ${target}${label ? ` (${label})` : ""} is now ${status}. Read its result with \`herdr agent read ${target} --source recent --lines 60\`, then report to Baha${tail} per your reporting rules.${extra}`;
}

const NEEDS_BIGGER_MODEL = /needs bigger model/i;

function bridgeWorkerName(ref: string): string {
	return parseModelRef(ref).provider.startsWith("minimax") ? "MiniMax" : ref;
}

async function workerNeedsBiggerModel(target: string, opts?: { machine?: string }): Promise<boolean> {
	try {
		const read = String(await herdr(["agent", "read", target, "--source", "recent", "--lines", "20"], opts));
		return NEEDS_BIGGER_MODEL.test(read);
	} catch {
		return false;
	}
}

async function tryQuotaResume(
	store: Store,
	w: WatchRow,
	agent: HerdrAgent,
	fire: (msg: string) => void,
	opts?: { machine?: string },
): Promise<boolean> {
	const info = modelInfoForAgent(agent);
	if (info.kind !== "pi" || !info.usageLimit) return false;
	markProviderExhausted(info.provider);
	const chain = modelChainForAgent(store, agent.name);
	const bridgeRef = bridgeModelRef(loadConfig().bridgeModel);
	const onBridge = bridgeAvailable(bridgeRef);
	let model: string;
	if (onBridge) model = bridgeRef;
	else {
		model = pickModel(chain, { headroom: "continue" });
		if (!providerHasHeadroom(parseModelRef(model).provider, "continue")) {
			const until = soonestRefill(chain);
			if (!until) return false;
			store.setWatchResumeAt(w.id, until);
			if (!w.quotaPauseNotified) {
				store.setWatchQuotaPauseNotified(w.id, true);
				fire(`[Herdr] worker ${w.label ?? w.target} paused: all worker models out until ${formatQuotaUntil(until)}; will resume automatically.`);
			}
			return true;
		}
	}
	const oldRef = info.ref;
	const name = agent.name ?? w.target;
	const sessionPath = sessionPathOf(agent);
	const bigContext = sessionPath ? sessionContextTokens(sessionPath) > BIG_CONTEXT_TOKENS : false;
	await resumeAgent(store, { target: w.target, model, machine: w.machine ?? undefined, sendPrompt: false });
	let compacted = false;
	if (onBridge && bigContext) {
		await herdr(["agent", "prompt", name, `/compact ${BRIDGE_COMPACT_INSTRUCTIONS}`], opts);
		await herdr(["agent", "wait", name, "--until", "idle", "--until", "done"], { ...opts, timeoutMs: 300_000 });
		compacted = true;
	}
	const continueMsg = onBridge
		? `Continue where you left off. (${oldRef} ran out of quota; you're on ${bridgeWorkerName(bridgeRef)}${compacted ? ", context compacted" : ""}. If the remaining work is heavy, stop and say "needs bigger model" in your final message.)`
		: `Continue where you left off. (Resumed on ${model} because ${oldRef} ran out of quota.)`;
	await herdr(["agent", "prompt", name, continueMsg], opts);
	store.resetWatchSawWorking(w.id);
	store.setWatchResumeAt(w.id, null);
	store.setWatchQuotaPauseNotified(w.id, false);
	fire(`[Herdr] worker ${w.label ?? w.target} hit the usage limit on ${oldRef}; resumed on ${model}.`);
	return true;
}

export async function tickWatch(store: Store, w: WatchRow, fire: (msg: string) => void): Promise<void> {
	const opts = w.machine ? { machine: w.machine } : undefined;
	const now = nowMs();
	if (w.resumeAt != null && now >= w.resumeAt) {
		try {
			await resumeAgent(store, { target: w.target, machine: w.machine ?? undefined });
			store.resetWatchSawWorking(w.id);
			store.setWatchResumeAt(w.id, null);
			store.setWatchQuotaPauseNotified(w.id, false);
			return;
		} catch (e) {
			if (!isTransient(e)) throw e;
			return;
		}
	}
	let agent: HerdrAgent;
	let status: string;
	try {
		({ agent } = (await herdr(["agent", "get", w.target], opts)) as { agent: HerdrAgent });
		status = String(agent.agent_status);
	} catch (e) {
		if (isGoneError(e)) {
			store.finishWatch(w.id);
			fire(fireMessage(w.target, w.label, "exited", w.via));
			return;
		}
		if (!isTransient(e)) throw e;
		return;
	}
	if (status === "working") {
		if (!w.sawWorking) store.setWatchSawWorking(w.id);
		return;
	}
	if (status === "blocked") {
		store.finishWatch(w.id);
		fire(fireMessage(w.target, w.label, status, w.via));
		return;
	}
	if (status === "idle" || status === "done") {
		const age = now - w.createdAt;
		if (w.sawWorking || age >= watchIdleMs) {
			if (await tryQuotaResume(store, w, agent, fire, opts)) return;
			store.finishWatch(w.id);
			let extra = "";
			if (await workerNeedsBiggerModel(w.target, opts)) {
				const chain = modelChainForAgent(store, agent.name);
				const bridgeRef = bridgeModelRef(loadConfig().bridgeModel);
				const bigger = nextBigModel(chain, bridgeRef);
				const agentName = agent.name ?? w.target;
				if (bigger) extra = ` It asked for a bigger model: resume_agent ${agentName} with ${bigger}.`;
			}
			fire(fireMessage(w.target, w.label, status, w.via, extra));
		}
	}
}

function snippet(read: string): string {
	const lines = read.split("\n").map(l => l.trim()).filter(Boolean);
	return lines.slice(-6).join(" ").slice(0, 300);
}

function leadWorkspaceAllowed(
	store: Store,
	leadProject: string,
	workspaceId: string,
	label: string | undefined,
	workspaces: { workspace_id: string; label?: string; worktree?: { checkout_path: string } }[],
): boolean {
	const proj = store.getProject(leadProject);
	const ws = workspaces.find(w => w.workspace_id === workspaceId);
	const wsLabel = label ?? ws?.label;
	if (wsLabel === leadProject) return true;
	if (proj?.workspaceId === workspaceId) return true;
	if (proj?.path && ws?.worktree?.checkout_path) {
		const prefix = join(homedir(), ".herdr", "worktrees", basename(proj.path)) + "/";
		if (ws.worktree.checkout_path.startsWith(prefix)) return true;
	}
	return false;
}

export async function agentsOverviewText(
	scope: { role: "chief" } | { role: "lead"; project: string },
	ownPane?: string,
	machine?: string,
	store?: Store,
): Promise<string> {
	const opts = machine ? { machine } : undefined;
	const { agents } = (await herdr(["agent", "list"], opts)) as { agents: HerdrAgent[] };
	const { workspaces } = (await herdr(["workspace", "list"], opts)) as {
		workspaces: { workspace_id: string; label?: string; worktree?: { checkout_path: string } }[];
	};
	const labels = new Map(workspaces.map(ws => [ws.workspace_id, ws.label ?? ws.workspace_id]));
	const lines: string[] = [];
	for (const a of agents) {
		if (a.pane_id === ownPane) continue;
		if (scope.role === "lead" && store && !leadWorkspaceAllowed(store, scope.project, a.workspace_id, labels.get(a.workspace_id), workspaces)) {
			continue;
		}
		const info = modelInfoForAgent(a);
		const model = formatModelLabel(info) + outUntilLabel(info);
		const kind = a.agent === "pi" ? model : a.agent;
		lines.push(`${labels.get(a.workspace_id) ?? a.workspace_id} / ${a.name ?? a.pane_id} · ${a.agent_status} · ${kind}`);
	}
	let body = lines.join("\n");
	const quota = quotaLine();
	const max = 2500 - quota.length - 2;
	if (body.length > max) body = body.slice(0, Math.max(0, max - 1)) + "…";
	return body ? `${body}\n${quota}` : quota;
}

export async function waitingAgentsText(
	ownPane?: string,
	machine?: string,
	reported: string[] = [],
): Promise<string> {
	const opts = machine ? { machine } : undefined;
	const { agents } = (await herdr(["agent", "list"], opts)) as { agents: HerdrAgent[] };
	const { workspaces } = (await herdr(["workspace", "list"], opts)) as { workspaces: { workspace_id: string; label?: string }[] };
	const labels = new Map(workspaces.map(ws => [ws.workspace_id, ws.label ?? ws.workspace_id]));
	const seen = new Set(reported);
	const waiting = agents.filter(a => a.pane_id !== ownPane &&
		(a.agent_status === "blocked" || (a.agent_status === "done" && !seen.has(a.pane_id) && !(a.name && seen.has(a.name)))));
	if (!waiting.length) return "Nothing is waiting on Baha.";
	const out: string[] = [];
	for (const a of waiting) {
		let snip: string;
		try {
			snip = snippet(await herdr(["agent", "read", a.pane_id, "--source", "recent", "--lines", "30"], opts));
		} catch {
			snip = "(unreadable)";
		}
		const model = formatModelLabel(modelInfoForAgent(a));
		out.push(`${labels.get(a.workspace_id) ?? a.workspace_id} / ${a.name ?? a.pane_id} (${a.agent_status}) · ${model}: ${snip}`);
		if (out.join("\n").length > 2000) break;
	}
	let text = out.join("\n");
	if (text.length > 2000) text = text.slice(0, 1999) + "…";
	return text;
}

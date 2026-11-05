import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const configDir = () => process.env.PI_CHIEF_CONFIG_DIR || join(homedir(), ".config", "pi-chief");
export const dataDir = () => process.env.PI_CHIEF_DATA_DIR || join(homedir(), ".local", "share", "pi-chief");
export const tokenFile = () => join(configDir(), "telegram-bot-token");
export const coreFiles = () => [join(dataDir(), "USER.md"), join(dataDir(), "PROJECTS.md")];

export function writePrivate(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	chmodSync(dirname(path), 0o700);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

export function readOptional(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
}

import { DEFAULT_BRIDGE_MODEL, DEFAULT_LEAD_MODELS, DEFAULT_WORKER_MODELS, validateModelChain } from "./models.ts";

export interface Config {
	/** Ovis base URL, e.g. https://host.tailnet.ts.net:8443/ */
	ovisBaseUrl: string;
	/** Ovis machine ID of the computer running the chief. */
	machineId: string;
	/** Your Telegram user ID; in a private bot chat this is also the chat ID. */
	telegramUserId: string;
	/** Comma-separated provider/model chain for chief and project leads. */
	leadModels: string;
	/** Comma-separated provider/model chain for Herdr workers. */
	workerModels: string;
	/** Bridge model used after a big model hits its usage limit. */
	bridgeModel: string;
}
const DEFAULTS: Config = {
	ovisBaseUrl: "",
	machineId: "",
	telegramUserId: "",
	leadModels: DEFAULT_LEAD_MODELS,
	workerModels: DEFAULT_WORKER_MODELS,
	bridgeModel: DEFAULT_BRIDGE_MODEL,
};
export const CONFIG_KEYS = Object.keys(DEFAULTS) as (keyof Config)[];

export function loadConfig(): Config {
	const raw = JSON.parse(readOptional(join(configDir(), "config.json")) ?? "{}");
	const config = { ...DEFAULTS };
	for (const key of CONFIG_KEYS) if (typeof raw[key] === "string") config[key] = raw[key];
	return config;
}

export function setConfig(key: string, value: string): void {
	if (!CONFIG_KEYS.includes(key as keyof Config)) throw new Error(`Unknown key ${key}; use one of ${CONFIG_KEYS.join(", ")}`);
	if (key === "ovisBaseUrl" && new URL(value).protocol !== "https:") throw new Error("ovisBaseUrl must be https");
	if (key === "telegramUserId" && !/^\d+$/.test(value)) throw new Error("telegramUserId must be numeric");
	if (key === "leadModels" || key === "workerModels") validateModelChain(value);
	if (key === "bridgeModel") validateModelChain(value);
	writePrivate(join(configDir(), "config.json"), JSON.stringify({ ...loadConfig(), [key]: value }, null, 2) + "\n");
}

export function readToken(): string | undefined {
	return readOptional(tokenFile())?.trim() || undefined;
}

export const validToken = (token: string) => /^\d+:[\w-]{30,}$/.test(token);

const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[\w-]{20,}|\bxox[baprs]-[\w-]{10,}|\bgh[pousr]_\w{20,}|\bAIza[\w-]{20,}|\bBearer\s+[\w.-]{20,}|\b\d{6,}:[\w-]{30,}/i;
export const looksLikeSecret = (text: string) => SECRET.test(text);

export function ovisLink(config: Config, workspace: string | null, pane: string | null): string | undefined {
	if (!config.ovisBaseUrl || !config.machineId || !workspace || !pane) return undefined;
	const url = new URL(config.ovisBaseUrl);
	url.search = new URLSearchParams({ machine: config.machineId, ws: workspace, pane, view: "chat" }).toString();
	return url.toString();
}

export interface Memory { id: number; text: string; createdAt: number }

export type QuestionStatus = "queued" | "sending" | "sent" | "answered" | "delivered" | "closed";
export interface Question {
	id: number;
	sessionId: string;
	workspace: string | null;
	pane: string | null;
	question: string;
	urgent: boolean;
	status: QuestionStatus;
	telegramMessageId: number | null;
	answer: string | null;
	expiresAt: number;
}

export interface Project {
	name: string;
	path: string;
	workspaceId: string;
}

export type VoiceJobState = "pending" | "processing" | "delivered" | "failed";
export interface VoiceReceiptContext {
	replyToMessageId?: number;
	quotedText?: string;
	openQuestionHint?: { id: number; question: string };
}
export interface VoiceJob {
	id: number;
	chatId: string;
	messageId: number;
	updateId: number;
	fileId: string;
	duration: number;
	fileSize: number | null;
	receiptContext: VoiceReceiptContext | null;
	state: VoiceJobState;
	attempts: number;
	leaseUntil: number | null;
	errorCode: string | null;
	createdAt: number;
}

export const VOICE_JOB_MAX_ATTEMPTS = 2;
export const VOICE_LEASE_MS = 240_000;
export const VOICE_QUEUE_CAP = 10;

const QUESTION_TTL_MS = 24 * 3600_000;
const MAX_OPEN_QUESTIONS = 3;
const OPEN = "('queued','sending','sent')";
const STOPWORDS = new Set("the and for with that this from have what when where which will would could should about into your you are was were been can not but all any our their there them then than also just like some more most make made want need please".split(" "));

export class Store {
	readonly db: DatabaseSync;

	private withTransaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			this.db.exec("COMMIT");
			return value;
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	constructor(dir = dataDir()) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		this.db = new DatabaseSync(join(dir, "chief.sqlite"));
		chmodSync(join(dir, "chief.sqlite"), 0o600);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS memories (
				id INTEGER PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER);
			CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, content='memories', content_rowid='id', tokenize='porter unicode61');
			CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
				INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text); END;
			CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
			CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
				INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
				INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text); END;
			CREATE TABLE IF NOT EXISTS questions (
				id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, workspace TEXT, pane TEXT,
				question TEXT NOT NULL, urgent INTEGER NOT NULL, status TEXT NOT NULL,
				telegram_message_id INTEGER, answer TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS inbox (
				id INTEGER PRIMARY KEY, text TEXT NOT NULL, context TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS outbox (
				id INTEGER PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS watches (
				id INTEGER PRIMARY KEY, target TEXT NOT NULL, machine TEXT, label TEXT, via TEXT NOT NULL,
				saw_working INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active');
			CREATE TABLE IF NOT EXISTS projects (
				name TEXT PRIMARY KEY, path TEXT NOT NULL, workspace_id TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS telegram_voice_jobs (
				id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, update_id INTEGER NOT NULL,
				file_id TEXT NOT NULL, duration INTEGER NOT NULL, file_size INTEGER, receipt_context TEXT,
				state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, error_code TEXT,
				created_at INTEGER NOT NULL, UNIQUE(chat_id, message_id));
		`);
		this.migrate();
	}

	private migrate(): void {
		const inboxCols = (this.db.prepare("PRAGMA table_info(inbox)").all() as { name: string }[]).map(c => c.name);
		if (!inboxCols.includes("recipient")) {
			this.db.exec("ALTER TABLE inbox ADD COLUMN recipient TEXT NOT NULL DEFAULT 'chief'");
		}
		const watchCols = (this.db.prepare("PRAGMA table_info(watches)").all() as { name: string }[]).map(c => c.name);
		if (!watchCols.includes("owner")) {
			this.db.exec("ALTER TABLE watches ADD COLUMN owner TEXT NOT NULL DEFAULT 'chief'");
		}
		if (!watchCols.includes("resume_at")) {
			this.db.exec("ALTER TABLE watches ADD COLUMN resume_at INTEGER");
		}
		if (!watchCols.includes("quota_pause_notified")) {
			this.db.exec("ALTER TABLE watches ADD COLUMN quota_pause_notified INTEGER NOT NULL DEFAULT 0");
		}
		const oldSession = this.get("chief_session");
		if (oldSession && !this.get("owner:chief")) this.set("owner:chief", oldSession);
		const oldSeen = this.get("chief_seen");
		if (oldSeen && !this.get("seen:chief")) this.set("seen:chief", oldSeen);
		const oldState = this.get("chief_state");
		if (oldState && !this.get("state:chief")) this.set("state:chief", oldState);
	}

	close(): void {
		this.db.close();
	}

	get(key: string): string | undefined {
		return (this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
	}

	set(key: string, value: string): void {
		this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
	}

	remove(key: string): void {
		this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
	}

	ownerKey(recipient: string): string {
		return `owner:${recipient}`;
	}

	seenKey(recipient: string): string {
		return `seen:${recipient}`;
	}

	stateKey(recipient: string): string {
		return `state:${recipient}`;
	}

	remember(text: string, expiresAt: number | null = null): number {
		return Number(this.db.prepare("INSERT INTO memories (text, created_at, expires_at) VALUES (?, ?, ?)").run(text, Date.now(), expiresAt).lastInsertRowid);
	}

	replace(id: number, text: string): boolean {
		return this.db.prepare("UPDATE memories SET text = ? WHERE id = ?").run(text, id).changes > 0;
	}

	forget(id: number): boolean {
		return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
	}

	/** Full-text search over live memories; recent memories when the query has no useful words. */
	recall(query = "", limit = 5): Memory[] {
		const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter(w => !STOPWORDS.has(w)).slice(0, 16);
		const live = "(m.expires_at IS NULL OR m.expires_at > ?)";
		const rows = words.length
			? this.db.prepare(`SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
				WHERE memories_fts MATCH ? AND ${live} ORDER BY rank LIMIT ?`).all(words.map(w => `"${w}"`).join(" OR "), Date.now(), limit)
			: this.db.prepare(`SELECT m.* FROM memories m WHERE ${live} ORDER BY id DESC LIMIT ?`).all(Date.now(), limit);
		return (rows as any[]).map(r => ({ id: r.id, text: r.text, createdAt: r.created_at }));
	}

	ask(input: { sessionId: string; workspace?: string; pane?: string; question: string; urgent: boolean }): { id: number; created: boolean } {
		const open = this.openQuestions(input.sessionId);
		const same = open.find(q => q.question === input.question);
		if (same) return { id: same.id, created: false };
		if (open.length >= MAX_OPEN_QUESTIONS) throw new Error(`${open.length} questions are already open; wait for answers or close one with ask_baha_close`);
		const now = Date.now();
		const id = this.db.prepare(`INSERT INTO questions (session_id, workspace, pane, question, urgent, status, created_at, expires_at)
			VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`).run(input.sessionId, input.workspace ?? null, input.pane ?? null, input.question, input.urgent ? 1 : 0, now, now + QUESTION_TTL_MS).lastInsertRowid;
		return { id: Number(id), created: true };
	}

	question(id: number): Question | undefined {
		const row = this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id);
		return row ? toQuestion(row) : undefined;
	}

	openQuestions(sessionId?: string): Question[] {
		const rows = sessionId
			? this.db.prepare(`SELECT * FROM questions WHERE status IN ${OPEN} AND expires_at > ? AND session_id = ? ORDER BY id`).all(Date.now(), sessionId)
			: this.db.prepare(`SELECT * FROM questions WHERE status IN ${OPEN} AND expires_at > ? ORDER BY id`).all(Date.now());
		return rows.map(toQuestion);
	}

	closeQuestion(id: number, sessionId: string): boolean {
		return this.db.prepare(`UPDATE questions SET status = 'closed' WHERE id = ? AND session_id = ? AND status IN ${OPEN}`).run(id, sessionId).changes > 0;
	}

	/** Atomically claims queued questions for sending, so concurrent workers never double-send. */
	claimQueued(): Question[] {
		const rows = this.db.prepare("SELECT * FROM questions WHERE status = 'queued' AND expires_at > ? ORDER BY id").all(Date.now()).map(toQuestion);
		return rows.filter(q => this.db.prepare("UPDATE questions SET status = 'sending' WHERE id = ? AND status = 'queued'").run(q.id).changes > 0);
	}

	markSent(id: number, telegramMessageId: number): void {
		this.db.prepare("UPDATE questions SET status = 'sent', telegram_message_id = ? WHERE id = ? AND status = 'sending'").run(telegramMessageId, id);
	}

	/** A worker that died mid-send leaves 'sending' rows; resending risks a duplicate message, never a lost question. */
	requeueSending(id?: number): void {
		if (id === undefined) {
			this.db.prepare("UPDATE questions SET status = 'queued' WHERE status = 'sending'").run();
			this.db.prepare("UPDATE outbox SET status = 'queued' WHERE status = 'sending'").run();
		} else this.db.prepare("UPDATE questions SET status = 'queued' WHERE id = ? AND status = 'sending'").run(id);
	}

	requeueOutbox(id: number): void {
		this.db.prepare("UPDATE outbox SET status = 'queued' WHERE id = ? AND status = 'sending'").run(id);
	}

	answer(telegramMessageId: number, text: string): number | undefined {
		const row = this.db.prepare(`UPDATE questions SET status = 'answered', answer = ?
			WHERE telegram_message_id = ? AND status = 'sent' AND expires_at > ? RETURNING id`).get(text, telegramMessageId, Date.now()) as { id: number } | undefined;
		return row?.id;
	}

	/** Marks a session's answered questions delivered and returns them (at most once). */
	takeAnswers(sessionId: string): Question[] {
		return this.db.prepare("UPDATE questions SET status = 'delivered' WHERE session_id = ? AND status = 'answered' RETURNING *").all(sessionId).map(toQuestion);
	}

	questionByTelegramMessageId(messageId: number): Question | undefined {
		const row = this.db.prepare("SELECT * FROM questions WHERE telegram_message_id = ?").get(messageId);
		return row ? toQuestion(row) : undefined;
	}

	queueInbox(text: string, context?: string, recipient = "chief"): number {
		return Number(this.db.prepare(
			"INSERT INTO inbox (text, context, status, created_at, recipient) VALUES (?, ?, 'queued', ?, ?)",
		).run(text, context ?? null, Date.now(), recipient).lastInsertRowid);
	}

	takeInbox(recipient: string): { id: number; text: string; context: string | null; createdAt: number }[] {
		return (this.db.prepare(
			"UPDATE inbox SET status = 'delivered' WHERE status = 'queued' AND recipient = ? RETURNING id, text, context, created_at",
		).all(recipient) as any[])
			.map(r => ({ id: r.id, text: r.text, context: r.context, createdAt: r.created_at }))
			.sort((a, b) => a.id - b.id);
	}

	countInboxQueued(recipient = "chief"): number {
		return (this.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE status = 'queued' AND recipient = ?").get(recipient) as { n: number }).n;
	}

	queueOutbox(text: string): number {
		return Number(this.db.prepare("INSERT INTO outbox (text, status, created_at) VALUES (?, 'queued', ?)").run(text, Date.now()).lastInsertRowid);
	}

	claimOutbox(): { id: number; text: string }[] {
		const rows = this.db.prepare("SELECT id, text FROM outbox WHERE status = 'queued' ORDER BY id").all() as { id: number; text: string }[];
		return rows.filter(r => this.db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ? AND status = 'queued'").run(r.id).changes > 0);
	}

	markOutboxSent(id: number): void {
		this.db.prepare("UPDATE outbox SET status = 'sent' WHERE id = ? AND status = 'sending'").run(id);
	}

	upsertProject(name: string, path: string, workspaceId: string): void {
		this.db.prepare(
			"INSERT INTO projects (name, path, workspace_id) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET path = excluded.path, workspace_id = excluded.workspace_id",
		).run(name, path, workspaceId);
	}

	getProject(name: string): Project | undefined {
		const row = this.db.prepare("SELECT name, path, workspace_id FROM projects WHERE name = ?").get(name) as
			{ name: string; path: string; workspace_id: string } | undefined;
		return row ? { name: row.name, path: row.path, workspaceId: row.workspace_id } : undefined;
	}

	addWatch(input: { target: string; machine?: string; label?: string; via: string; owner: string; createdAt?: number }): number {
		const createdAt = input.createdAt ?? Date.now();
		return Number(this.db.prepare(
			"INSERT INTO watches (target, machine, label, via, saw_working, created_at, status, owner) VALUES (?, ?, ?, ?, 0, ?, 'active', ?)",
		).run(input.target, input.machine ?? null, input.label ?? null, input.via, createdAt, input.owner).lastInsertRowid);
	}

	activeWatches(owner?: string): {
		id: number; target: string; machine: string | null; label: string | null; via: string;
		sawWorking: boolean; createdAt: number; owner: string; resumeAt: number | null; quotaPauseNotified: boolean;
	}[] {
		const rows = owner
			? (this.db.prepare("SELECT * FROM watches WHERE status = 'active' AND owner = ? ORDER BY id").all(owner) as any[])
			: (this.db.prepare("SELECT * FROM watches WHERE status = 'active' ORDER BY id").all() as any[]);
		return rows.map(r => ({
			id: r.id, target: r.target, machine: r.machine, label: r.label, via: r.via,
			sawWorking: r.saw_working === 1, createdAt: r.created_at, owner: r.owner ?? "chief",
			resumeAt: r.resume_at == null ? null : Number(r.resume_at),
			quotaPauseNotified: r.quota_pause_notified === 1,
		}));
	}

	setWatchSawWorking(id: number): void {
		this.db.prepare("UPDATE watches SET saw_working = 1 WHERE id = ? AND status = 'active'").run(id);
	}

	resetWatchSawWorking(id: number): void {
		this.db.prepare("UPDATE watches SET saw_working = 0 WHERE id = ? AND status = 'active'").run(id);
	}

	setWatchResumeAt(id: number, resumeAt: number | null): void {
		this.db.prepare("UPDATE watches SET resume_at = ? WHERE id = ? AND status = 'active'").run(resumeAt, id);
	}

	setWatchQuotaPauseNotified(id: number, notified: boolean): void {
		this.db.prepare("UPDATE watches SET quota_pause_notified = ? WHERE id = ? AND status = 'active'").run(notified ? 1 : 0, id);
	}

	isLeadName(name: string): boolean {
		return Boolean(this.getProject(name));
	}

	finishWatch(id: number): void {
		this.db.prepare("UPDATE watches SET status = 'done' WHERE id = ? AND status = 'active'").run(id);
	}

	/** Agents a "done" status shouldn't flag: workers already reported, and durable project leads (done after every turn). */
	reportedTargets(): string[] {
		return (this.db.prepare("SELECT target FROM watches WHERE status = 'done' UNION SELECT name FROM projects").all() as { target: string }[]).map(r => r.target);
	}

	countVoiceQueue(): number {
		return (this.db.prepare(
			"SELECT COUNT(*) AS n FROM telegram_voice_jobs WHERE state IN ('pending','processing')",
		).get() as { n: number }).n;
	}

	private advanceTelegramOffset(offset: number): void {
		const cur = Number(this.get("telegram_offset") ?? 0);
		if (offset > cur) this.set("telegram_offset", String(offset));
	}

	/** Advance persisted getUpdates offset without enqueueing work (e.g. rejected voice). */
	recordTelegramUpdate(updateId: number): void {
		this.advanceTelegramOffset(updateId);
	}

	/** Atomically records the update offset and enqueues a voice job (or returns duplicate / queue full). */
	acceptVoiceJob(input: {
		chatId: string;
		messageId: number;
		updateId: number;
		fileId: string;
		duration: number;
		fileSize: number | null;
		receiptContext: VoiceReceiptContext;
	}): { ok: true; jobId: number; duplicate: boolean } | { ok: false; code: "VOICE_QUEUE_FULL" } {
		return this.withTransaction(() => {
			this.advanceTelegramOffset(input.updateId);
			const existing = this.db.prepare(
				"SELECT id FROM telegram_voice_jobs WHERE chat_id = ? AND message_id = ?",
			).get(input.chatId, input.messageId) as { id: number } | undefined;
			if (existing) return { ok: true as const, jobId: existing.id, duplicate: true };
			if (this.countVoiceQueue() >= VOICE_QUEUE_CAP) return { ok: false as const, code: "VOICE_QUEUE_FULL" as const };
			const id = this.db.prepare(
				`INSERT INTO telegram_voice_jobs (chat_id, message_id, update_id, file_id, duration, file_size, receipt_context, state, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
			).run(
				input.chatId, input.messageId, input.updateId, input.fileId, input.duration, input.fileSize,
				JSON.stringify(input.receiptContext), Date.now(),
			).lastInsertRowid;
			return { ok: true as const, jobId: Number(id), duplicate: false };
		});
	}

	recoverExpiredVoiceLeases(now = Date.now()): void {
		const expired = this.db.prepare(
			"SELECT * FROM telegram_voice_jobs WHERE state = 'processing' AND lease_until IS NOT NULL AND lease_until < ?",
		).all(now) as any[];
		for (const row of expired) {
			if (row.attempts >= VOICE_JOB_MAX_ATTEMPTS) {
				this.db.prepare(
					"UPDATE telegram_voice_jobs SET state = 'failed', error_code = 'VOICE_ATTEMPTS_EXCEEDED', lease_until = NULL WHERE id = ? AND state = 'processing'",
				).run(row.id);
			} else {
				this.db.prepare(
					"UPDATE telegram_voice_jobs SET state = 'pending', lease_until = NULL WHERE id = ? AND state = 'processing'",
				).run(row.id);
			}
		}
	}

	claimVoiceJob(now = Date.now()): VoiceJob | undefined {
		const row = this.db.prepare(
			"SELECT * FROM telegram_voice_jobs WHERE state = 'pending' ORDER BY id LIMIT 1",
		).get() as any;
		if (!row) return undefined;
		const leaseUntil = now + VOICE_LEASE_MS;
		const ok = this.db.prepare(
			"UPDATE telegram_voice_jobs SET state = 'processing', attempts = attempts + 1, lease_until = ? WHERE id = ? AND state = 'pending'",
		).run(leaseUntil, row.id).changes > 0;
		return ok ? toVoiceJob({ ...row, state: "processing", attempts: row.attempts + 1, lease_until: leaseUntil }) : undefined;
	}

	voiceJob(id: number): VoiceJob | undefined {
		const row = this.db.prepare("SELECT * FROM telegram_voice_jobs WHERE id = ?").get(id);
		return row ? toVoiceJob(row) : undefined;
	}

	failVoiceJob(id: number, errorCode: string): boolean {
		return this.db.prepare(
			"UPDATE telegram_voice_jobs SET state = 'failed', error_code = ?, lease_until = NULL WHERE id = ? AND state = 'processing'",
		).run(errorCode, id).changes > 0;
	}

	requeueVoiceJob(id: number): boolean {
		const job = this.voiceJob(id);
		if (!job || job.state !== "processing") return false;
		if (job.attempts >= VOICE_JOB_MAX_ATTEMPTS) return this.failVoiceJob(id, "VOICE_ATTEMPTS_EXCEEDED");
		return this.db.prepare(
			"UPDATE telegram_voice_jobs SET state = 'pending', lease_until = NULL WHERE id = ? AND state = 'processing'",
		).run(id).changes > 0;
	}

	/** Routes transcript once and marks the job delivered. Returns user-facing ack text if any. */
	completeVoiceJob(id: number, transcript: string, route: (ctx: VoiceReceiptContext, text: string) => string | undefined): string | undefined {
		return this.withTransaction(() => {
			const row = this.db.prepare(
				"SELECT * FROM telegram_voice_jobs WHERE id = ? AND state = 'processing'",
			).get(id) as any;
			if (!row) return undefined;
			const ctx = row.receipt_context ? JSON.parse(row.receipt_context) as VoiceReceiptContext : {};
			const ack = route(ctx, transcript);
			this.db.prepare(
				"UPDATE telegram_voice_jobs SET state = 'delivered', lease_until = NULL, error_code = NULL WHERE id = ? AND state = 'processing'",
			).run(id);
			return ack;
		});
	}
}

function toQuestion(r: any): Question {
	return {
		id: r.id, sessionId: r.session_id, workspace: r.workspace, pane: r.pane, question: r.question, urgent: r.urgent === 1,
		status: r.status, telegramMessageId: r.telegram_message_id, answer: r.answer, expiresAt: r.expires_at,
	};
}

function toVoiceJob(r: any): VoiceJob {
	return {
		id: r.id, chatId: r.chat_id, messageId: r.message_id, updateId: r.update_id, fileId: r.file_id,
		duration: r.duration, fileSize: r.file_size == null ? null : Number(r.file_size),
		receiptContext: r.receipt_context ? JSON.parse(r.receipt_context) : null,
		state: r.state, attempts: r.attempts, leaseUntil: r.lease_until == null ? null : Number(r.lease_until),
		errorCode: r.error_code, createdAt: r.created_at,
	};
}

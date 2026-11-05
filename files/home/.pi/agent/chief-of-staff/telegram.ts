import { setTimeout as sleep } from "node:timers/promises";
import { type Config, type Question, type VoiceReceiptContext, Store, ovisLink } from "./store.ts";
import { quotaLine } from "./models.ts";
import {
	VOICE_MAX_BYTES,
	VOICE_MAX_DURATION_SEC,
	transcribeVoiceJob,
	voiceEngineAvailable,
	voiceErrorCode,
	type VoiceDeps,
} from "./voice.ts";

export class TelegramError extends Error {
	readonly code: number | undefined;
	constructor(method: string, code: number | undefined, description: string) {
		super(`${method}: ${description}`);
		this.code = code;
	}
}

export type Api = (method: string, body: object, timeoutMs?: number) => Promise<any>;

export function telegramApi(token: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Api {
	return async (method, body, timeoutMs = 15_000) => {
		const timeout = AbortSignal.timeout(timeoutMs);
		let res: Response;
		try {
			res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch (e) {
			throw new TelegramError(method, undefined, (e as Error).name === "TimeoutError" ? "timed out" : "network error");
		}
		const json = await res.json().catch(() => ({}));
		if (!json.ok) throw new TelegramError(method, json.error_code ?? res.status, json.description ?? `HTTP ${res.status}`);
		return json.result;
	};
}

export function questionMessage(config: Config, q: Question): object {
	const link = ovisLink(config, q.workspace, q.pane);
	return {
		chat_id: config.telegramUserId,
		text: `${q.urgent ? "❗ " : ""}Chief question #${q.id}\n\n${q.question}\n\nReply to this message to answer.`,
		disable_notification: !q.urgent,
		link_preview_options: { is_disabled: true },
		...(link && { reply_markup: { inline_keyboard: [[{ text: "Open in Ovis", url: link }]] } }),
	};
}

export interface TelegramVoice {
	file_id: string;
	duration: number;
	mime_type?: string;
	file_size?: number;
}

export interface Message {
	message_id: number;
	chat: { id: number; type: string };
	from?: { id: number };
	text?: string;
	voice?: TelegramVoice;
	reply_to_message?: { message_id: number; text?: string };
}

const CHIEF_ONLINE_MS = 30_000;
const VOICE_PROVENANCE = "(Transcribed voice; may mishear)\n\n";
const VOICE_ACK_LIMIT = 3900;

function quotedVoiceAcks(text: string): string[] {
	const points = Array.from(text);
	const single = `“${text}”`;
	if (single.length <= VOICE_ACK_LIMIT) return [single];
	const chunks: string[] = [];
	let current = "";
	for (const point of points) {
		if ((current + point).length > VOICE_ACK_LIMIT - 32 && current) {
			chunks.push(current);
			current = "";
		}
		current += point;
	}
	if (current) chunks.push(current);
	return chunks.map((chunk, index) => `(${index + 1}/${chunks.length}) “${chunk}”`);
}

function authorizedUser(config: Config, msg: Message | undefined): msg is Message {
	const me = config.telegramUserId;
	return Boolean(msg && msg.chat.type === "private" && String(msg.chat.id) === me && String(msg.from?.id) === me);
}

function chiefOnline(store: Store): boolean {
	return Date.now() - Number(store.get(store.seenKey("chief")) ?? 0) <= CHIEF_ONLINE_MS;
}

function inboxAck(store: Store): string {
	if (!chiefOnline(store)) return "✓ Queued; chief is offline and will see it when it starts.";
	if (store.get(store.stateKey("chief")) === "working") return "✓ Queued; chief will see it after the current task.";
	return "✓ Sent to chief.";
}

export function statusLine(store: Store): string {
	const seen = Number(store.get(store.seenKey("chief")) ?? 0);
	const chief = chiefOnline(store) ? "online" : seen ? `offline, last seen ${Math.round((Date.now() - seen) / 60_000)}m ago` : "offline, never seen";
	const state = store.get(store.stateKey("chief")) === "working" ? "working" : "idle";
	const open = store.openQuestions().filter(q => q.status === "sent").length;
	const inbox = store.countInboxQueued();
	const voiceQ = store.countVoiceQueue();
	return `Chief ${chief}, ${state}; ${open} open question(s); ${inbox} queued inbox message(s); ${voiceQ} voice job(s) queued.`;
}

function handleBotCommand(config: Config, store: Store, text: string): string | undefined {
	if (text.startsWith("/start")) return "Chief is connected. Text or voice message the chief; reply to a question to answer it. /status shows whether it's online.";
	if (text.startsWith("/status")) return `${statusLine(store)} ${quotaLine()}`;
	return undefined;
}

export function voiceReceiptContext(store: Store, msg: Message): VoiceReceiptContext {
	const replyTo = msg.reply_to_message?.message_id;
	const waiting = store.openQuestions().filter(q => q.status === "sent");
	return {
		...(replyTo !== undefined && { replyToMessageId: replyTo }),
		...(msg.reply_to_message?.text && { quotedText: msg.reply_to_message.text.slice(0, 200) }),
		...(waiting.length === 1 && { openQuestionHint: { id: waiting[0].id, question: waiting[0].question } }),
	};
}

/** Routes user text; bot commands only when isTypedCommand is true (plain text messages). */
export function routeConversationText(
	config: Config,
	store: Store,
	text: string,
	ctx: VoiceReceiptContext,
	opts: { isTypedCommand?: boolean; transcribedVoice?: boolean } = {},
): string | undefined {
	const body = opts.transcribedVoice ? VOICE_PROVENANCE + text : text;
	if (opts.isTypedCommand) {
		const cmd = handleBotCommand(config, store, text.trim());
		if (cmd) return cmd;
	}
	const replyTo = ctx.replyToMessageId;
	if (replyTo !== undefined) {
		const q = store.questionByTelegramMessageId(replyTo);
		if (q && q.status === "sent") {
			const id = store.answer(replyTo, body);
			return id ? `✓ Sent to chief (#${id}).` : "That question is already closed or expired.";
		}
		if (q) return "That question is already closed or expired.";
		const quoted = ctx.quotedText;
		const context = quoted ? `Replying to: "${quoted}"` : undefined;
		store.queueInbox(body, context, "chief");
		return inboxAck(store);
	}
	let context: string | undefined;
	if (ctx.openQuestionHint) {
		const q = store.question(ctx.openQuestionHint.id);
		if (q && q.status === "sent") {
			context = `Question #${q.id} ("${q.question}") is open; if this answers it, call ask_baha_close.`;
		}
	}
	store.queueInbox(body, context, "chief");
	return inboxAck(store);
}

export function handleMessage(config: Config, store: Store, msg: Message | undefined): string | undefined {
	if (!authorizedUser(config, msg)) return undefined;
	if (msg.voice) return undefined;
	if (!msg.text) return "Only text and voice messages are supported.";
	return routeConversationText(config, store, msg.text, voiceReceiptContext(store, msg), { isTypedCommand: true });
}

function voiceMetaError(voice: TelegramVoice): string | undefined {
	if (voice.duration > VOICE_MAX_DURATION_SEC) return "Voice too long (max 120s).";
	if (voice.file_size != null && voice.file_size > VOICE_MAX_BYTES) return "Voice file too large (max 10 MiB).";
	if (voice.mime_type && !voice.mime_type.includes("ogg") && voice.mime_type !== "audio/opus") return "Voice must be OGG Opus.";
	return undefined;
}

export function acceptVoiceMessage(
	config: Config,
	store: Store,
	updateId: number,
	msg: Message,
	voiceDeps: VoiceDeps = {},
): string | undefined {
	if (!authorizedUser(config, msg) || !msg.voice) return undefined;
	const nextOffset = updateId + 1;
	const metaErr = voiceMetaError(msg.voice);
	if (metaErr) {
		store.recordTelegramUpdate(nextOffset);
		return metaErr;
	}
	if (!voiceEngineAvailable(voiceDeps)) {
		store.recordTelegramUpdate(nextOffset);
		return "Voice transcription is unavailable on this machine (local Whisper not ready).";
	}
	const accepted = store.acceptVoiceJob({
		chatId: String(msg.chat.id),
		messageId: msg.message_id,
		updateId: nextOffset,
		fileId: msg.voice.file_id,
		duration: msg.voice.duration,
		fileSize: msg.voice.file_size ?? null,
		receiptContext: voiceReceiptContext(store, msg),
	});
	if (!accepted.ok) return "Voice queue is full (10 pending). Try again shortly.";
	if (accepted.duplicate) return undefined;
	return "✓ Voice accepted; transcribing…";
}

export async function sendQueued(config: Config, store: Store, api: Api, log = console.error): Promise<void> {
	for (const q of store.claimQueued()) {
		try {
			const sent = await api("sendMessage", questionMessage(config, q));
			store.markSent(q.id, sent.message_id);
		} catch (e) {
			store.requeueSending(q.id);
			log(`question #${q.id} not sent: ${(e as Error).message}`);
		}
	}
}

export async function sendOutbox(config: Config, store: Store, api: Api, log = console.error): Promise<void> {
	for (const row of store.claimOutbox()) {
		try {
			let text = row.text;
			if (text.length > 4000) text = text.slice(0, 3999) + "…";
			await api("sendMessage", { chat_id: config.telegramUserId, text, disable_notification: false });
			store.markOutboxSent(row.id);
		} catch (e) {
			store.requeueOutbox(row.id);
			log(`outbox #${row.id} not sent: ${(e as Error).message}`);
		}
	}
}

async function sendPass(config: Config, store: Store, api: Api, log: (s: string) => void): Promise<void> {
	try {
		store.set("worker_seen", String(Date.now()));
		await sendQueued(config, store, api, log);
		await sendOutbox(config, store, api, log);
	} catch (e) {
		log(`send pass failed: ${(e as Error).message}`);
	}
}

export async function processVoiceJob(opts: {
	config: Config;
	store: Store;
	api: Api;
	token: string;
	log?: (s: string) => void;
	voiceDeps?: VoiceDeps;
}): Promise<boolean> {
	const { config, store, api, token, log = console.error, voiceDeps = {} } = opts;
	store.recoverExpiredVoiceLeases();
	const job = store.claimVoiceJob();
	if (!job) return false;
	try {
		const result = await transcribeVoiceJob(api, token, job.fileId, job.duration, job.fileSize, voiceDeps);
		const ack = store.completeVoiceJob(job.id, result.text, (ctx, text) =>
			routeConversationText(config, store, text, ctx, { transcribedVoice: true }),
		);
		if (ack) {
			if (ack === "That question is already closed or expired.") store.queueOutbox(ack);
			else for (const quoted of quotedVoiceAcks(result.text)) store.queueOutbox(quoted);
		}
	} catch (e) {
		const code = voiceErrorCode(e);
		if (job.attempts < 2 && (code === "VOICE_DOWNLOAD_FAILED" || code === "VOICE_STT_FAILED")) {
			store.requeueVoiceJob(job.id);
		} else {
			store.failVoiceJob(job.id, code);
			store.queueOutbox(code === "VOICE_NO_SPEECH" ? "No speech detected." : `Voice transcription failed (${code}).`);
		}
		log(`voice job #${job.id}: ${code}`);
	}
	return true;
}

export async function runVoiceConsumer(opts: {
	config: Config;
	store: Store;
	api: Api;
	token: string;
	signal?: AbortSignal;
	log?: (s: string) => void;
	voiceDeps?: VoiceDeps;
}): Promise<void> {
	const { config, store, api, token, signal, log = console.error, voiceDeps = {} } = opts;
	while (!signal?.aborted) {
		const worked = await processVoiceJob({ config, store, api, token, log, voiceDeps });
		if (!worked) await sleep(500, undefined, { signal }).catch(() => {});
	}
}

/** Sends queued questions/messages every 2s while long-polling for Baha's messages. Exits on abort or a fatal poll error. */
export async function runWorker(opts: {
	config: Config;
	store: Store;
	api: Api;
	token?: string;
	once?: boolean;
	signal?: AbortSignal;
	log?: (s: string) => void;
	voiceDeps?: VoiceDeps;
}): Promise<void> {
	const { config, store, api, once, signal, log = console.error, voiceDeps = {}, token = "" } = opts;
	store.requeueSending();
	store.recoverExpiredVoiceLeases();
	let offset = Number(store.get("telegram_offset") ?? 0);
	const pollDone = new AbortController();
	const stopped = signal ? AbortSignal.any([signal, pollDone.signal]) : pollDone.signal;
	const sendLoop = async () => {
		while (!stopped.aborted) {
			await sendPass(config, store, api, log);
			await sleep(2000, undefined, { signal: stopped }).catch(() => {});
		}
	};
	const pollLoop = async () => {
		while (!signal?.aborted) {
			let updates: { update_id: number; message?: Message }[];
			try {
				updates = await api("getUpdates", { offset, timeout: once ? 0 : 25, allowed_updates: ["message"] }, 35_000);
			} catch (e) {
				if (signal?.aborted) return;
				if (e instanceof TelegramError && e.code === 409) throw new Error("Another process is polling this bot (or a webhook is set). Stop it first.");
				if (e instanceof TelegramError && e.code === 401) throw new Error("Telegram rejected the bot token. Run: pi-chief token");
				log((e as Error).message);
				if (once) return;
				await sleep(5000, undefined, { signal }).catch(() => {});
				continue;
			}
			for (const update of updates) {
				offset = update.update_id + 1;
				const msg = update.message;
				let reply: string | undefined;
				if (msg?.voice) reply = acceptVoiceMessage(config, store, update.update_id, msg, voiceDeps);
				else {
					store.set("telegram_offset", String(offset));
					reply = handleMessage(config, store, msg);
				}
				if (reply && msg) {
					await api("sendMessage", {
						chat_id: config.telegramUserId,
						text: reply,
						reply_parameters: { message_id: msg.message_id },
					}).catch(e => log(e.message));
				}
			}
			if (once) return;
		}
	};
	if (once) {
		await sendPass(config, store, api, log);
		await pollLoop();
		if (token) {
			while (await processVoiceJob({ config, store, api, token, log, voiceDeps })) {}
		}
		return;
	}
	const voiceLoop = token
		? runVoiceConsumer({ config, store, api, token, signal: stopped, log, voiceDeps })
		: Promise.resolve();
	await Promise.all([sendLoop(), voiceLoop, pollLoop().finally(() => pollDone.abort())]);
}

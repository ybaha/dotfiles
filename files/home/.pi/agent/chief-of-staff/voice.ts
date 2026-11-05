import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { chmodSync, constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type VoiceApi = (method: string, body: object, timeoutMs?: number) => Promise<any>;

export const VOICE_MAX_DURATION_SEC = 120;
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
export const VOICE_MAX_QUEUE = 10;
export const VOICE_NETWORK_TIMEOUT_MS = 20_000;
export const VOICE_PROBE_TIMEOUT_MS = 15_000;
export const VOICE_STT_TIMEOUT_MS = 180_000;
export const VOICE_ACTIVITY_TIMEOUT_MS = 17_000;
export const VOICE_ACTIVITY_MAX_BYTES = VOICE_MAX_DURATION_SEC * 16_000 * 4;
export const VOICE_DOWNLOAD_ATTEMPTS = 2;

export type VoiceErrorCode =
	| "VOICE_QUEUE_FULL"
	| "VOICE_TOO_LONG"
	| "VOICE_TOO_LARGE"
	| "VOICE_BAD_FORMAT"
	| "VOICE_DOWNLOAD_FAILED"
	| "VOICE_PROBE_FAILED"
	| "VOICE_STT_FAILED"
	| "VOICE_ACTIVITY_FAILED"
	| "VOICE_NO_SPEECH"
	| "VOICE_EMPTY"
	| "VOICE_RESULT_TOO_LARGE"
	| "VOICE_UNAVAILABLE"
	| "VOICE_ATTEMPTS_EXCEEDED";

export interface VoiceTranscribeResult {
	text: string;
	language: string;
}

export interface VoiceDeps {
	fetchImpl?: typeof fetch;
	downloadFile?: (api: VoiceApi, fileId: string, destPath: string, maxBytes: number) => Promise<void>;
	probeAudio?: (path: string) => Promise<{ durationSec: number; codec: string; format: string }>;
	runStt?: (audioPath: string) => Promise<VoiceTranscribeResult>;
	whisperCheckpoint?: string;
	pythonPath?: string;
	transcribeScript?: string;
	activityScript?: string;
	ffmpegPath?: string;
	checkActivity?: (path: string) => Promise<boolean>;
	tempRoot?: string;
}

let defaultDeps: VoiceDeps | null = null;

export function setVoiceDeps(deps: VoiceDeps | null): void {
	defaultDeps = deps;
}

function resolveDeps(): Required<Omit<VoiceDeps, "fetchImpl" | "downloadFile" | "probeAudio" | "runStt" | "checkActivity">> & VoiceDeps {
	const home = process.env.HOME || "/Users/baha";
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const engine = process.env.PI_CHIEF_STT_ENGINE ?? "mlx";
	const small = engine === "small";
	const unknown = engine !== "small" && engine !== "mlx";
	return {
		whisperCheckpoint: unknown ? "" : small ? join(home, ".cache", "whisper", "small.pt") : join(home, ".local", "share", "pi-chief", "stt-mlx", "model"),
		pythonPath: unknown ? "" : small ? "/opt/homebrew/opt/python@3.11/bin/python3.11" : join(home, ".local", "share", "pi-chief", "stt-mlx", "venv", "bin", "python"),
		transcribeScript: unknown ? "" : join(scriptDir, small ? "transcribe.py" : "transcribe_mlx.py"),
		activityScript: join(scriptDir, "speech_activity.py"),
		ffmpegPath: "/opt/homebrew/bin/ffmpeg",
		tempRoot: tmpdir(),
		...defaultDeps,
	};
}

export function voiceEngineAvailable(deps: VoiceDeps = {}): boolean {
	const requestedEngine = process.env.PI_CHIEF_STT_ENGINE ?? "mlx";
	if (requestedEngine !== "mlx" && requestedEngine !== "small") return false;
	const d = { ...resolveDeps(), ...deps };
	try {
		if (!d.whisperCheckpoint || !d.transcribeScript || !d.pythonPath || !d.activityScript || !d.ffmpegPath) return false;
		statSync(d.whisperCheckpoint!);
		if (requestedEngine === "mlx" && !deps.whisperCheckpoint && !defaultDeps?.whisperCheckpoint) {
			statSync(join(d.whisperCheckpoint!, "weights.safetensors"));
			statSync(join(d.whisperCheckpoint!, "config.json"));
		}
		statSync(d.transcribeScript!);
		statSync(d.pythonPath!);
		statSync(d.activityScript!);
		statSync(d.ffmpegPath!);
	} catch {
		return false;
	}
	return true;
}

const TELEGRAM_FILE_PATH = /^[\w./-]+$/;

export function assertSafeTelegramFilePath(filePath: string): void {
	if (!filePath || filePath.includes("..") || filePath.startsWith("/") || !TELEGRAM_FILE_PATH.test(filePath)) {
		throw voiceErr("VOICE_DOWNLOAD_FAILED");
	}
}

export function buildTelegramFileUrl(token: string, filePath: string): string {
	assertSafeTelegramFilePath(filePath);
	return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

function voiceErr(code: VoiceErrorCode): Error {
	return Object.assign(new Error(code), { voiceCode: code });
}

export function voiceErrorCode(e: unknown): VoiceErrorCode {
	if (e && typeof e === "object" && "voiceCode" in e && typeof (e as any).voiceCode === "string") {
		return (e as any).voiceCode as VoiceErrorCode;
	}
	return "VOICE_STT_FAILED";
}

export async function downloadTelegramVoice(
	api: VoiceApi,
	token: string,
	fileId: string,
	destPath: string,
	maxBytes: number,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < VOICE_DOWNLOAD_ATTEMPTS; attempt++) {
		try {
			const file = await api("getFile", { file_id: fileId }, VOICE_NETWORK_TIMEOUT_MS);
			if (file.file_size != null && Number(file.file_size) > maxBytes) throw voiceErr("VOICE_TOO_LARGE");
			const filePath = String(file.file_path ?? "");
			assertSafeTelegramFilePath(filePath);
			const url = buildTelegramFileUrl(token, filePath);
			const res = await fetchImpl(url, {
				method: "GET",
				redirect: "error",
				signal: AbortSignal.timeout(VOICE_NETWORK_TIMEOUT_MS),
			});
			if (!res.ok || !res.body) throw voiceErr("VOICE_DOWNLOAD_FAILED");
			let size = 0;
			let ownsDestination = false;
			const out = createWriteStream(destPath, { flags: "wx", mode: 0o600 });
			out.once("open", () => { ownsDestination = true; });
			const limiter = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					size += chunk.length;
					if (size > maxBytes) callback(voiceErr("VOICE_TOO_LARGE"));
					else callback(null, chunk);
				},
			});
			try {
				await pipeline(Readable.fromWeb(res.body as any), limiter, out);
				return;
			} catch (e) {
				if (ownsDestination) { try { rmSync(destPath, { force: true }); } catch {} }
				throw e;
			}
		} catch (e) {
			lastErr = e;
			if (e && typeof e === "object" && "voiceCode" in e) throw e;
		}
	}
	throw lastErr instanceof Error && "voiceCode" in lastErr ? lastErr : voiceErr("VOICE_DOWNLOAD_FAILED");
}

function runProcess(argv: string[], timeoutMs: number, maxStdoutBytes = 1024 * 1024, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; code: number | null; failed: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "ignore"], detached: true, env });
		let stdout = "";
		let bytes = 0;
		let failed = false;
		const stop = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
		child.stdout?.on("data", (b: Buffer) => {
			bytes += b.length;
			if (bytes > maxStdoutBytes) { failed = true; stop(); }
			else stdout += b.toString("utf8");
		});
		const timer = setTimeout(() => { failed = true; stop(); }, timeoutMs);
		child.on("error", reject);
		child.on("close", code => {
			clearTimeout(timer);
			resolve({ stdout, code, failed });
		});
	});
}

export async function ffprobeVoice(path: string): Promise<{ durationSec: number; codec: string; format: string }> {
	const { stdout, code, failed } = await runProcess(
		["/opt/homebrew/bin/ffprobe", "-v", "error", "-show_entries", "format=format_name:stream=codec_name,duration", "-of", "json", path],
		VOICE_PROBE_TIMEOUT_MS,
	);
	if (failed || code !== 0) throw voiceErr("VOICE_PROBE_FAILED");
	let parsed: any;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw voiceErr("VOICE_PROBE_FAILED");
	}
	const format = String(parsed.format?.format_name ?? "");
	const stream = (parsed.streams ?? [])[0] ?? {};
	const codec = String(stream.codec_name ?? "");
	const durationSec = Number(stream.duration ?? parsed.format?.duration ?? 0);
	if (!format.includes("ogg") || codec !== "opus") throw voiceErr("VOICE_BAD_FORMAT");
	if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > VOICE_MAX_DURATION_SEC) {
		throw voiceErr(durationSec > VOICE_MAX_DURATION_SEC ? "VOICE_TOO_LONG" : "VOICE_PROBE_FAILED");
	}
	return { durationSec, codec, format };
}

async function checkVoiceActivity(audioPath: string, d: ReturnType<typeof resolveDeps>): Promise<boolean> {
	const { stdout, code, failed } = await runProcess(
		[d.pythonPath!, d.activityScript!, audioPath, d.ffmpegPath!],
		VOICE_ACTIVITY_TIMEOUT_MS,
		4096,
	);
	if (failed || code !== 0) throw voiceErr("VOICE_ACTIVITY_FAILED");
	let result: any;
	try { result = JSON.parse(stdout.trim()); } catch { throw voiceErr("VOICE_ACTIVITY_FAILED"); }
	if (!result.ok) throw voiceErr("VOICE_ACTIVITY_FAILED");
	return result.speech === true;
}

export async function runWhisperStt(audioPath: string, deps: VoiceDeps = {}): Promise<VoiceTranscribeResult> {
	const d = { ...resolveDeps(), ...deps };
	if (!voiceEngineAvailable(d)) throw voiceErr("VOICE_UNAVAILABLE");
	const engineEnv = process.env.PI_CHIEF_STT_ENGINE ?? "mlx";
	if (engineEnv !== "small" && engineEnv !== "mlx") throw voiceErr("VOICE_UNAVAILABLE");
	const env = engineEnv === "mlx" ? { ...process.env, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", TRANSFORMERS_OFFLINE: "1" } : process.env;
	const { stdout, code, failed } = await runProcess(
		[d.pythonPath!, d.transcribeScript!, audioPath, d.whisperCheckpoint!],
		VOICE_STT_TIMEOUT_MS,
		16 * 1024,
		env,
	);
	if (failed || code !== 0) throw voiceErr("VOICE_STT_FAILED");
	const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
	let json: any;
	try {
		json = JSON.parse(line);
	} catch {
		throw voiceErr("VOICE_STT_FAILED");
	}
	if (!json.ok) throw voiceErr((json.code as VoiceErrorCode) || "VOICE_STT_FAILED");
	const text = String(json.text ?? "").trim();
	if (!text) throw voiceErr("VOICE_EMPTY");
	if (text.length > 8000) throw voiceErr("VOICE_RESULT_TOO_LARGE");
	return { text, language: String(json.language ?? "") };
}

export function createVoiceTempDir(deps: VoiceDeps = {}): string {
	const d = { ...resolveDeps(), ...deps };
	const dir = mkdtempSync(join(d.tempRoot!, "chief-voice-"));
	chmodSync(dir, 0o700);
	return dir;
}

export function safeRemoveDir(dir: string | undefined): void {
	if (!dir) return;
	try {
		const st = statSync(dir, { throwIfNoEntry: false });
		if (!st?.isDirectory()) return;
		if ((st.mode & fsConstants.S_IFMT) !== fsConstants.S_IFDIR) return;
		if (!dir.includes("chief-voice-")) return;
		rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
	} catch {}
}

export async function transcribeVoiceJob(
	api: VoiceApi,
	token: string,
	fileId: string,
	metaDuration: number,
	metaSize: number | null,
	deps: VoiceDeps = {},
): Promise<VoiceTranscribeResult> {
	if (metaDuration > VOICE_MAX_DURATION_SEC) throw voiceErr("VOICE_TOO_LONG");
	if (metaSize != null && metaSize > VOICE_MAX_BYTES) throw voiceErr("VOICE_TOO_LARGE");
	if (!voiceEngineAvailable(deps)) throw voiceErr("VOICE_UNAVAILABLE");
	const d = { ...resolveDeps(), ...deps };
	const dir = createVoiceTempDir(d);
	const audioPath = join(dir, "voice.ogg");
	try {
		const download = d.downloadFile ?? ((a, fid, dest, max) => downloadTelegramVoice(a, token, fid, dest, max, d.fetchImpl));
		await download(api, fileId, audioPath, VOICE_MAX_BYTES);
		const st = statSync(audioPath);
		if (st.size > VOICE_MAX_BYTES) throw voiceErr("VOICE_TOO_LARGE");
		const probe = d.probeAudio ?? ffprobeVoice;
		await probe(audioPath);
		let speechDetected = true;
		if (d.checkActivity) speechDetected = await d.checkActivity(audioPath);
		else if (!d.runStt) speechDetected = await checkVoiceActivity(audioPath, d);
		if (!speechDetected) throw voiceErr("VOICE_NO_SPEECH");
		const stt = d.runStt ?? (p => runWhisperStt(p, d));
		return await stt(audioPath);
	} finally {
		safeRemoveDir(dir);
	}
}

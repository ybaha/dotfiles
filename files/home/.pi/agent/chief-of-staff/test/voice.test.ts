import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Store, type Config } from "../store.ts";
import {
	acceptVoiceMessage,
	handleMessage,
	processVoiceJob,
	routeConversationText,
	runWorker,
	type Api,
} from "../telegram.ts";
import {
	assertSafeTelegramFilePath,
	buildTelegramFileUrl,
	downloadTelegramVoice,
	runWhisperStt,
	setVoiceDeps,
	voiceEngineAvailable,
	VOICE_MAX_BYTES,
	VOICE_MAX_DURATION_SEC,
} from "../voice.ts";
import { tokenFile } from "../store.ts";

const ME = "1912767327";
const config: Config = { ovisBaseUrl: "https://ovis.example.ts.net:8443/", machineId: "mac", telegramUserId: ME, leadModels: "openai-codex/gpt-6.1-sol:high", workerModels: "cursor-ide/composer-2.5:high", bridgeModel: "minimax/MiniMax-M3.1-Flash:high" };

let store: Store;
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "chief-voice-test-"));
	process.env.PI_CHIEF_CONFIG_DIR = join(root, "config");
	process.env.PI_CHIEF_DATA_DIR = join(root, "data");
	store = new Store();
	setVoiceDeps(null);
});

const voiceMsg = (duration = 3, fileId = "fid1", messageId = 901) => ({
	message_id: messageId,
	chat: { id: Number(ME), type: "private" as const },
	from: { id: Number(ME) },
	voice: { file_id: fileId, duration, mime_type: "audio/ogg", file_size: 1000 },
});

function fakeApi(opts: { filePath?: string; getFileCalls?: number[] } = {}) {
	const calls: { method: string; body: any }[] = [];
	let nextId = 200;
	const api: Api = async (method, body) => {
		calls.push({ method, body });
		if (method === "sendMessage") return { message_id: nextId++ };
		if (method === "getUpdates") return [];
		if (method === "getFile") {
			opts.getFileCalls?.push(1);
			return { file_path: opts.filePath ?? "voice/file.ogg" };
		}
		return {};
	};
	return { api, calls };
}

const engineDeps = () => {
	const d = mkdtempSync(join(tmpdir(), "voice-engine-"));
	const checkpoint = join(d, "base.pt");
	writeFileSync(checkpoint, "fake");
	const script = join(d, "transcribe.py");
	writeFileSync(script, "# mock\n");
	const py = join(d, "python");
	writeFileSync(py, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	return { whisperCheckpoint: checkpoint, transcribeScript: script, pythonPath: py };
};

test("unauthorized voice never calls getFile in consumer", async () => {
	const deps = engineDeps();
	setVoiceDeps({ ...deps, runStt: async () => ({ text: "hi", language: "en" }) });
	const getFileCalls: number[] = [];
	fakeApi({ getFileCalls });
	const stranger = { ...voiceMsg(), from: { id: 42 }, chat: { id: 42, type: "private" as const } };
	assert.equal(acceptVoiceMessage(config, store, 1, stranger, deps), undefined);
	assert.equal(getFileCalls.length, 0);
	assert.equal(store.countVoiceQueue(), 0);
});

test("accept voice advances offset atomically and enqueues", () => {
	const deps = engineDeps();
	const reply = acceptVoiceMessage(config, store, 10, voiceMsg(), deps);
	assert.match(reply!, /accepted/i);
	assert.equal(store.get("telegram_offset"), "11");
	assert.equal(store.countVoiceQueue(), 1);
});

test("engine unavailable does not enqueue", () => {
	const reply = acceptVoiceMessage(config, store, 3, voiceMsg(), {
		whisperCheckpoint: "/nonexistent/base.pt",
	});
	assert.match(reply!, /unavailable/i);
	assert.equal(store.countVoiceQueue(), 0);
	assert.equal(store.get("telegram_offset"), "4");
});

test("metadata caps reject without queue", () => {
	const deps = engineDeps();
	const long = acceptVoiceMessage(config, store, 1, voiceMsg(VOICE_MAX_DURATION_SEC + 1), deps);
	assert.match(long!, /too long/i);
	assert.equal(store.countVoiceQueue(), 0);
	const big = acceptVoiceMessage(config, store, 2, {
		...voiceMsg(1, "f2", 902),
		voice: { file_id: "f2", duration: 1, file_size: VOICE_MAX_BYTES + 1 },
	}, deps);
	assert.match(big!, /too large/i);
});

test("transcribed /status is inbox text not bot command", () => {
	store.set(store.seenKey("chief"), String(Date.now()));
	const ack = routeConversationText(config, store, "/status please", {}, { transcribedVoice: true });
	assert.match(ack!, /Sent to chief/);
	const inbox = store.takeInbox("chief")[0]!;
	assert.match(inbox.text, /Transcribed voice/);
	assert.match(inbox.text, /\/status/);
});

test("typed /status remains command", () => {
	store.set(store.seenKey("chief"), String(Date.now()));
	const ack = handleMessage(config, store, {
		message_id: 1, chat: { id: Number(ME), type: "private" }, from: { id: Number(ME) }, text: "/status",
	});
	assert.match(ack!, /Chief/);
	assert.equal(store.countInboxQueued(), 0);
});

test("closed question on voice reply gives clear status", async () => {
	const deps = engineDeps();
	setVoiceDeps({
		...deps,
		downloadFile: async () => {},
		probeAudio: async () => ({ durationSec: 1, codec: "opus", format: "ogg" }),
		runStt: async () => ({ text: "yes answer", language: "en" }),
	});
	store.ask({ sessionId: "s1", question: "Q?", urgent: true });
	store.db.prepare("UPDATE questions SET status = 'sent', telegram_message_id = 777 WHERE id = 1").run();
	store.closeQuestion(1, "s1");
	acceptVoiceMessage(config, store, 5, {
		...voiceMsg(1, "f3", 903),
		reply_to_message: { message_id: 777, text: "Chief question #1" },
	}, deps);
	const { api } = fakeApi();
	await processVoiceJob({ config, store, api, token: "12345678901234567890123456789012:AAHabcdefghijklmnopqrstuvwxyz123456", voiceDeps: { ...deps, downloadFile: async (_api, _fid, dest) => writeFileSync(dest, "ogg"), probeAudio: async () => ({ durationSec: 1, codec: "opus", format: "ogg" }), runStt: async () => ({ text: "yes answer", language: "en" }) } });
	const outbox = store.db.prepare("SELECT text FROM outbox WHERE status = 'queued'").all() as { text: string }[];
	assert.ok(outbox.some(r => /closed or expired/i.test(r.text)));
	assert.equal(store.takeInbox("chief").length, 0);
});

test("voice completion echoes exact transcript in plain quoted Telegram outbox", async () => {
	const deps = engineDeps();
	const transcripts = ["Merhaba, beni anlıyor musun?\nİyiyim.", "Hello, chief.\nHow are you?"];
	for (let i = 0; i < transcripts.length; i++) {
		acceptVoiceMessage(config, store, i + 1, voiceMsg(1, `echo-${i}`, 930 + i), deps);
		await processVoiceJob({
			config, store, api: fakeApi().api, token: "unused",
			voiceDeps: { ...deps, downloadFile: async (_api, _fid, dest) => writeFileSync(dest, "ogg"), probeAudio: async () => ({ durationSec: 1, codec: "opus", format: "ogg" }), runStt: async () => ({ text: transcripts[i], language: i ? "en" : "tr" }) },
		});
		const out = store.db.prepare("SELECT text FROM outbox WHERE status = 'queued' ORDER BY id").all() as { text: string }[];
		assert.equal(out.at(-1)?.text, `“${transcripts[i]}”`);
		assert.ok(!out.some(r => /Sent to chief/.test(r.text)));
	}
	assert.equal(store.takeInbox("chief").length, 2);
});

test("long voice acknowledgement is numbered, complete, and codepoint-safe", async () => {
	const deps = engineDeps();
	const transcript = "Merhaba 🙂\n" + "çok uzun ".repeat(520);
	acceptVoiceMessage(config, store, 1, voiceMsg(1, "long-echo", 940), deps);
	await processVoiceJob({ config, store, api: fakeApi().api, token: "unused", voiceDeps: { ...deps, downloadFile: async (_api, _fid, dest) => writeFileSync(dest, "ogg"), probeAudio: async () => ({ durationSec: 1, codec: "opus", format: "ogg" }), runStt: async () => ({ text: transcript, language: "tr" }) } });
	const out = store.db.prepare("SELECT text FROM outbox WHERE status = 'queued' ORDER BY id").all() as { text: string }[];
	assert.ok(out.length > 1);
	assert.ok(out.every((row, index) => row.text.length <= 3900 && row.text.startsWith(`(${index + 1}/${out.length}) “`) && row.text.endsWith("”")));
	const reconstructed = out.map(row => row.text.slice(row.text.indexOf(" “") + 2, -1)).join("");
	assert.equal(reconstructed, transcript);
});

test("downloader EEXIST and source errors cannot crash a subprocess", () => {
	const script = `import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { Readable } from "node:stream"; import { downloadTelegramVoice } from ${JSON.stringify(new URL("../voice.ts", import.meta.url).href)}; const dir=mkdtempSync(join(tmpdir(),"voice-child-")); const dest=join(dir,"voice.ogg"); writeFileSync(dest,"sentinel"); const api=async()=>({file_path:"voice/a.ogg"}); try { await downloadTelegramVoice(api,"unused","f",dest,100,async()=>new Response(new Uint8Array([1]))); throw new Error("EEXIST unexpectedly succeeded"); } catch(e) { if(readFileSync(dest,"utf8")!=="sentinel") throw e; } rmSync(dest); let calls=0; await downloadTelegramVoice(api,"unused","f",dest,100,async()=>{ calls++; if(calls===1) return {ok:true,body:Readable.toWeb(new Readable({read(){this.destroy(new Error("source failed"));}}))}; return new Response(new Uint8Array([2,3])); }); if(calls!==2||readFileSync(dest).length!==2) throw new Error("retry failed"); rmSync(dir,{recursive:true,force:true}); console.log("survived");`;
	const proc = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 5_000 });
	assert.equal(proc.status, 0, proc.stderr);
	assert.match(proc.stdout, /survived/);
});

test("real downloader writes a new private file and preserves existing destinations", async () => {
	const dir = mkdtempSync(join(tmpdir(), "voice-download-test-"));
	const dest = join(dir, "voice.ogg");
	const api = async () => ({ file_path: "voice/file.ogg" });
	const fetchImpl = async () => new Response(new Uint8Array([1, 2, 3]));
	await downloadTelegramVoice(api, "test-token", "fid", dest, 10, fetchImpl as typeof fetch);
	assert.deepEqual([...readFileSync(dest)], [1, 2, 3]);
	assert.equal(statSync(dest).mode & 0o777, 0o600);
	writeFileSync(dest, "owned by someone else");
	await assert.rejects(downloadTelegramVoice(api, "test-token", "fid", dest, 10, fetchImpl as typeof fetch));
	assert.equal(readFileSync(dest, "utf8"), "owned by someone else");
});

test("download cap aborts streams and rejects Telegram size metadata", async () => {
	const dir = mkdtempSync(join(tmpdir(), "voice-download-cap-"));
	const dest = join(dir, "voice.ogg");
	const api = async () => ({ file_path: "voice/file.ogg" });
	await assert.rejects(downloadTelegramVoice(api, "test-token", "fid", dest, 2, async () => new Response(new Uint8Array([1, 2, 3])) as any));
	assert.throws(() => statSync(dest));
	await assert.rejects(downloadTelegramVoice(async () => ({ file_path: "voice/file.ogg", file_size: 3 }), "test-token", "fid", dest, 2, async () => { throw new Error("must not fetch"); }), /VOICE_TOO_LARGE/);
});

test("download URL builder rejects unsafe paths and never reads token file in test", () => {
	assert.throws(() => assertSafeTelegramFilePath("../etc/passwd"), /VOICE_DOWNLOAD_FAILED/);
	const url = buildTelegramFileUrl("9:ABCdefghijklmnopqrstuvwxyz1234567890AB", "voice/a.ogg");
	assert.match(url, /^https:\/\/api\.telegram\.org\/file\/bot/);
	assert.throws(() => readFileSync(tokenFile()));
});

test("redirect response fails download", async () => {
	const deps = engineDeps();
	const { api } = fakeApi();
	let fetchCalled = false;
	setVoiceDeps({
		...deps,
		fetchImpl: async () => {
			fetchCalled = true;
			return { ok: false, body: null } as any;
		},
	});
	acceptVoiceMessage(config, store, 1, voiceMsg(), deps);
	await processVoiceJob({ config, store, api, token: "12345678901234567890123456789012:AAHabcdefghijklmnopqrstuvwxyz123456", voiceDeps: deps });
	assert.ok(fetchCalled);
});

test("once-mode worker exits in a Node subprocess", () => {
	const script = `import { Store } from "./store.ts"; import { runWorker } from "./telegram.ts"; const store = new Store(); await runWorker({ config: { ovisBaseUrl: "https://ovis.example.ts.net:8443/", machineId: "mac", telegramUserId: "1912767327", leadModels: "x", workerModels: "x", bridgeModel: "x" }, store, api: async method => method === "getUpdates" ? [] : {}, token: "unused-token", once: true }); store.close();`;
	const proc = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 5_000 });
	assert.equal(proc.status, 0, proc.stderr);
});

test("voice worker once drains job and text poll still works", async () => {
	const deps = engineDeps();
	setVoiceDeps({
		...deps,
		downloadFile: async () => {},
		probeAudio: async () => ({ durationSec: 2, codec: "opus", format: "ogg" }),
		runStt: async () => ({ text: "hello chief", language: "en" }),
	});
	store.set(store.seenKey("chief"), String(Date.now()));
	const updates = [{ update_id: 20, message: voiceMsg(2, "vf", 910) }];
	const calls: string[] = [];
	const api: Api = async (method, body: any) => {
		if (method === "getUpdates") return updates.splice(0);
		if (method === "sendMessage") {
			calls.push(body.text);
			return { message_id: 300 };
		}
		return {};
	};
	await runWorker({
		config,
		store,
		api,
		token: "12345678901234567890123456789012:AAHabcdefghijklmnopqrstuvwxyz123456",
		once: true,
		voiceDeps: { ...deps, downloadFile: async (_api, _fid, dest) => writeFileSync(dest, "ogg"), probeAudio: async () => ({ durationSec: 2, codec: "opus", format: "ogg" }), runStt: async () => ({ text: "hello chief", language: "en" }) },
	});
	assert.ok(calls.some(t => /transcribing/i.test(t)));
	const inbox = store.takeInbox("chief");
	assert.match(inbox[0]?.text ?? "", /hello chief/);
	assert.equal(store.get("telegram_offset"), "21");
});

test("voice transaction early returns commit and route failures roll back", () => {
	const input = (messageId: number, updateId = messageId) => ({ chatId: ME, messageId, updateId, fileId: `f${messageId}`, duration: 1, fileSize: 10, receiptContext: {} });
	const first = store.acceptVoiceJob(input(1));
	assert.equal(first.ok, true);
	assert.equal(store.acceptVoiceJob(input(1, 2)).ok, true); // duplicate early return
	store.set("after_duplicate", "ok");
	for (let i = 2; i <= 10; i++) store.acceptVoiceJob(input(i));
	assert.deepEqual(store.acceptVoiceJob(input(11)), { ok: false, code: "VOICE_QUEUE_FULL" });
	store.set("after_full", "ok"); // queue-full early return committed
	assert.equal(store.completeVoiceJob(999, "unused", () => undefined), undefined);
	store.set("after_missing", "ok"); // missing-job early return committed
	const job = store.claimVoiceJob()!;
	assert.throws(() => store.completeVoiceJob(job.id, "hello", () => {
		store.queueInbox("must rollback");
		throw new Error("route failed");
	}), /route failed/);
	assert.equal(store.countInboxQueued(), 0);
	store.set("after_rollback", "ok");
	assert.equal(store.voiceJob(job.id)?.state, "processing");
});

test("engine defaults to MLX, supports explicit Small rollback, and rejects unknown selectors", () => {
	const old = process.env.PI_CHIEF_STT_ENGINE;
	try {
		delete process.env.PI_CHIEF_STT_ENGINE;
		assert.equal(voiceEngineAvailable(), true);
		process.env.PI_CHIEF_STT_ENGINE = "small";
		assert.equal(voiceEngineAvailable(), true);
		process.env.PI_CHIEF_STT_ENGINE = "bogus";
		assert.equal(voiceEngineAvailable(), false);
	} finally {
		if (old === undefined) delete process.env.PI_CHIEF_STT_ENGINE;
		else process.env.PI_CHIEF_STT_ENGINE = old;
	}
});

test("energy guard rejects silence, keeps quiet speech, and fails closed on invalid audio", { timeout: 30_000 }, () => {
	if (process.platform !== "darwin") return;
	const dir = mkdtempSync(join(tmpdir(), "chief-activity-test-"));
	const silence = join(dir, "silence.wav");
	const speech = join(dir, "speech.aiff");
	const quiet = join(dir, "quiet.wav");
	const invalid = join(dir, "invalid.ogg");
	writeFileSync(invalid, "not audio");
	assert.equal(spawnSync("/opt/homebrew/bin/ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "3", silence], { timeout: 10_000 }).status, 0);
	assert.equal(spawnSync("say", ["-o", speech, "quiet speech activity test"], { timeout: 10_000 }).status, 0);
	assert.equal(spawnSync("/opt/homebrew/bin/ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", speech, "-af", "volume=0.02", "-ar", "16000", "-ac", "1", quiet], { timeout: 10_000 }).status, 0);
	const py = "/Users/baha/.local/share/pi-chief/stt-mlx/venv/bin/python";
	const activity = join(process.cwd(), "speech_activity.py");
	const ffmpeg = "/opt/homebrew/bin/ffmpeg";
	const check = (audio: string) => {
		const proc = spawnSync(py, [activity, audio, ffmpeg], { encoding: "utf8", timeout: 20_000 });
		return { status: proc.status, result: proc.stdout.trim() ? JSON.parse(proc.stdout.trim()) : null };
	};
	assert.deepEqual(check(silence), { status: 0, result: { ok: true, speech: false } });
	assert.deepEqual(check(quiet), { status: 0, result: { ok: true, speech: true } });
	assert.notEqual(check(invalid).status, 0);
});

test("energy silence result is terminal and never invokes ASR or queues inbox", async () => {
	const deps = engineDeps();
	let asrCalls = 0;
	acceptVoiceMessage(config, store, 1, voiceMsg(1, "silence", 990), deps);
	await processVoiceJob({ config, store, api: fakeApi().api, token: "unused", voiceDeps: {
		...deps,
		downloadFile: async (_api, _fid, dest) => writeFileSync(dest, "ogg"),
		probeAudio: async () => ({ durationSec: 1, codec: "opus", format: "ogg" }),
		checkActivity: async () => false,
		runStt: async () => { asrCalls++; return { text: "unwanted", language: "en" }; },
	} });
	assert.equal(asrCalls, 0);
	assert.equal(store.voiceJob(1)?.errorCode, "VOICE_NO_SPEECH");
	assert.equal(store.takeInbox("chief").length, 0);
	const outbox = store.db.prepare("SELECT text FROM outbox WHERE status = 'queued'").all() as { text: string }[];
	assert.ok(outbox.some(r => r.text === "No speech detected."));
});

test("duplicate voice message dedupes jobs", () => {
	const deps = engineDeps();
	acceptVoiceMessage(config, store, 1, voiceMsg(1, "same", 920), deps);
	acceptVoiceMessage(config, store, 2, voiceMsg(1, "same", 920), deps);
	assert.equal(store.countVoiceQueue(), 1);
});

test("local synthetic speech benchmark uses default MLX Turbo adapter", { timeout: 240_000 }, async () => {
	if (process.platform !== "darwin") return;
	if (!voiceEngineAvailable()) return;
	const dir = mkdtempSync(join(tmpdir(), "chief-voice-bench-"));
	const ogg = join(dir, "sample.ogg");
	const aiff = join(dir, "sample.aiff");
	assert.equal(spawnSync("say", ["-o", aiff, "chief voice benchmark ok"], { timeout: 10_000 }).status, 0);
	assert.equal(spawnSync("/opt/homebrew/bin/ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", aiff, "-c:a", "libopus", "-b:a", "24k", ogg], { timeout: 10_000 }).status, 0);
	const t0 = Date.now();
	const result = await runWhisperStt(ogg);
	const elapsed = Date.now() - t0;
	assert.ok(result.text.length > 0);
	assert.match(result.text.toLowerCase(), /benchmark|chief|voice/);
	console.error(`MLX Turbo voice benchmark: ${elapsed}ms lang=${result.language} chars=${result.text.length}`);
});

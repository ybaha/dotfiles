import { CONFIG_KEYS, Store, configDir, dataDir, loadConfig, readToken, setConfig, tokenFile, validToken, writePrivate } from "./store.ts";
import { quotaLine } from "./models.ts";
import { runWorker, telegramApi } from "./telegram.ts";

const USAGE = `pi-chief: memory + Telegram questions for a Pi chief-of-staff

  pi-chief [pi args]           Start Pi with chief enabled
  pi-chief config [KEY VALUE]  Show or set config (${CONFIG_KEYS.join(", ")})
  pi-chief token               Store the bot token (prompts hidden, or reads stdin)
  pi-chief ping [TEXT]         Send yourself a test message
  pi-chief telegram            Run the Telegram worker (keep it running in its own pane)
  pi-chief status              Show setup, worker, and open questions
  pi-chief memory [QUERY]      Search memories (or list recent)`;

function requireTelegram() {
	const config = loadConfig();
	const token = readToken();
	if (!token) throw new Error("No bot token; run: pi-chief token");
	if (!config.telegramUserId) throw new Error("No Telegram user; run: pi-chief config telegramUserId <id>");
	return { config, token };
}

async function readStdin(): Promise<string> {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	return input.trim();
}

async function main([cmd, ...args]: string[]): Promise<void> {
	switch (cmd) {
		case "config": {
			if (args.length >= 2) setConfig(args[0], args.slice(1).join(" "));
			else if (args.length) throw new Error("Usage: pi-chief config KEY VALUE");
			console.log(JSON.stringify(loadConfig(), null, 2));
			return;
		}
		case "token": {
			const token = await readStdin();
			if (!validToken(token)) throw new Error("That doesn't look like a bot token (123456:ABC...); nothing saved");
			writePrivate(tokenFile(), token + "\n");
			const me = await telegramApi(token)("getMe", {});
			console.log(`Saved token for @${me.username}`);
			return;
		}
		case "ping": {
			const { config, token } = requireTelegram();
			await telegramApi(token)("sendMessage", { chat_id: config.telegramUserId, text: args.join(" ") || "Chief test message ✓" });
			console.log("Sent");
			return;
		}
		case "telegram": {
			const { config, token } = requireTelegram();
			const stop = new AbortController();
			process.once("SIGINT", () => stop.abort());
			process.once("SIGTERM", () => stop.abort());
			const store = new Store();
			const me = await telegramApi(token)("getMe", {});
			const voiceEngine = process.env.PI_CHIEF_STT_ENGINE ?? "mlx";
			console.error(`Telegram worker running as @${me.username}; voice STT=${voiceEngine === "small" ? "Small rollback" : voiceEngine === "mlx" ? "MLX Whisper Turbo (offline)" : "unavailable (invalid PI_CHIEF_STT_ENGINE)"}; Ctrl+C to stop`);
			try {
				await runWorker({
					config,
					store,
					api: telegramApi(token, fetch, stop.signal),
					token,
					once: args.includes("--once"),
					signal: stop.signal,
				});
			} finally {
				store.close();
			}
			return;
		}
		case "status": {
			const config = loadConfig();
			const store = new Store();
			try {
				const seen = Number(store.get("worker_seen") ?? 0);
				const chiefSeen = Number(store.get(store.seenKey("chief")) ?? 0);
				console.log(JSON.stringify({
					configDir: configDir(),
					dataDir: dataDir(),
					config,
					token: readToken() ? "saved" : "missing (pi-chief token)",
					worker: seen ? `last seen ${Math.round((Date.now() - seen) / 1000)}s ago` : "never ran (pi-chief telegram)",
					chief: {
						online: chiefSeen ? Date.now() - chiefSeen <= 30_000 : false,
						state: store.get(store.stateKey("chief")) ?? "idle",
						sessionId: store.get(store.ownerKey("chief")) ?? null,
					},
					inboxQueued: store.countInboxQueued(),
					openQuestions: store.openQuestions().map(q => ({ id: q.id, status: q.status, question: q.question })),
					memories: store.recall("", 1000).length,
					quota: quotaLine(),
				}, null, 2));
			} finally {
				store.close();
			}
			return;
		}
		case "memory": {
			const store = new Store();
			try {
				for (const m of store.recall(args.join(" "), 50)) console.log(`#${m.id} ${m.text}`);
			} finally {
				store.close();
			}
			return;
		}
		default:
			console.log(USAGE);
	}
}

main(process.argv.slice(2)).catch(e => {
	console.error(`pi-chief: ${(e as Error).message}`);
	process.exitCode = 1;
});

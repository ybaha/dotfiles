# Pi chief of staff

A Pi extension that gives one chief session durable memory and a Telegram line to Baha. No dependencies; Node 22.18+ (built-in SQLite and type stripping).

- `index.ts`: the extension. Off by default. Enable with `pi --chief` or `/chief on` (persists per branch; `/chief off` undoes it).
- `store.ts`: config, private files, and the SQLite store (memories with FTS5 and stemming; questions).
- `telegram.ts`: the worker that sends queued questions and records replies.
- `cli.ts`: invoked by `~/.local/bin/pi-chief`.

## Setup

```sh
ln -s ~/code/dotfiles/files/home/.pi/agent/chief-of-staff ~/.pi/agent/chief-of-staff
ln -s ~/code/dotfiles/files/home/.local/bin/pi-chief ~/.local/bin/pi-chief
pi-chief config ovisBaseUrl https://<ovis-host>.<your-tailnet>.ts.net:8443/
pi-chief config machineId <Ovis machine id of this computer>
pi-chief config telegramUserId <your Telegram user id>
pi-chief config bridgeModel minimax/MiniMax-M3.1-Flash:high   # optional; used when a lead/chief model hits its usage limit
pi-chief token        # paste the @BotFather token (hidden); verifies it with getMe
pi-chief ping         # sends you a test message
```

Send `/start` to the bot once first so it is allowed to message you.

## Run

Two panes in a Herdr `chief` workspace:

```sh
pi-chief              # Pi with chief enabled (same as pi --chief)
pi-chief telegram     # the worker; only it talks to Telegram (default: local MLX Whisper Turbo)
```

Voice transcription uses the isolated MLX environment and pinned local model under `~/.local/share/pi-chief/stt-mlx`; it does not fall back to cloud services. To roll back to the retained Whisper Small install, restart this worker in the same pane with:

```sh
PI_CHIEF_STT_ENGINE=small pi-chief telegram
```

A shared ffmpeg/NumPy energy guard rejects digital/near-digital silence before either model. It is not neural VAD and does not guarantee rejection of speech-like background noise.

## What the chief gets

- `chief_remember` / `chief_recall` / `chief_forget`: durable facts, searched by meaning-ish keywords (Porter stemming).
- `ask_baha` / `ask_baha_close`: queue a Telegram question and return immediately. Your reply arrives in the same Pi session as a user message, even mid-turn (as a follow-up).
- Before each turn: `USER.md`, `PROJECTS.md`, the top memory matches for the prompt, and open questions are added to the system prompt (capped at 4,000 chars).
- Chief acts as a **dispatcher**: quick read-only answers inline; project work via `assign_lead` (durable lead per repo) or one-off `start_worker`; `/chief lead <project>` or `PI_CHIEF_LEAD` enables a project lead (`start_worktree`, `report_chief`). `waiting_agents` for who needs you. While chief or lead is on, `edit` and `write` are disabled so the session stays responsive.

On Telegram, reply to a question message to answer it. Any other text goes to the chief session (use `reply_baha` to answer). `/status` shows chief availability. Only your private chat is accepted.

`wait_for_model` (chief and leads) holds work until a named model has quota again: it stores the task in SQLite, queues one Telegram “holding” line from the chief, then on refill compacts large context if needed, resumes an optional Herdr agent (or switches the chief session), and sends one “quota is back” Telegram line.

## Files

- `~/.config/pi-chief/config.json` and `telegram-bot-token` (0600, directory 0700)
- `~/.local/share/pi-chief/chief.sqlite`, `USER.md`, `PROJECTS.md` (directory 0700)

The extension never reads the token; only the worker and CLI do. Questions expire after 24 hours; at most 3 can be open per session. If the worker dies mid-send, the question is resent on restart (it may arrive twice, but it is never lost). Telegram keeps unread replies for 24 hours, so a worker that was off briefly catches up. A sleeping Mac runs neither process.

## Test

```sh
bash test/run.sh
```

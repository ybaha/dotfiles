---
name: browser-use
description: Drive a real browser with Browser Use Pi (persistent JS REPL + raw CDP) for tasks that need logins, forms, or multi-step web interaction. Use only when the user explicitly invokes /skill:browser-use.
disable-model-invocation: true
---

# /browser-use

Run one browser task with the Browser Use Pi SDK: `~/.pi/agent/skills/browser-use/scripts/bu-run "TASK" [--browser chromium|chrome|cloud] [--headless]`. It prints the agent's progress, then `status:` and the result. Report both; a status other than `completed` means the result is partial.

- First time on a machine: run `scripts/setup`. It installs the pinned SDK into `~/.local/share/browser-use-pi` (not tracked in dotfiles).
- Browsers: `chromium` (default) is an isolated local browser whose profile persists in `~/.local/share/browser-use-pi/profile`. Run it without `--headless` for the first sign-in, so the user can log in. `chrome` attaches to the user's running Chrome (needs `chrome://inspect/#remote-debugging` enabled). `cloud` needs `BROWSER_USE_API_KEY`.
- The SDK calls its model with its own credentials: set `OPENROUTER_API_KEY` (or `ANTHROPIC_API_KEY` with `BU_MODEL=anthropic/claude-sonnet-4-6`) in the environment. Pi's own login is not used. Never put keys in the repo or in prompts.
- Limits come from env: `BU_MODEL`, `BU_REASONING`, `BU_MAX_STEPS` (40), `BU_TIMEOUT_MS` (300000), `BU_MAX_COST_USD` (1).
- Its JavaScript runs with host filesystem and network access, and the `chrome` browser carries the user's real logins. Confirm with the user before tasks that purchase, send, post, or delete. Telemetry is off (`DO_NOT_TRACK=1`).
- Plain browsing, scraping, or a single page fetch does not need this; use `bash` or the Chrome skills instead.

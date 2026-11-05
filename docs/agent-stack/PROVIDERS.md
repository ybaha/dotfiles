# Providers and quotas

- `claude-bridge` uses the local Claude CLI/subscription, never direct Anthropic model API. The quota fetcher calls only Claude Code's read-only OAuth usage endpoint; it never sends a model prompt or prints/stores the token.
- `openai-codex`: shared settings currently default to Sol/high; reviewer and oracle also pin Sol/high. Astra is available for deliberate lower-cost main-session work; scout and delegate pin Luna/medium. `minimax`: M3.1 Flash (`minimax/MiniMax-M3.1-Flash`) mechanical only.
- `cursor-ide/composer-2.5` uses a **separate local** IDE-auth proxy (`cursor2api-ide`, `127.0.0.1:8787`); never the Cursor `agent` CLI. The proxy's slow-pool behavior is not guaranteed. On Linux or a host without the proxy, do not assume it works. Keep proxy credentials local. Cursor quota is not measured by the footer.
- `quota-cache.ts` calls `quota-fetch.py` in the global Pi extensions directory and stores best-effort readings under `~/.cache/pi-orchestra/quota/`; `quota-status.sh` reads that cache without fetching. Stale/empty cache is not a provider availability check.
- `~/.pi/agent/models.json` contains a local Cursor proxy entry and context overrides (GPT-6 Sol/Astra/Luna: 872K; Opus 5.5: 1M). Overrides describe advertised maximums, not a guarantee; check `pi --list-models` and provider metadata before changing them.

Credentials: `~/.pi/agent/auth.json` (0600), never Git. Keep host-specific service setup outside shared dotfiles. Use `pi list` and `/agents` to diagnose installed packages/agents.

## /cheap-compact

`files/home/.pi/agent/extensions/cheap-compact.ts` adds a `/cheap-compact` command that compacts the session with a cheap summarizer instead of the active model:

1. `minimax/MiniMax-M3.1-Flash`
2. `claude-bridge/claude-haiku-5-5`
3. `openai-codex/gpt-6-luna`

The active session model and thinking level never change; only the one-off summarization request uses the cheap model. Plain `/compact` keeps Pi's default behavior (the active model summarizes), and automatic compaction is untouched.

Implementation constraints:

- Import only public exports of `@earendil-works/pi-coding-agent`. A private subpath such as `dist/core/compaction/index.js` is not in the package `exports` map and breaks extension loading for every session with `Cannot find module`.
- The extension reuses the public `compact()` helper so previous-summary merging, split turns, cut-point selection, file tracking and usage accounting match a native `/compact`.
- If every candidate fails, compaction is cancelled rather than silently falling back to the expensive active model.
- Hook-produced compaction entries are skipped by Pi's native file-list carry-forward, so the extension merges its own lists back on the next compaction.

Tests: `cd ~/code/dotfiles && node --test tests/pi-cheap-compact.test.mjs` (mocked plus the real native helper; no network).

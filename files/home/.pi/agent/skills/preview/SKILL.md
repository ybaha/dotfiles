---
name: preview
description: Publish or refresh this project's HTTPS Tailscale preview. Use for /preview, preview stop/list, or a phone-accessible work-in-progress preview.
---

# Preview

Use `previewctl`; no subagents or broad searches. Stay in the current project/worktree (or use `--cwd`).

- `/preview stop`: `previewctl stop`; `/preview list`: `previewctl list`; `/preview url`: `previewctl url`.
- Default: try `previewctl up` once. It reuses a healthy project preview, refreshes its 24h TTL, and moves it to the top of the dashboard. Return the URL in one sentence.
- If none exists, use the project's known startup command. Only inspect `package.json` scripts if needed. Example: `previewctl up --title "Project" -- npm run dev -- --host 127.0.0.1 --port '{port}'`. The literal `{port}` is allocated by the controller. Never disable host checks globally.
- For an existing known project server: `previewctl attach --port PORT --title "Project"`. Do not scan unrelated local services.
- Static previews must use an explicitly chosen `public/`, `dist/`, or artifact directory. Never expose a repository root, `.env`, or `.git` with a generic file server.

HTTPS is mandatory; no Funnel or HTTP fallback. Daemon absent? Ask before `previewctl service install`. Never run the long-lived `previewctl daemon` in a foreground tool call. Installation needs Python 3.9+ and connected Tailscale with HTTPS enabled. Do not install packages or change ACLs automatically. On other failures return the short error; use `previewctl doctor` only if needed.

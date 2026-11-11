---
name: lead
description: Run one lead session that spawns and reviews Herdr worktree workers (like linked subagents). Use for "lead", "manage workers", "orchestrate", "work in worktrees", "you only do management", "delegate to multiple agents", or `/skill:lead`.
---

# Lead (worktree workers)

One Pi session plans work, spawns isolated worktree workers, reviews their diffs, merges, and closes. Scripts: `~/.pi/agent/skills/lead/scripts/{spawn.sh,prompt.sh,status.sh,close.sh}`.

## 1. Role

You manage; you do not write product code in the base repo worktree. One writer per worktree. Each worker may delegate edits to `worker` (Composer) subagents inside its own tree.

## 2. Plan

- One bounded deliverable → one work order from `templates/work-order.md`: background and evidence, locked decisions, exact files/lines, out of scope, how to work, verify, constraints, local running/ports, done-when, report format.
- Commit the work order under the target repo’s `docs/.../work-orders/` (often inside the worker’s tree after spawn).
- Parallel workers only when file sets do not overlap; give distinct ports per worker.

## 3. Spawn

```bash
~/.pi/agent/skills/lead/scripts/spawn.sh \
  --slug <kebab≤16> --brief <file> \
  [--repo <root>] [--base <branch>] \
  [--model <id>]  # default claude-bridge/claude-sonnet-5-5:medium \
  [--setup "cmd"]
```

Build the brief from `templates/worker-brief.md`. If `<repo>/.herdr/worktree-setup.sh` exists, `spawn.sh` runs it in the new worktree (copy env, install deps, etc.) — never log env contents.

Default model is overridable; `delegate` and `scout` subagent frontmatter pins still win — check `/agents`.

## 4. Wait

Do not poll, sleep-loop, or start waiter subagents. The `worktree-lead` extension posts a follow-up when a worker is done, idle, blocked, or its pane exits (30s hold absorbs `done`→`working` blips). Footer shows lines like `ui-harmony · Working · 12m`. Meanwhile do other work or yield with a short status.

On demand: `/workers`, `/workers close <slug>`, or `status.sh` / `status.sh --all`.

## 5. Review

Follow `templates/review-checklist.md`. Send corrections via:

```bash
~/.pi/agent/skills/lead/scripts/prompt.sh <slug> (--file f | --text "msg")
```

`prompt.sh` confirms the prompt landed and resends once (fixes dropped first prompts).

## 6. Integrate

Merge `worktree/<slug>` into base with `git merge --no-ff`. Rerun full checks and production build on combined code. Ask the user before push or deploy. Watch web/API deploy compatibility when services ship separately.

## 7. Close

```bash
~/.pi/agent/skills/lead/scripts/close.sh <slug> [--force]
```

Refuses unmerged branch or dirty worktree unless `--force`. Confirm with `/workers`.

## 8. Gotchas

- First prompt to a new worker can drop until `working` — scripts handle it; use `prompt.sh` for follow-ups too.
- Never `pkill -f` / `pgrep -f | kill` — kills your own shell; `close.sh` kills the watcher PID only after verifying `/proc/<pid>/cmdline` contains `herdr-watch.py`.
- `delegate` / `scout` ignore caller `model`; frontmatter pins win — check `/agents`.
- Herdr may log brief `done` then `working` when a background subagent starts; notifier waits 30s.
- Shared services and ports belong to other projects — never stop them.
- No secrets in briefs or work orders.
- One writer per worktree; ask before push/deploy.

## Templates

- `templates/work-order.md`
- `templates/worker-brief.md`
- `templates/review-checklist.md`

## See also

- `/skill:worktree` — single worktree from the current session
- `~/.pi/agent/extensions/worktree-lead.ts` — footer + finish notifications in the lead pane

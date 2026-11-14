---
name: lead
description: Run one lead session that spawns and reviews labeled hc worktree workers (like linked subagents). Use for "lead", "manage workers", "orchestrate", "work in worktrees", "you only do management", "delegate to multiple agents", or `/skill:lead`.
---

# Lead (worktree workers)

One Pi session plans work, spawns isolated worktree workers, reviews their diffs, merges, and closes terminals. Read `hc --skill` first. A new visible workspace needs an explicit worktree/worker request; routine helpers stay as Pi background subagents. Scripts: `~/.pi/agent/skills/lead/scripts/{spawn.sh,prompt.sh,status.sh,close.sh}`.

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

Do not poll, sleep-loop, or start waiter subagents. hc owns observed Pi status (OSC 7501); use `hc get <terminal>`, `hc read --lines 80 <terminal>`, or `status.sh` / `status.sh --all` on demand. Use `hc wait <terminal>` only for an immediate dependency; otherwise continue independent work or yield. The legacy `worktree-lead` footer, follow-up notifications and `/workers` command are disabled on hc; no background watcher is started.

## 5. Review

Follow `templates/review-checklist.md`. Send corrections via:

```bash
~/.pi/agent/skills/lead/scripts/prompt.sh <slug> (--file f | --text "msg")
```

`spawn.sh` uses `git worktree add` (honoring `--base`) then `hc run --bg --no-parent` with herdr/ovis grouping labels. It preserves the caller-resolved Pi bin in PATH, records the returned terminal address, waits once for readiness, checks observed Pi status, then calls `prompt.sh`. This submits once via `hc send`; it never forces blocked dialogs or automatically resends uncertain input. Inspect `hc read` before retrying.

## 6. Integrate

Merge `worktree/<slug>` into base with `git merge --no-ff`. Rerun full checks and production build on combined code. Ask the user before push or deploy. Watch web/API deploy compatibility when services ship separately.

## 7. Close

```bash
~/.pi/agent/skills/lead/scripts/close.sh <slug> [--force]
```

Refuses an unmerged branch or dirty worktree unless `--force`, and always verifies terminal cwd and `dotfiles.worker` ownership. It uses `hc kill` then `hc rm` only for that explicitly approved terminal. It removes registration but retains the worktree and branch: deletion/moving of existing `~/.herdr/worktrees` directories is not authorized. `--force` does not bypass ownership or authorize filesystem deletion.

## 8. Gotchas

- On setup/start/readiness failure, worktree/state may remain. Inspect before retrying; do not automatically delete branches/directories.
- No watcher PID, socket subscription or shell-background jobs are used. Never `pkill -f` or stop a terminal not recorded as your worker.
- `delegate` / `scout` ignore caller `model`; frontmatter pins win — check `/agents`.
- `HC_TERMINAL_ID` is an hc address, not a legacy pane ID. Old state files cannot safely target hc; migrate them manually. After an hc Pi restart, scripts resolve the preserved unique worker name to its new address and recheck ownership; read-only lead listing can fall back to cwd.
- Shared services and ports belong to other projects — never stop them.
- No secrets in briefs or work orders.
- One writer per worktree; ask before push/deploy.

## Templates

- `templates/work-order.md`
- `templates/worker-brief.md`
- `templates/review-checklist.md`

## See also

- `/skill:worktree` — single worktree from the current session
- `docs/agent-stack/HC.md` in dotfiles — terminal/label model and migration mapping

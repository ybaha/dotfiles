---
name: worktree
description: Spawn a git worktree in the current repo as a Herdr workspace and start a fresh pi implementation worker, with the spawning session's context. Use when the user wants parallel work in an isolated branch (e.g. "/worktree implement user auth"). Requires the herdr CLI.
---

# Worktree

Spawn a git worktree, open it as a Herdr workspace, start a pi **worker** with context carried from the spawning session, and leave a background watcher logging lifecycle events to the worktree.

For one lead managing several worktree workers, use `/skill:lead`.

## Usage

```
/skill:worktree <prompt>            # spawn + start worker + send prompt + start watcher
/skill:worktree                     # spawn empty worktree, no agent, no watcher
```

## Preconditions (fail fast)

```bash
test "${HERDR_ENV:-}" = 1 && command -v herdr >/dev/null && git rev-parse --show-toplevel
```

For a prompted worker, also verify `cursor-ide/composer-2.5` and its local proxy are available on this machine. If not, create only the empty worktree or ask which available model to use; do not silently switch providers.

## Workflow

### 1. Slug + worktree

Derive `SLUG` from the prompt: **short kebab-case, 1-2 words, ≤12 chars** (e.g. `user-auth`, `api-fix`). Agent name = slug (same as workspace label). On collision with existing branch or live agent, append `-2`, `-3`, ….

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO="$(basename "$REPO_ROOT")"
herdr worktree create \
  --cwd "$REPO_ROOT" \
  --branch "worktree/${SLUG}" \
  --path "$HOME/.herdr/worktrees/${REPO}/${SLUG}" \
  --label "${SLUG}" --focus
```

Parse `.result.root_pane.pane_id`, `.result.workspace.workspace_id`, `.result.worktree.{branch,path}`. On failure: report verbatim, stop.

### 2. Compose the prompt (the new agent starts cold — no session history)

```markdown
## Context (from spawning session)
- Repo: <repo root>
- Branch: <current branch> @ <HEAD sha if useful>
- Recent work: <1–3 sentence summary of what this session has been doing>
- Key decisions: <bullet list of constraints / choices already locked in>
- Related files: <paths the new agent will likely need to read>
- Spawning agent: pi, model <id>, thinking <level>

## You are the implementation worker
Follow ~/.pi/agent/AGENTS.md and the current repository's instructions. If present, consult the dotfiles repo's docs/agent-stack/ROUTING.md:
- Mechanical, reviewable implementation only. Read first, plan second, implement third, verify last.
- If the work spans >3 deliverables or multiple subsystems, **spawn subagents** from inside this worktree: `worker` for execution, `oracle`/`reviewer` for verification, `scout` for recon. Set model + thinking per the routing table; `async: true` for parallelism.
- Don't paste `~/.pi/agent/auth.json` content or secrets into subagent prompts — they inherit the parent's auth context.
- Default implementor: Cursor Composer 2.5 via `cursor-ide/composer-2.5`, thinking `high`. Use the local `cursor2api-ide` proxy; never use Cursor's `agent` CLI.

## User's request
<args verbatim>
```

Write to `/tmp/wt-<slug>-prompt.md` so quoting survives shell expansion.

### 3. Start worker (prompt after state file — step 4)

Capture the spawning pane **before** any watcher env overrides:

```bash
LEAD_PANE="${HERDR_PANE_ID:-}"
BASE_BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"

herdr agent start "${SLUG}" --kind pi --pane <root_pane_id> --timeout 60000 -- --model 'cursor-ide/composer-2.5:high'
```

### 4. Start background watcher + state (then prompt)

Subscribes to the Herdr socket and appends `pane.agent_status_changed` + `pane.exited` events to `<worktree_path>/.herdr-watch.log`. Exits when the pane closes.

The spawning agent **does not wait** — the watcher is launched with `nohup ... & disown` so the shell returns in milliseconds while python keeps running in its own process.

```bash
WATCHER_LOG="<worktree_path>/.herdr-watch.log"
WATCHER_PID_FILE="<worktree_path>/.herdr-watcher.pid"
WORKTREE_PATH="$(dirname "$WATCHER_LOG")"
ROOT_PANE="<root_pane_id>"

HERDR_PANE_ID="$ROOT_PANE" HERDR_AGENT_LABEL="${SLUG}" \
  nohup python3 -u "$HOME/.pi/agent/skills/worktree/scripts/herdr-watch.py" \
  >> "$WATCHER_LOG" 2>&1 &
WATCHER_PID=$!
disown
echo "$WATCHER_PID" > "$WATCHER_PID_FILE"

mkdir -p "$HOME/.pi/agent/state/worktree-watchers"
STATE_FILE="$HOME/.pi/agent/state/worktree-watchers/${SLUG}.json"

if [ -n "$LEAD_PANE" ]; then
  jq -n \
    --arg slug "$SLUG" \
    --arg logFile "$WATCHER_LOG" \
    --arg paneId "$ROOT_PANE" \
    --arg agentLabel "$SLUG" \
    --arg worktreePath "$WORKTREE_PATH" \
    --arg spawnedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg leadPane "$LEAD_PANE" \
    --arg leadCwd "$PWD" \
    --arg base "$BASE_BRANCH" \
    --arg repoRoot "$REPO_ROOT" \
    --arg workspaceId "<workspace_id>" \
    '{
      slug: $slug,
      logFile: $logFile,
      paneId: $paneId,
      agentLabel: $agentLabel,
      worktreePath: $worktreePath,
      spawnedAt: $spawnedAt,
      base: $base,
      repoRoot: $repoRoot,
      workspaceId: $workspaceId,
      lead: { paneId: $leadPane, cwd: $leadCwd }
    }' > "$STATE_FILE"
else
  jq -n \
    --arg slug "$SLUG" \
    --arg logFile "$WATCHER_LOG" \
    --arg paneId "$ROOT_PANE" \
    --arg agentLabel "$SLUG" \
    --arg worktreePath "$WORKTREE_PATH" \
    --arg spawnedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      slug: $slug,
      logFile: $logFile,
      paneId: $paneId,
      agentLabel: $agentLabel,
      worktreePath: $worktreePath,
      spawnedAt: $spawnedAt
    }' > "$STATE_FILE"
fi
```

Send the brief after the state file exists (skip if no user args):

```bash
~/.pi/agent/skills/lead/scripts/prompt.sh "$SLUG" --file "$PROMPT_FILE"
```

`prompt.sh` confirms delivery and resends once. The spawning agent returns immediately.

**Why this is non-blocking**: `nohup ... &` forks the python into its own process. `disown` removes it from the shell's job table so bash exits immediately without waiting. The spawning shell returns in single-digit milliseconds — verified.

Read the watcher log anytime:

```bash
tail -f <path>/.herdr-watch.log
```

Stop it manually only after verifying `/proc/<pid>/cmdline` contains `herdr-watch.py`:

```bash
kill "$(cat <path>/.herdr-watcher.pid)"
```

### 5. Report

```
Spawned worker
  slug:      <SLUG>
  branch:    worktree/<SLUG>
  path:      <path>
  workspace: <workspace_id>
  pane:      <root_pane_id>
  agent:     ${SLUG}  (pi, worker profile)
  prompt:    "<first 80 chars of user request>"
  watcher:   <path>/.herdr-watch.log  (tail -f to follow)
  footer:    related worktree footer "<slug> · Working/Idle · <time>"
Follow along: herdr agent attach ${SLUG}
```

The footer entry appears only in the matching worktree session. The
`worktree-watcher-status` extension polls the watcher log file every 2s and
shows a human-readable state such as `social-slides · Working · 21:45:09`.
State file at `~/.pi/agent/state/worktree-watchers/<slug>.json` controls registration.

## Don't

- Use Herdr's random default name (`worktree/<random>`)
- Run `git worktree add` directly — go through `herdr worktree create` so Herdr tracks the workspace
- Pass the raw user args without the context+worker framing — the new agent starts with zero history
- Pass the prompt as a CLI arg to `herdr agent start` — use `prompt.sh` or `herdr agent prompt` afterward
- `--wait` on `agent prompt` unless the user explicitly asked to block
- `pkill -f` / `pgrep -f | kill` — the pattern matches your own shell; kill the saved watcher PID after checking `/proc/<pid>/cmdline`

## See also

- `/skill:lead` — one lead, several worktree workers with finish notifications
- `herdr --skill` · `herdr worktree --help` · `herdr agent prompt --help`
- `~/.pi/agent/AGENTS.md` — cross-project operating rules
- `docs/agent-stack/ROUTING.md` in dotfiles (if present) — model tiers per task type

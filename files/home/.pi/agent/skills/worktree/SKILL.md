---
name: worktree
description: Spawn a git worktree in the current repo as a Herdr workspace and start a fresh pi implementation worker, with the spawning session's context. Use when the user wants parallel work in an isolated branch (e.g. "/worktree implement user auth"). Requires the herdr CLI.
---

# Worktree

Spawn a git worktree, open it as a Herdr workspace, start a pi **worker** with context carried from the spawning session, and leave a background watcher logging lifecycle events to the worktree.

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

### 3. Start worker + send (fire-and-forget)

```bash
herdr agent start "${SLUG}" --kind pi --pane <root_pane_id> --timeout 60000 -- --model 'cursor-ide/composer-2.5:high'
herdr agent prompt "${SLUG}" "$(< "$PROMPT_FILE")"
```

Skip the prompt line if no args were passed. The spawning agent returns immediately.

### 4. Start background watcher (logs pane lifecycle to the worktree)

Subscribes to the Herdr socket and appends `pane.agent_status_changed` + `pane.exited` events to `<worktree_path>/.herdr-watch.log`. Exits when the pane closes.

The spawning agent **does not wait** — the watcher is launched with `nohup ... & disown` so the shell returns in milliseconds while python keeps running in its own process.

```bash
WATCHER_LOG="<worktree_path>/.herdr-watch.log"
WATCHER_PID_FILE="<worktree_path>/.herdr-watcher.pid"
WATCHER_SCRIPT="$(mktemp -t wt-watcher.XXXXXX.py)"

# Write the watcher Python to a temp file (1 syscall, instant)
cat > "$WATCHER_SCRIPT" <<'PYEOF'
import os, socket, json, time
sock_path = os.environ.get("HERDR_SOCK", os.path.expanduser("~/.config/herdr/herdr.sock"))
pane_id   = os.environ["HERDR_PANE_ID"]
label     = os.environ["HERDR_AGENT_LABEL"]
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(3600)
    s.connect(sock_path)
    s.sendall((json.dumps({
        "jsonrpc": "2.0", "id": "watcher",
        "method": "events.subscribe",
        "params": {"subscriptions": [
            {"type": "pane.agent_status_changed", "pane_id": pane_id},
            {"type": "pane.exited",               "pane_id": pane_id},
        ]}
    }) + "\n").encode())
    print(f"[{time.strftime('%H:%M:%S')}] subscribed pane={pane_id} label={label}", flush=True)
    buf = b""
    while True:
        chunk = s.recv(4096)
        if not chunk: break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip(): continue
            try:
                evt = json.loads(line.decode())
            except Exception:
                continue
            kind = evt.get("event", "?")
            data = evt.get("data", {})
            ts = time.strftime("%H:%M:%S")
            if kind == "pane.agent_status_changed":
                status = data.get("agent_status", "")
                agent  = data.get("agent") or data.get("display_agent") or "?"
                print(f"[{ts}] {label}: status={status} agent={agent}", flush=True)
                if status == "blocked":
                    print(f"[{ts}] {label}: BLOCKED — needs user input", flush=True)
            elif kind == "pane.exited":
                print(f"[{ts}] {label}: pane exited", flush=True)
                s.close()
                break
except Exception as e:
    print(f"[watcher-error] {e}", flush=True)
PYEOF

# Launch in true background sub-process. Returns to caller in <50ms.
HERDR_PANE_ID="<root_pane_id>" HERDR_AGENT_LABEL="${SLUG}" \
  nohup python3 -u "$WATCHER_SCRIPT" >> "$WATCHER_LOG" 2>&1 &
WATCHER_PID=$!
disown
echo "$WATCHER_PID" > "$WATCHER_PID_FILE"

# Register the watcher so the matching worktree session's footer shows its
# latest event (picked up by the `worktree-watcher-status` extension, which polls
# every 2s).
mkdir -p "$HOME/.pi/agent/state/worktree-watchers"
cat > "$HOME/.pi/agent/state/worktree-watchers/${SLUG}.json" <<STATEEOF
{
  "slug": "${SLUG}",
  "logFile": "${WATCHER_LOG}",
  "paneId": "${HERDR_PANE_ID}",
  "agentLabel": "${SLUG}",
  "worktreePath": "$(dirname "$WATCHER_LOG")",
  "spawnedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
STATEEOF
```

**Why this is non-blocking**: `nohup ... &` forks the python into its own process. `disown` removes it from the shell's job table so bash exits immediately without waiting. The spawning shell returns in single-digit milliseconds — verified.

Read the watcher log anytime:

```bash
tail -f <path>/.herdr-watch.log
```

Stop it manually:

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
- Pass the prompt as a CLI arg to `herdr agent start` — always `agent prompt` afterward
- `--wait` on `agent prompt` unless the user explicitly asked to block

## See also

- `herdr --skill` · `herdr worktree --help` · `herdr agent prompt --help`
- `~/.pi/agent/AGENTS.md` — cross-project operating rules
- `docs/agent-stack/ROUTING.md` in dotfiles (if present) — model tiers per task type

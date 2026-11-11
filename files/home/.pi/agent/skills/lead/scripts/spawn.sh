#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SLUG=""
BRIEF=""
REPO=""
BASE=""
MODEL="claude-bridge/claude-sonnet-5-5:medium"
SETUP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) SLUG="${2:?}"; shift 2 ;;
    --brief) BRIEF="${2:?}"; shift 2 ;;
    --repo) REPO="${2:?}"; shift 2 ;;
    --base) BASE="${2:?}"; shift 2 ;;
    --model) MODEL="${2:?}"; shift 2 ;;
    --setup) SETUP="${2:?}"; shift 2 ;;
    -h|--help)
      usage_die "Usage: spawn.sh --slug S --brief FILE [--repo ROOT] [--base BRANCH] [--model ID] [--setup CMD]"
      ;;
    *) usage_die "Usage: spawn.sh --slug S --brief FILE [--repo ROOT] [--base BRANCH] [--model ID] [--setup CMD]" ;;
  esac
done

[[ -n "$SLUG" && -n "$BRIEF" ]] || usage_die "Usage: spawn.sh --slug S --brief FILE [--repo ROOT] [--base BRANCH] [--model ID] [--setup CMD]"
validate_slug "$SLUG"
[[ -f "$BRIEF" ]] || { echo "brief file not found: $BRIEF" >&2; exit 2; }

if [[ -z "$REPO" ]]; then
  REPO="$(git rev-parse --show-toplevel)"
fi
if [[ -z "$BASE" ]]; then
  BASE="$(git -C "$REPO" branch --show-current)"
fi

if branch_worktree_exists "$REPO" "$SLUG"; then
  echo "branch worktree/${SLUG} already exists in repo" >&2
  exit 1
fi
if agent_name_exists "$SLUG"; then
  echo "herdr agent named ${SLUG} already exists" >&2
  exit 1
fi

REPO_NAME="$(basename "$REPO")"
WT_PATH="$HOME/.herdr/worktrees/${REPO_NAME}/${SLUG}"
LEAD_PANE="${HERDR_PANE_ID:-}"
LEAD_CWD="$PWD"

set +e
CREATE_OUT="$(herdr worktree create \
  --cwd "$REPO" \
  --branch "worktree/${SLUG}" \
  --path "$WT_PATH" \
  --label "$SLUG" 2>&1)"
CREATE_RC=$?
set -e
if [[ $CREATE_RC -ne 0 ]]; then
  printf '%s\n' "$CREATE_OUT"
  exit 1
fi

PANE_ID="$(jq -r '.result.root_pane.pane_id // empty' <<<"$CREATE_OUT")"
WORKSPACE_ID="$(jq -r '.result.workspace.workspace_id // empty' <<<"$CREATE_OUT")"
WT_PATH="$(jq -r '.result.worktree.path // empty' <<<"$CREATE_OUT")"
if [[ -z "$PANE_ID" || -z "$WORKSPACE_ID" || -z "$WT_PATH" ]]; then
  printf '%s\n' "$CREATE_OUT"
  echo "failed to parse worktree create JSON" >&2
  exit 1
fi

SETUP_LOG="$WT_PATH/.herdr-setup.log"
: >"$SETUP_LOG"
if [[ -f "$REPO/.herdr/worktree-setup.sh" ]]; then
  if ! (cd "$WT_PATH" && REPO_ROOT="$REPO" bash "$REPO/.herdr/worktree-setup.sh" >>"$SETUP_LOG" 2>&1); then
    tail -20 "$SETUP_LOG" >&2
    exit 1
  fi
fi
if [[ -n "$SETUP" ]]; then
  if ! (cd "$WT_PATH" && bash -c "$SETUP" >>"$SETUP_LOG" 2>&1); then
    tail -20 "$SETUP_LOG" >&2
    exit 1
  fi
fi

if ! herdr agent start "$SLUG" --kind pi --pane "$PANE_ID" --timeout 60000 -- --model "$MODEL"; then
  echo "herdr agent start failed" >&2
  exit 1
fi

WATCHER_PY="$(watcher_script_path)"
WATCHER_LOG="$WT_PATH/.herdr-watch.log"
touch "$WATCHER_LOG"
HERDR_PANE_ID="$PANE_ID" HERDR_AGENT_LABEL="$SLUG" \
  nohup python3 -u "$WATCHER_PY" >>"$WATCHER_LOG" 2>&1 &
WATCHER_PID=$!
disown
printf '%s\n' "$WATCHER_PID" >"$WT_PATH/.herdr-watcher.pid"

ensure_herdr_gitexclude "$WT_PATH"

SPAWNED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_worker_state "$SLUG" "$WATCHER_LOG" "$PANE_ID" "$SLUG" "$WT_PATH" "$SPAWNED_AT" \
  "$BASE" "$REPO" "$WORKSPACE_ID" "$LEAD_PANE" "$LEAD_CWD"

PROMPT_RC=0
if ! "$SCRIPT_DIR/prompt.sh" "$SLUG" --file "$BRIEF"; then
  echo "WARN: initial prompt to worker ${SLUG} may not have landed" >&2
  PROMPT_RC=1
fi

echo "slug=${SLUG}"
echo "branch=worktree/${SLUG}"
echo "path=${WT_PATH}"
echo "pane=${PANE_ID}"
echo "workspace=${WORKSPACE_ID}"
echo "model=${MODEL}"

exit "$PROMPT_RC"

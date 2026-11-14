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

for dependency in hc jq python3; do
  command -v "$dependency" >/dev/null || { echo "missing dependency: $dependency" >&2; exit 1; }
done
[[ -n "$BASE" ]] || { echo "detached HEAD: supply --base" >&2; exit 1; }
PI_BIN="$(command -v pi)" || { echo "pi missing from caller PATH" >&2; exit 1; }

if branch_worktree_exists "$REPO" "$SLUG"; then
  echo "branch worktree/${SLUG} already exists in repo" >&2
  exit 1
fi
if agent_name_exists "$SLUG"; then
  echo "hc terminal named ${SLUG} already exists" >&2
  exit 1
else
  rc=$?
  [[ "$rc" -eq 1 ]] || { echo "hc inventory failed; no worktree created" >&2; exit 1; }
fi

REPO_NAME="$(basename "$REPO")"
WT_PATH="$HOME/.herdr/worktrees/${REPO_NAME}/${SLUG}"
LEAD_TERMINAL="${HC_TERMINAL_ID:-}"
LEAD_CWD="$PWD"

# Existing ~/.herdr/worktrees directories are user data: never replace them.
[[ ! -e "$WT_PATH" ]] || { echo "worktree path already exists: $WT_PATH" >&2; exit 1; }
git -C "$REPO" worktree add -b "worktree/${SLUG}" "$WT_PATH" "$BASE"
WORKSPACE_ID="$SLUG"

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

LAUNCH="$(python3 - "$PI_BIN" "$MODEL" <<'PY'
from pathlib import Path
import shlex
import sys
pi, model = sys.argv[1:]
print('PATH=' + shlex.quote(str(Path(pi).parent)) + ':$PATH exec ' + shlex.join([pi, '--model', model]))
PY
)"
CREATE_OUT="$(hc run --bg --no-parent --name "$SLUG" --cwd "$WT_PATH" \
  --label "herdr.space=$SLUG" --label "herdr.tab=$SLUG:t1" \
  --label "ovis.workspace=$SLUG" --label "ovis.tab=worker" --label "ovis.pane=$SLUG" \
  --label "dotfiles.worker=$SLUG" "$LAUNCH")"
TERMINAL="$(jq -er '.address' <<<"$CREATE_OUT")"
write_worker_state "$SLUG" "$TERMINAL" "$WT_PATH" "$BASE" "$REPO" "$LEAD_TERMINAL" "$LEAD_CWD"

hc wait "$TERMINAL" --timeout 60 >/dev/null
READY="$(hc get "$TERMINAL")"
if ! jq -e '.state == "live" and .status.app == "pi" and (.status.state == "idle" or .status.state == "done")' <<<"$READY" >/dev/null; then
  echo "worker not ready; inspect hc read $TERMINAL before sending its brief" >&2
  exit 1
fi

PROMPT_RC=0
if ! "$SCRIPT_DIR/prompt.sh" "$SLUG" --file "$BRIEF"; then
  echo "WARN: prompt failed; inspect hc read ${TERMINAL} before retrying" >&2
  PROMPT_RC=1
fi

echo "slug=${SLUG}"
echo "branch=worktree/${SLUG}"
echo "path=${WT_PATH}"
echo "terminal=${TERMINAL}"
echo "workspace=${WORKSPACE_ID}"
echo "model=${MODEL}"

exit "$PROMPT_RC"

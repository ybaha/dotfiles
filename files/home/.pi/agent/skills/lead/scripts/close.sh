#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

FORCE=false
SLUG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=true; shift ;;
    -h|--help) usage_die "Usage: close.sh SLUG [--force]" ;;
    *)
      [[ -z "$SLUG" ]] || usage_die "Usage: close.sh SLUG [--force]"
      SLUG="$1"
      shift
      ;;
  esac
done

[[ -n "$SLUG" ]] || usage_die "Usage: close.sh SLUG [--force]"

STATE_FILE="$(state_file_for "$SLUG")"
if [[ ! -f "$STATE_FILE" ]]; then
  if [[ "$FORCE" == true ]]; then
    echo "state file missing (required without path guess): $STATE_FILE" >&2
  fi
  echo "state file missing: $STATE_FILE" >&2
  exit 1
fi

WT="$(jq -r '.worktreePath' "$STATE_FILE")"
REPO="$(jq -r '.repoRoot' "$STATE_FILE")"
BASE="$(jq -r '.base // "master"' "$STATE_FILE")"
WSID="$(jq -r '.workspaceId // empty' "$STATE_FILE")"

if [[ "$FORCE" != true ]]; then
  if ! is_branch_merged_into_base "$REPO" "$SLUG" "$BASE"; then
    echo "refuse: worktree/${SLUG} is not merged into ${BASE} (use --force)" >&2
    exit 1
  fi
  if has_uncommitted_non_herdr "$WT"; then
    echo "refuse: worktree has uncommitted changes (excluding .herdr-*)" >&2
    exit 1
  fi
fi

stop_watcher_if_ours "$WT"

rm -f "$STATE_FILE"
echo "state: removed ${SLUG}.json"

if [[ -z "$WSID" ]]; then
  WSID="$(resolve_workspace_id "$WT")"
fi
if [[ -n "$WSID" ]]; then
  if herdr worktree remove --workspace "$WSID" --force; then
    echo "worktree: removed workspace ${WSID}"
  else
    echo "worktree: herdr remove failed for ${WSID}" >&2
  fi
else
  echo "worktree: workspace id unknown (skipped herdr remove)" >&2
fi

git -C "$REPO" worktree prune
echo "git: worktree prune in ${REPO}"

BRANCH_DEL=0
if [[ "$FORCE" == true ]]; then
  git -C "$REPO" branch -D "worktree/${SLUG}" && BRANCH_DEL=1 || true
else
  if git -C "$REPO" branch -d "worktree/${SLUG}"; then
    BRANCH_DEL=1
  else
    echo "branch: could not delete worktree/${SLUG}" >&2
    exit 1
  fi
fi
if [[ "$BRANCH_DEL" -eq 1 ]]; then
  echo "branch: deleted worktree/${SLUG}"
fi

echo "close: ${SLUG} done"

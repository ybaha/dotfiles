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
validate_slug "$SLUG"

STATE_FILE="$(state_file_for "$SLUG")"
if [[ ! -f "$STATE_FILE" ]]; then
  if [[ "$FORCE" == true ]]; then
    echo "state file missing (required without path guess): $STATE_FILE" >&2
  fi
  echo "state file missing: $STATE_FILE" >&2
  exit 1
fi

resolve_state_fields "$STATE_FILE"
TERMINAL="$(terminal_for_state "$STATE_FILE")"

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

INFO="$(hc get "$TERMINAL")"
if ! jq -e --arg slug "$SLUG" --arg cwd "$WT" '.cwd == $cwd and .labels["dotfiles.worker"] == $slug' <<<"$INFO" >/dev/null; then
  echo "refuse: terminal ownership/cwd differs from worker state" >&2
  exit 1
fi
if [[ "$(jq -r '.state' <<<"$INFO")" == live ]]; then
  hc kill "$TERMINAL" >/dev/null
fi
hc rm "$TERMINAL" >/dev/null
rm -f "$STATE_FILE"
echo "close: ${SLUG} terminal and state removed"
echo "retained: $WT and worktree/${SLUG}; worktree deletion requires separate owner approval"

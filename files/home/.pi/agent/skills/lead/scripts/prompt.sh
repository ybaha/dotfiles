#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SLUG=""
BRIEF_FILE=""
TEXT_MSG=""

if [[ $# -lt 1 ]]; then
  usage_die "Usage: prompt.sh SLUG (--file F | --text MSG)"
fi
SLUG="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) BRIEF_FILE="${2:?}"; shift 2 ;;
    --text) TEXT_MSG="${2:?}"; shift 2 ;;
    *) usage_die "Usage: prompt.sh SLUG (--file F | --text MSG)" ;;
  esac
done

if [[ -n "$BRIEF_FILE" && -n "$TEXT_MSG" ]] || [[ -z "$BRIEF_FILE" && -z "$TEXT_MSG" ]]; then
  usage_die "Usage: prompt.sh SLUG (--file F | --text MSG)"
fi
if [[ -n "$BRIEF_FILE" && ! -f "$BRIEF_FILE" ]]; then
  echo "file not found: $BRIEF_FILE" >&2
  exit 2
fi

validate_slug "$SLUG"
STATE_FILE="$(state_file_for "$SLUG")"
[[ -f "$STATE_FILE" ]] || { echo "state missing: $STATE_FILE" >&2; exit 2; }

TERMINAL="$(terminal_for_state "$STATE_FILE")"
INFO="$(hc get "$TERMINAL")"
EXPECTED_CWD="$(jq -r '.worktreePath // empty' "$STATE_FILE")"
if ! jq -e --arg slug "$SLUG" --arg cwd "$EXPECTED_CWD" '.state == "live" and .cwd == $cwd and .labels["dotfiles.worker"] == $slug' <<<"$INFO" >/dev/null; then
  echo "refuse: worker terminal ownership/cwd changed or terminal finished" >&2
  exit 1
fi

PROMPT_TEXT=""
if [[ -n "$BRIEF_FILE" ]]; then
  PROMPT_TEXT="$(<"$BRIEF_FILE")"
else
  PROMPT_TEXT="$TEXT_MSG"
fi

# hc refuses blocked dialogs; never force or automatically repeat uncertain input.
hc send "$TERMINAL" "$PROMPT_TEXT"
echo "prompt submitted once; inspect hc get/read $TERMINAL if delivery is uncertain"

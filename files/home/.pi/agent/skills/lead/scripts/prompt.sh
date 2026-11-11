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

STATE_FILE="$(state_file_for "$SLUG")"
[[ -f "$STATE_FILE" ]] || { echo "state missing: $STATE_FILE" >&2; exit 2; }

LOG_FILE="$(jq -r '.logFile // empty' "$STATE_FILE")"
[[ -n "$LOG_FILE" ]] || { echo "state has no logFile: $STATE_FILE" >&2; exit 2; }
[[ -f "$LOG_FILE" ]] || touch "$LOG_FILE"

PROMPT_TEXT=""
if [[ -n "$BRIEF_FILE" ]]; then
  PROMPT_TEXT="$(<"$BRIEF_FILE")"
else
  PROMPT_TEXT="$TEXT_MSG"
fi

# New status=working lines after this point count as delivery; also accept if the
# last status line after the point is already working (worker mid-turn).
wait_for_working() {
  local start_lines="$1"
  local deadline=$((SECONDS + 45))
  while [[ $SECONDS -lt $deadline ]]; do
    if tail -n +"$((start_lines + 1))" "$LOG_FILE" | grep -qE 'status=working'; then
      return 0
    fi
    local last
    last="$(tail -n +"$((start_lines + 1))" "$LOG_FILE" | grep -E 'status=' | tail -1 || true)"
    if [[ "$last" == *status=working* ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

send_prompt() {
  herdr agent prompt "$SLUG" "$PROMPT_TEXT" >/dev/null
}

wait_for_pi_ready() {
  local out
  out="$(herdr agent read "$SLUG" 2>/dev/null || true)"
  if [[ -n "$out" ]] && { [[ "$out" == *model* ]] || [[ "$out" == *'>'* ]] || [[ "$out" == *'│'* ]] || [[ "$out" == *'╭'* ]]; }; then
    return 0
  fi
  sleep 10
}

START_LINES="$(wc -l <"$LOG_FILE")"
send_prompt

if wait_for_working "$START_LINES"; then
  echo "prompt delivered"
  exit 0
fi

wait_for_pi_ready
START_LINES="$(wc -l <"$LOG_FILE")"
send_prompt

if wait_for_working "$START_LINES"; then
  echo "prompt delivered"
  exit 0
fi

echo "WARN: worker ${SLUG} did not start working after re-send" >&2
exit 3

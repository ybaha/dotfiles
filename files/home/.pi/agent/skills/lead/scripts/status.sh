#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SHOW_ALL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) SHOW_ALL=true; shift ;;
    -h|--help) usage_die "Usage: status.sh [--all]" ;;
    *) usage_die "Usage: status.sh [--all]" ;;
  esac
done

DIR="$(state_dir)"
[[ -d "$DIR" ]] || { echo "no workers"; exit 0; }

mapfile -t FILES < <(find "$DIR" -maxdepth 1 -name '*.json' -type f 2>/dev/null | sort)
[[ ${#FILES[@]} -gt 0 ]] || { echo "no workers"; exit 0; }

LEAD_PANE="${HERDR_PANE_ID:-}"
LEAD_CWD="$PWD"

matches_lead() {
  local f="$1"
  if [[ "$SHOW_ALL" == true ]]; then
    return 0
  fi
  if [[ -n "$LEAD_PANE" ]]; then
    jq -e --arg p "$LEAD_PANE" '.lead.paneId == $p' "$f" >/dev/null 2>&1
  else
    jq -e --arg c "$LEAD_CWD" '.lead.cwd == $c' "$f" >/dev/null 2>&1
  fi
}

last_watch_line() {
  local log="$1"
  [[ -f "$log" ]] || { echo "—"; return; }
  local line
  line="$(grep -E 'status=|pane exited' "$log" | tail -1 || true)"
  [[ -n "$line" ]] || { echo "—"; return; }
  if [[ "$line" == *pane\ exited* ]]; then
    if [[ "$line" =~ ^\[([0-9:]+)\] ]]; then
      echo "exited ${BASH_REMATCH[1]}"
    else
      echo "exited"
    fi
    return
  fi
  local status time_part
  status="${line#*status=}"
  status="${status%% *}"
  if [[ "$line" =~ ^\[([0-9:]+)\] ]]; then
    time_part="${BASH_REMATCH[1]}"
  else
    time_part="?"
  fi
  echo "${status} ${time_part}"
}

printf "%-16s %-24s %5s %5s %6s\n" "SLUG" "LAST" "AHEAD" "DIRTY" "MERGED"
found=0

for f in "${FILES[@]}"; do
  matches_lead "$f" || continue
  found=1
  slug="$(jq -r '.slug' "$f")"
  log="$(jq -r '.logFile // empty' "$f")"
  resolve_state_fields "$f"
  wt="$WT"
  repo="$REPO"
  base="$BASE"

  if [[ -z "$wt" || ! -d "$wt" ]]; then
    printf "%-16s %-24s %5s %5s %6s\n" "$slug" "gone" "—" "—" "—"
    continue
  fi

  ahead="?"
  if git -C "$wt" rev-parse --verify "$base" >/dev/null 2>&1; then
    ahead="$(git -C "$wt" rev-list --count "${base}..HEAD" 2>/dev/null || echo "?")"
  elif [[ -n "$repo" ]] && git -C "$repo" rev-parse --verify "$base" >/dev/null 2>&1; then
    ahead="$(git -C "$wt" rev-list --count "${base}..HEAD" 2>/dev/null || echo "?")"
  fi

  dirty="$(count_dirty_excluding_herdr "$wt")"

  merged="no"
  if [[ -n "$repo" ]] && is_branch_merged_into_base "$repo" "$slug" "$base"; then
    merged="yes"
  fi

  last="$(last_watch_line "$log")"
  printf "%-16s %-24s %5s %5s %6s\n" "$slug" "$last" "$ahead" "$dirty" "$merged"
done

[[ "$found" -eq 1 ]] || echo "no workers"

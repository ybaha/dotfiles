#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPTS="$ROOT/files/home/.pi/agent/skills/lead/scripts"

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

main_repo="$scratch/main"
wt_path="$scratch/wt"
state_dir="$scratch/state"
mkdir -p "$state_dir" "$main_repo"

export WORKTREE_WATCHERS_DIR="$state_dir"

(
  cd "$main_repo"
  git init -b master >/dev/null
  git config user.email "test@test"
  git config user.name "test"
  printf 'main\n' >README.md
  git add README.md
  git commit -m "init" >/dev/null
  git worktree add -b worktree/fix1 "$wt_path" >/dev/null
)

(
  cd "$wt_path"
  printf 'fix\n' >>README.md
  git add README.md
  git commit -m "fix" >/dev/null
)

(
  cd "$main_repo"
  git merge --no-edit worktree/fix1 >/dev/null
)

log_file="$wt_path/fix1.log"
printf '[00:00:00] fix1: subscribed\n' >"$log_file"

jq -n \
  --arg slug fix1 \
  --arg worktreePath "$wt_path" \
  --arg logFile "$log_file" \
  '{slug:$slug, worktreePath:$worktreePath, logFile:$logFile}' \
  >"$state_dir/fix1.json"

# shellcheck source=lib.sh
source "$SCRIPTS/lib.sh"

resolve_state_fields "$state_dir/fix1.json"

if [[ "$REPO" != "$main_repo" ]]; then
  echo "expected REPO=$main_repo got REPO=$REPO" >&2
  exit 1
fi

if ! is_branch_merged_into_base "$REPO" fix1 "$BASE"; then
  echo "expected branch merged into $BASE" >&2
  exit 1
fi

status_out=$("$SCRIPTS/status.sh" --all)
if ! grep -qE 'fix1\s+.*\s+yes\s*$' <<<"$status_out"; then
  echo "status.sh --all did not show merged yes:" >&2
  echo "$status_out" >&2
  exit 1
fi

echo "lead-close-fallback: ok"

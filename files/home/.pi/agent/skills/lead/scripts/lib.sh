# Shared helpers for lead worktree scripts.
# shellcheck shell=bash

state_dir() {
  if [[ -n "${WORKTREE_WATCHERS_DIR:-}" ]]; then
    printf '%s' "$WORKTREE_WATCHERS_DIR"
    return
  fi
  printf '%s/.pi/agent/state/worktree-watchers' "$HOME"
}

resolve_state_fields() {
  local file="$1"
  WT="$(jq -r '.worktreePath // empty' "$file")"
  if [[ -z "$WT" ]]; then
    local log_file
    log_file="$(jq -r '.logFile // empty' "$file")"
    if [[ -n "$log_file" ]]; then
      WT="$(dirname "$log_file")"
    fi
  fi

  REPO="$(jq -r '.repoRoot // empty' "$file")"
  if [[ -z "$REPO" ]] && [[ -n "$WT" ]]; then
    local common_git
    common_git="$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    if [[ -n "$common_git" ]]; then
      REPO="$(dirname "$common_git")"
    fi
  fi

  BASE="$(jq -r '.base // empty' "$file")"
  if [[ -z "$BASE" ]] && [[ -n "$REPO" ]]; then
    BASE="$(git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null || true)"
  fi
  if [[ -z "$BASE" ]]; then
    BASE="master"
  fi
}

state_file_for() {
  printf '%s/%s.json' "$(state_dir)" "$1"
}

usage_die() {
  echo "$1" >&2
  exit 2
}

validate_slug() {
  local slug="$1"
  if [[ ! "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    echo "invalid slug: $slug" >&2
    exit 2
  fi
  if ((${#slug} > 16)); then
    echo "slug too long (max 16): $slug" >&2
    exit 2
  fi
}

watcher_script_path() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")" && pwd)"
  printf '%s/../../worktree/scripts/herdr-watch.py' "$script_dir"
}

ensure_herdr_gitexclude() {
  local wt="$1"
  local exclude
  exclude="$(git -C "$wt" rev-parse --git-path info/exclude)"
  if ! grep -qF '.herdr-*' "$exclude" 2>/dev/null; then
    printf '\n.herdr-*\n' >>"$exclude"
  fi
}

agent_name_exists() {
  local slug="$1"
  herdr agent list | jq -e --arg n "$slug" '.result.agents[] | select(.name == $n)' >/dev/null 2>&1
}

branch_worktree_exists() {
  local repo="$1" slug="$2"
  git -C "$repo" show-ref --verify --quiet "refs/heads/worktree/${slug}"
}

count_dirty_excluding_herdr() {
  local wt="$1"
  local count=0 line path
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    path="${line:3}"
    path="${path%% *}"
    [[ "$path" == .herdr-* ]] && continue
    count=$((count + 1))
  done < <(git -C "$wt" status --porcelain)
  echo "$count"
}

has_uncommitted_non_herdr() {
  local wt="$1"
  [[ "$(count_dirty_excluding_herdr "$wt")" -gt 0 ]]
}

is_branch_merged_into_base() {
  local repo="$1" slug="$2" base="$3"
  git -C "$repo" merge-base --is-ancestor "worktree/${slug}" "$base"
}

write_worker_state() {
  local slug log_file pane_id agent_label wt_path spawned_at base repo_root workspace_id
  local lead_pane lead_cwd
  slug="$1"
  log_file="$2"
  pane_id="$3"
  agent_label="$4"
  wt_path="$5"
  spawned_at="$6"
  base="$7"
  repo_root="$8"
  workspace_id="$9"
  lead_pane="${10:-}"
  lead_cwd="${11:-}"

  local dir tmp out
  dir="$(state_dir)"
  mkdir -p "$dir"
  tmp="${dir}/.${slug}.json.$$"
  out="${dir}/${slug}.json"

  if [[ -n "$lead_pane" ]]; then
    jq -n \
      --arg slug "$slug" \
      --arg logFile "$log_file" \
      --arg paneId "$pane_id" \
      --arg agentLabel "$agent_label" \
      --arg worktreePath "$wt_path" \
      --arg spawnedAt "$spawned_at" \
      --arg leadPane "$lead_pane" \
      --arg leadCwd "$lead_cwd" \
      --arg base "$base" \
      --arg repoRoot "$repo_root" \
      --arg workspaceId "$workspace_id" \
      '{slug:$slug, logFile:$logFile, paneId:$paneId, agentLabel:$agentLabel, worktreePath:$worktreePath, spawnedAt:$spawnedAt, lead:{paneId:$leadPane, cwd:$leadCwd}, base:$base, repoRoot:$repoRoot, workspaceId:$workspaceId}' \
      >"$tmp"
  else
    jq -n \
      --arg slug "$slug" \
      --arg logFile "$log_file" \
      --arg paneId "$pane_id" \
      --arg agentLabel "$agent_label" \
      --arg worktreePath "$wt_path" \
      --arg spawnedAt "$spawned_at" \
      --arg base "$base" \
      --arg repoRoot "$repo_root" \
      --arg workspaceId "$workspace_id" \
      '{slug:$slug, logFile:$logFile, paneId:$paneId, agentLabel:$agentLabel, worktreePath:$worktreePath, spawnedAt:$spawnedAt, base:$base, repoRoot:$repoRoot, workspaceId:$workspaceId}' \
      >"$tmp"
  fi
  mv "$tmp" "$out"
}

stop_watcher_if_ours() {
  local wt="$1"
  local pid_file="$wt/.herdr-watcher.pid"
  [[ -f "$pid_file" ]] || { echo "watcher: no pid file"; return 0; }
  local pid
  pid="$(<"$pid_file")"
  local cmdline="/proc/${pid}/cmdline"
  if [[ ! -r "$cmdline" ]]; then
    echo "watcher: pid $pid not running"
    return 0
  fi
  local cmd
  cmd="$(tr '\0' ' ' <"$cmdline")"
  if [[ "$cmd" != *herdr-watch.py* ]]; then
    echo "watcher: pid $pid cmdline does not match herdr-watch.py (skip)"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  local i=0
  while [[ $i -lt 20 ]] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.1
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "watcher: pid $pid still alive after 2s" >&2
  else
    echo "watcher: stopped pid $pid"
  fi
}

resolve_workspace_id() {
  local wt_path="$1"
  herdr workspace list | jq -r --arg p "$wt_path" '.result.workspaces[]? | select(.worktree.checkout_path == $p) | .workspace_id' | head -1
}

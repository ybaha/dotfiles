# Shared helpers for lead worktree scripts.
# shellcheck shell=bash

state_dir() {
  printf '%s' "${WORKTREE_WATCHERS_DIR:-$HOME/.pi/agent/state/worktree-watchers}"
}

resolve_state_fields() {
  local file="$1"
  WT="$(jq -r '.worktreePath // empty' "$file")"
  if [[ -z "$WT" ]]; then
    local log_file
    log_file="$(jq -r '.logFile // empty' "$file")"
    [[ -z "$log_file" ]] || WT="$(dirname "$log_file")"
  fi
  REPO="$(jq -r '.repoRoot // empty' "$file")"
  if [[ -z "$REPO" && -n "$WT" ]]; then
    local common_git
    common_git="$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    [[ -z "$common_git" ]] || REPO="$(dirname "$common_git")"
  fi
  BASE="$(jq -r '.base // empty' "$file")"
  if [[ -z "$BASE" && -n "$REPO" ]]; then
    BASE="$(git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null || true)"
  fi
  BASE="${BASE:-master}"
}

state_file_for() { printf '%s/%s.json' "$(state_dir)" "$1"; }
usage_die() { echo "$1" >&2; exit 2; }

validate_slug() {
  local slug="$1"
  [[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ && ${#slug} -le 16 ]] || usage_die "invalid slug (kebab-case, max 16): $slug"
}

agent_name_exists() {
  local terminals
  terminals="$(hc ls)" || return 2
  jq -e --arg n "$1" '.terminals | any(.name == $n and .state == "live")' <<<"$terminals" >/dev/null
}

terminal_for_state() {
  local terminal slug inventory replacement
  terminal="$(jq -r '.terminal // empty' "$1")"
  [[ "$terminal" =~ ^t[0-9]+$ ]] || { echo "state has no local hc terminal; migrate legacy state manually" >&2; return 1; }
  slug="$(jq -r '.slug' "$1")"
  inventory="$(hc ls)" || return 1
  # A Pi restart changes the address but preserves its unique live name.
  # Callers still verify cwd and dotfiles.worker before any input or close.
  replacement="$(jq -er --arg n "$slug" '[.terminals[] | select(.name == $n and .state == "live")] | if length == 1 then .[0].address elif length == 0 then "" else error("ambiguous worker name") end' <<<"$inventory")" || return 1
  terminal="${replacement:-$terminal}"
  [[ "$terminal" =~ ^t[0-9]+$ ]] || { echo "refuse non-local hc target" >&2; return 1; }
  printf '%s' "$terminal"
}

branch_worktree_exists() {
  git -C "$1" show-ref --verify --quiet "refs/heads/worktree/${2}"
}

count_dirty_excluding_herdr() {
  local count=0 line path
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    path="${line:3}"
    path="${path%% *}"
    [[ "$path" == .herdr-* ]] && continue
    count=$((count + 1))
  done < <(git -C "$1" status --porcelain)
  echo "$count"
}

has_uncommitted_non_herdr() { [[ "$(count_dirty_excluding_herdr "$1")" -gt 0 ]]; }

is_branch_merged_into_base() {
  git -C "$1" merge-base --is-ancestor "worktree/${2}" "$3"
}

write_worker_state() {
  local slug="$1" terminal="$2" wt="$3" base="$4" repo="$5" lead="$6" lead_cwd="$7"
  local dir tmp
  dir="$(state_dir)"
  mkdir -p "$dir"
  tmp="${dir}/.${slug}.json.$$"
  jq -n --arg slug "$slug" --arg terminal "$terminal" --arg wt "$wt" \
    --arg base "$base" --arg repo "$repo" --arg lead "$lead" --arg cwd "$lead_cwd" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{slug:$slug, terminal:$terminal, worktreePath:$wt, base:$base, repoRoot:$repo,
      space:$slug, spawnedAt:$at, lead:{terminal:$lead, cwd:$cwd}}' >"$tmp"
  mv "$tmp" "${dir}/${slug}.json"
}

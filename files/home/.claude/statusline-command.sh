#!/bin/bash
# Claude Code statusLine: dir + git branch + model | context remaining | rate limits
input=$(cat)

dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd')
dir_short=$(basename "$dir")

branch=""
if git -C "$dir" --no-optional-locks rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$dir" --no-optional-locks branch --show-current 2>/dev/null)
  [ -n "$branch" ] && branch=" ($branch)"
fi

model=$(echo "$input" | jq -r '.model.display_name')

remaining=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')
ctx=""
[ -n "$remaining" ] && ctx=$(printf " | Ctx: %.0f%% left" "$remaining")

five=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
week=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
limits=""
if [ -n "$five" ] || [ -n "$week" ]; then
  limits=" |"
  [ -n "$five" ] && limits="$limits 5h:$(printf '%.0f' "$five")%"
  [ -n "$week" ] && limits="$limits 7d:$(printf '%.0f' "$week")%"
fi

printf '\033[2m%s%s | %s%s%s\033[0m' "$dir_short" "$branch" "$model" "$ctx" "$limits"

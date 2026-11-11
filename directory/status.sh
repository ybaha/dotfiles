#!/bin/sh
# Runs in the directory container every few minutes: probes health.tsv URLs, writes status.json.
dir=/srv/agents; tmp=$dir/status.json.tmp; tab=$(printf '\t')
{
  printf '{"checked_at":"%s","services":{' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  first=1
  while IFS="$tab" read -r id url; do
    [ -n "$id" ] || continue
    code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$url" 2>/dev/null); [ -n "$code" ] || code=000
    case $code in 2??|3??|401|403) ok=true ;; *) ok=false ;; esac
    [ $first = 1 ] || printf ','; first=0
    printf '"%s":{"ok":%s,"code":"%s"}' "$id" "$ok" "$code"
  done < "$dir/health.tsv"
  printf '}}\n'
} > "$tmp" && mv "$tmp" "$dir/status.json"

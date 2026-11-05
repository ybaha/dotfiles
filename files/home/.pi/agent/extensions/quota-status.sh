#!/usr/bin/env bash
# Print the cached quota/rate-limit state from
# ~/.cache/pi-orchestra/quota/<provider>.json. The quota-cache Pi extension
# owns all network fetches; this script just dumps the cache for humans and
# the legacy /usage parser.
#
# Usage: bash scripts/quota-status.sh

set -euo pipefail

if [ "$#" -ne 0 ]; then
  echo "usage: bash scripts/quota-status.sh" >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required" >&2
  exit 1
fi

python3 - <<'PY'
import json, time
from datetime import datetime
from pathlib import Path

CACHE = Path.home() / ".cache" / "pi-orchestra" / "quota"


def stamp(value):
    if value is None:
        return "unknown"
    try:
        value = float(value)
        if value > 100_000_000_000:
            value /= 1000
        return datetime.fromtimestamp(value).astimezone().strftime("%Y-%m-%d %H:%M %Z")
    except (TypeError, ValueError, OSError):
        return "unknown"


def age(value):
    try:
        seconds = max(0, time.time() - (float(value) / 1000))
    except (TypeError, ValueError):
        return "unknown age"
    if seconds < 90:
        return "just now"
    if seconds < 5400:
        return f"{round(seconds / 60)}m ago"
    if seconds < 172800:
        return f"{round(seconds / 3600)}h ago"
    return f"{round(seconds / 86400)}d ago"


def load(name):
    path = CACHE / f"{name}.json"
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def claude_block() -> str:
    snap = load("claude")
    if not snap:
        return "Claude Pro  unavailable (cache empty)"
    source = "live" if snap.get("live") else "cached"
    return (
        f"Claude Pro  {source} ({age(snap.get('fetchedAt'))}; refreshed {stamp(snap.get('fetchedAt'))})\n"
        f"  5h: {100 - snap.get('primaryLeft', 100)}% used / {snap.get('primaryLeft', 100)}% left — resets {stamp(snap.get('primaryResetsAt'))}\n"
        f"  7d: {100 - snap.get('weeklyLeft', 100)}% used / {snap.get('weeklyLeft', 100)}% left — resets {stamp(snap.get('weeklyResetsAt'))}"
    )


def cursor_block() -> str:
    snap = load("cursor")
    if not snap:
        return "Cursor IDE proxy  unknown (cache empty)"
    state = snap.get("state", "unknown")
    detail = snap.get("detail")
    suffix = f" ({detail})" if state == "unknown" and detail else ""
    return f"Cursor IDE proxy  {state} ({age(snap.get('fetchedAt'))}; refreshed {stamp(snap.get('fetchedAt'))}){suffix}"


def codex_block() -> str:
    snap = load("codex")
    if not snap:
        return "Codex  unavailable (cache empty)"
    plan = snap.get("plan", "Subscription")
    return (
        f"Codex {plan}  {('live' if snap.get('live') else 'cached')} ({age(snap.get('fetchedAt'))}; refreshed {stamp(snap.get('fetchedAt'))})\n"
        f"  5h: {100 - snap.get('primaryLeft', 100)}% used / {snap.get('primaryLeft', 100)}% left — resets {stamp(snap.get('primaryResetsAt'))}\n"
        f"  7d: {100 - snap.get('weeklyLeft', 100)}% used / {snap.get('weeklyLeft', 100)}% left — resets {stamp(snap.get('weeklyResetsAt'))}"
    )


def minimax_block() -> str:
    snap = load("minimax")
    if not snap:
        return "MiniMax coding plan  unavailable (cache empty)"
    return (
        f"MiniMax coding plan  {('live' if snap.get('live') else 'cached')} ({age(snap.get('fetchedAt'))}; refreshed {stamp(snap.get('fetchedAt'))})\n"
        f"  current: {snap.get('currentLeft', 100)}% left — resets {stamp(snap.get('currentResetsAt'))}\n"
        f"  weekly: {snap.get('weeklyLeft', 100)}% left — resets {stamp(snap.get('weeklyResetsAt'))}"
    )


print(f"Quota status — {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %Z')}")
print("=" * 64)
for block in (claude_block(), cursor_block(), codex_block(), minimax_block()):
    print(block)
PY

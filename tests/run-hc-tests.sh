#!/usr/bin/env bash
# Migration checks only: no installs, symlinks, or live terminal control.
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
for script in install.sh files/home/.pi/agent/skills/lead/scripts/*.sh files/home/.local/bin/pi-chief; do
  bash -n "$script"
done
sh -n files/home/.claude/hooks/herdr-agent-state.sh
timeout 60s python3 -m unittest discover -s files/home/.pi/agent/skills/restart-pi-agents/scripts -p test_restart.py
timeout 90s python3 -m unittest discover -s tests -p 'test_hc_*.py'
timeout 30s bash tests/lead-close-fallback.sh
timeout 60s node --test tests/pi-herdr-subagent-state.test.mjs tests/pi-worktree-lead.test.mjs
timeout 30s node --disable-warning=ExperimentalWarning --test files/home/.pi/agent/chief-of-staff/test/disabled.test.ts

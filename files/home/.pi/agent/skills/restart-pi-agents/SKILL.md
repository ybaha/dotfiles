---
name: restart-pi-agents
description: Restart local hc Pi terminals, resuming each saved session and restarting the caller last. Use after a Pi update or via /restart-pi-agents.
---

# Restart Pi agents on hc

This restarts Pi, not hc, and does not install updates. Terminal addresses change; names, cwd, `herdr.space`/`herdr.tab`, `ovis.*` and `dotfiles.worker` ownership labels survive. Do not restart remote machines implicitly. Never use `--continue`, fresh sessions, or dismiss blocked dialogs.

1. Read `hc --skill` and check `hc run --help`. Require `hc`, `pi` on the caller's PATH and `HC_TERMINAL_ID` (not an old pane ID).
2. Resolve `scripts/restart.py` relative to this skill. Run `python3 <script>` for inventory only. It filters local live Pi terminals from `hc ls`, gets launch details with `hc get`, and never reads session contents.
3. Review the saved paths. `session_source=argv` resolves an explicit `--session` path/id; `newest-for-cwd` selects the newest JSONL under `~/.pi/agent/sessions/--<cwd without leading/trailing slashes, with / replaced by ->--/`. **Confirm this is the intended session before quitting.** Multiple live Pi terminals sharing a cwd without explicit session arguments are refused; resolve those manually rather than guess. Custom `--session-dir` launches need an explicit session path.
4. Tell the user the count and explain interruption of active turns. Ask if interruption authority is unclear. Blocked/error/unknown agents are never dismissed. Check `launch_argv_available`; when the invocation is opaque, ask permission to use current defaults, then add `--default-launch`. Known unsupported options are always refused, even with that flag; never silently discard launch restrictions.
5. Run `python3 <script> --apply` for all agents **except the caller**, adding `--interrupt` only when authorized. It uses `hc interrupt` if needed, `hc send <t> "/quit"`, verifies the old terminal finished, and runs a replacement with `hc run --bg --no-parent --name … --cwd … --label …`. Unnamed terminals remain unnamed. The shell launch uses the caller-resolved Pi executable and prepends its bin directory to PATH (required for nvm on macOS).
6. Inspect failures with `hc get <t>` / `hc read --lines 80 <t>`; do not blindly retry the whole fleet. A startup failure may already have launched a replacement. Never bypass a trust prompt. Finished originals are retained as recovery evidence; do not remove someone else's terminals.
7. Only after every other restart succeeds, make the final tool action `python3 <script> --schedule-current` (same default-launch consent if applicable). A separate `hc run --bg --no-parent` helper waits up to 180 seconds for the caller's response to finish, then resumes the recorded session. It survives the caller quitting. Its manifest and result log are local temporary files, not repository state.
8. End promptly with a short report of verified replacements, failures, and the caller **scheduled** last, not already verified. If anything failed, leave the caller running until resolved.

The script verifies replacement cwd and session launch arguments, not successful model/provider readiness. No live restart is part of the dotfiles tests. Reload existing sessions to discover changed skills/prompts; do not reload while subagents are active.

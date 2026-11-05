---
name: restart-pi-agents
description: Restart all open Pi agents in the current Herdr server in place, resuming each exact saved session and restarting the calling session last. Use when asked to reload/restart Herdr Pi agents after a Pi update, or via /restart-pi-agents.
---

# Restart Pi agents

This restarts processes; it does not install or update Pi. Preserve panes, workspaces, working directories, names, and exact saved session paths. Never use `--continue`, start fresh sessions, kill Herdr, or control remote machines implicitly.

1. Read `herdr --skill` unless already loaded. Verify `HERDR_ENV=1`, then inspect `herdr status` and `herdr agent` for installed CLI compatibility.
2. Resolve `scripts/restart.py` relative to this skill directory. Run `python3 <script>` for a read-only inventory. It only targets Pi agents in the inherited local Herdr server. Non-Pi agents are untouched. Session contents and credentials are never read.
3. Tell the user how many agents will restart. If any are working, explain that restarting interrupts their active turns (resuming a session restores its conversation, not execution of an interrupted turn). If permission to interrupt is unclear, ask first. Blocked/unknown agents are never auto-dismissed.
4. Check `launch_argv_available` in the inventory. The helper preserves supported launch-time restrictions (for example `--no-mcp` and `--no-extensions`) when argv is recoverable, and refuses unsupported options. Pi often overwrites its process title, hiding original flags. For those panes, ask the user whether restarting with **current defaults** is acceptable; only after explicit confirmation add `--default-launch` to the apply and schedule commands. Never silently discard unknown restrictions.
5. Run `python3 <script> --apply` to restart the other agents, adding `--interrupt` only when authorized. The helper submits `/quit`, waits for each shell, starts `pi --session <exact path>`, and verifies session and PID. It does not change focus. It reports each outcome as JSON and exits nonzero on any failure.
6. Inspect failures individually. Do not blindly rerun `--apply`, since that would restart successful panes again. A failed startup may already have started Pi: inspect `herdr agent get`, `herdr pane process-info`, and `herdr pane read` first. If a pane is at its original shell, resume its recorded exact session with `herdr agent start ... -- --session <path>`. Never bypass a trust/approval dialog automatically.
7. Finish all other work before restarting the caller. As the final tool action, run `python3 <script> --schedule-current`. This launches a detached helper that waits up to 180 seconds for this agent to become idle, then restarts it and verifies the exact session. The returned log path records success or failure. Do not interrupt the caller directly from its own tool call.
8. Give a concise final response: count verified restarts, any failures, and that this session is scheduled to restart last. Do not claim the caller is already restarted. End the turn promptly so the detached helper can proceed.

Both `/skill:restart-pi-agents` and the companion `/restart-pi-agents` prompt template invoke this workflow. After installing/changing these files, existing Pi processes need `/reload` or a restart to discover the commands.

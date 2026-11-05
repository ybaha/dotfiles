# Herdr

Herdr owns durable workspaces/panes; Pi sessions and temporary subagents live inside them. One tab/pane per durable agent. Before controlling Herdr, use `herdr --skill` unless the Herdr skill is already available.

Do not open new Herdr tabs or panes for routine delegation; reuse existing durable agents. The Telegram tab in the Chief workspace is the only standing exception. Prefer Pi background subagents over new panes when helpers would otherwise spawn UI. Closing or reorganizing tabs requires explicit user approval.

```sh
herdr status
herdr workspace list
herdr pane list
herdr agent list
herdr integration status
herdr plugin list
```

Use `/restart-pi-agents` (or `/skill:restart-pi-agents`) to restart open Pi agents in place after updating Pi. It resumes each exact saved session, preserves panes and names, and restarts the calling session last. Working turns are interrupted; approval dialogs are not dismissed. If original CLI flags cannot be recovered, it asks before using current startup defaults. This does not install updates. Existing sessions need `/reload` once to discover a newly installed command.

Use `/skill:worktree` in Pi for an isolated branch/workspace when installed and its prerequisites are met. Herdr workflow plugins are independent of Pi skills/extensions: list or inspect actions with `herdr plugin action`; install/enable only after review. Reinstall the Pi integration on each machine when `herdr integration status` says outdated. See https://herdr.dev/docs/ for the CLI reference.

## Pi agent state with subagents

`~/.pi/agent/extensions/herdr-subagent-state/` wraps the Herdr-managed `herdr-agent-state.ts` reporter so Herdr shows **working** while the root Pi turn is active **or** any top-level pi-subagent is running or queued. **Blocked** still wins over working. Waiting on a schedule alone does not count as work.

Requires the installed Herdr Pi integration (tested with v9) and `@tintinweb/pi-subagents@0.21.0`. The wrapper uses that package’s documented in-process manager and lifecycle events, without polling or modifying the managed reporter. On hosts without the Herdr integration, it does nothing. Recheck the wrapper after integration/package upgrades.

User settings exclude direct auto-load of `herdr-agent-state.ts` (`-extensions/herdr-agent-state.ts`); only the wrapper loads the managed factory. Reload Pi (`/reload`) **after background subagents finish** — reload stops children. Rollback: remove the wrapper directory, delete the `extensions` exclusion entry, and `/reload` so Herdr’s managed reporter auto-loads again.

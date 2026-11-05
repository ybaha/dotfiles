# Routing

Before substantial delegation: `bash ~/.pi/agent/extensions/quota-status.sh`; confirm the chosen provider is actually available. Configured defaults may differ by host.

| Role | Model / rule |
|---|---|
| Planning/review | Shared main-session default is Sol/high; reviewer and oracle pin Sol/high. Select Astra deliberately for cheaper planning, or Opus via `claude-bridge` for a different-model opinion. |
| Implementation | After plan approval, Cursor Composer 2.5 via `cursor-ide` and the local IDE proxy; never Cursor `agent` CLI or `composer-2.5-fast`. |
| Bounded native work | Luna; MiniMax M3.1 Flash only for mechanical work followed by stronger review. |
| Delegation | Background by default. Explicitly use `run_in_background: true` for independent work; continue or yield for notifications, not a blocking join. pi-subagents are temporary Pi children, not Herdr panes. One writer per worktree; compact fresh handoffs and fresh review. |

Never use the direct Anthropic API for Claude. If a service/model is unavailable on this host, ask rather than silently changing billing or execution mode.

See [SUBAGENTS.md](SUBAGENTS.md) for the five configured roles, frontmatter precedence, foreground/background limits, and handoff contracts. A caller's `model` parameter cannot override an agent's pinned model; a different-model opinion needs a reviewed alternative agent definition.

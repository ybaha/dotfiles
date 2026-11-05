# Pi subagents

Shared source: `files/home/.pi/agent/settings.json`, `subagents.json`, and `agents/*.md`. `install.sh` links these into `~/.pi/agent/`. Do not restore the legacy `extensions/subagent/config.json`.

Audited 2026-10-13 against installed Pi 1.1.0 and `@tintinweb/pi-subagents@0.21.0`. Installed and configured versions match; the npm registry's latest version was also 0.21.0. This is a dated check, not an automatic update policy.

## Roles

| Type | Pinned model / thinking | Scope |
|---|---|---|
| `scout` | `openai-codex/gpt-6-luna` / medium | Fast codebase reconnaissance; compressed paths, types, data flow, and a starting point. No edits; inspection shell allowed. |
| `delegate` | `openai-codex/gpt-6-luna` / medium | Bounded general tasks; can edit, but is not a substitute for approved Composer implementation. |
| `worker` | `cursor-ide/composer-2.5` / high | Single-writer implementation of a concrete approved scope. Stop on new unapproved architecture/product decisions. |
| `reviewer` | `openai-codex/gpt-6.1-sol` / high | Fresh evidence-backed review. No shell or writes; supervisor runs requested commands. |
| `oracle` | `openai-codex/gpt-6.1-sol` / high | Inherited-context decision-consistency advisor. Inspection shell allowed; no writes. |

Every definition disables skills and extensions. Supply the relevant workflow requirements in the handoff; do not assume a child will discover or execute the parent's skill. Scout replaces the default system prompt; the others append. Oracle explicitly inherits context; the other definitions do not require inheritance.

"Read-only" for scout/oracle is an instruction, not a shell sandbox. Their `bash` tool can mutate state if misused. Keep commands inspection-only and keep auth/session material out of every brief.

## Current guardrails and caveats

- `disableDefaultAgents: true`, `fallbackSubagent: "none"`: use the five defined roles; unknown types do not silently become another agent.
- `maxSubagentDepth: 1`: no grandchildren. The main session owns all decomposition and integration.
- `workflowsEnabled: false`: deterministic `SubagentWorkflow` orchestration is not exposed. No need to enable it for ordinary Agent calls.
- `backgroundByDefault: true`: an Agent call with no explicit background flag returns an ID immediately; the child continues and notifies on completion. Explicitly set `run_in_background: true` for independent work. Continue useful work or give a short status and yield; do not block with `get_subagent_result(wait: true)` just to wait. Use `false` only for a genuine immediate dependency when no useful parallel work can proceed. A caller or agent frontmatter can still explicitly request blocking.
- `maxConcurrent: 2` bounds only the background queue. Foreground has a separate `maxConcurrentForeground` setting, omitted here and defaulting to `0` (unlimited). Two background plus two foreground agents can run at once; this is not a global cap. Scheduled fires bypass the background queue; workflows have their own pool. Review those separately before unattended fan-out.
- `scopeModels: true` checks caller-selected models against Pi's `enabledModels`. It is not a hard billing boundary: out-of-scope frontmatter pins warn and still run.
- Agent frontmatter takes precedence over caller `model`, `thinking`, and other pinned fields. `Agent({subagent_type: "reviewer", model: "claude-bridge/..."})` still uses the reviewer's Sol pin. Do not advertise same-model reviewers as model diversity.
- The package's model resolver can fall back across providers or inherit the parent when a pin is unavailable. Inspect `/agents` resolved models and verify provider availability; policy forbids silently accepting a billing/execution fallback.

These behaviors are from the installed package's `README.md` (Persistent settings, Model scope, Concurrency, Agent configuration), `src/invocation-config.ts`, and `src/agent-manager.ts`. Recheck on upgrade.

## Keep the main session responsive

Pi processes user steering after the current response and its tool-call batch. A blocking child call keeps that batch open even when the main model is doing no computation. This is not a Herdr workspace limit. `Enter` steers after the batch; `Alt+Enter` deliberately queues a follow-up until the current task ends.

For a currently running foreground Agent call, press **Ctrl+B** in Pi's prompt editor to hand running foreground calls to the background without restarting their work. Alternatively, open one child's viewer and press **b**. Other blocking tools in that batch can still delay the main session. Queued foreground calls and foreground resumes are not eligible for this handoff.

The shared JSON file is loaded when the extension activates; editing it does not change in-memory settings in every already-open pane. After children finish, use `/reload` in each existing Pi session, or start a new process. Do not reload an active child fleet merely to change the default: extension shutdown stops children. `/agents → Settings → Background by default → On` applies live for future calls in that session, but saves a project override, not the shared default.

Project `.pi/subagents.json` overrides global fields. Agent frontmatter overrides caller background flags, which override this default. Shared defaults apply to all projects that do not override them; other machines need the dotfiles change committed/pulled and their sessions reloaded.

Rollback: set `backgroundByDefault` back to `false` and reload only when children are finished. Keep the explicit-background policy unless intentionally changing that behavior too.

## Handoff contract

Before substantial delegation, run `bash ~/.pi/agent/extensions/quota-status.sh` and confirm the selected provider works on this host. A cached quota or configured model entry is not an availability test.

A useful brief states:

1. Goal and the decision already made, with enough context to explain why.
2. Exact source paths, named symbols, base branch/SHA, and relevant dirty-state constraints.
3. Writable paths and forbidden changes, including product/architecture/scope boundaries.
4. Acceptance criteria and exact checks; distinguish required runtime proof from static review.
5. Time/turn budget, blockers to report, and expected concise result format.

Keep one writer per worktree. Temporary children do not get durable Herdr panes. Use `/skill:worktree` when work needs an independent durable branch/workspace; Agent's temporary worktree isolation is a different lifecycle and starts from committed state, not the parent's uncommitted edits.

Use fresh briefs for new independent work. Resume when preserving costly child-local state is necessary; consolidate later directives into any replacement brief. Verify the actual diff and checks before claiming a child succeeded. A reviewer cannot run the proof itself under the current tool scope, so the supervisor owns execution.

## Sync and maintenance

The inspected Mac already symlinks the managed paths into dotfiles; copying those paths back would just copy them onto themselves. New agent definitions and `subagents.json` must be included in a commit before another machine can receive them. Keep auth, sessions, generated output, schedules, caches, and host-specific integration state local.

Pulling dotfiles does not install or upgrade a pinned package. Ask before package/integration changes; reconcile deliberately on each host. Restart Pi after package/schema changes and use `/agents` to verify definitions and resolved models. See [README.md](README.md) for the machine setup and [PSTACK.md](PSTACK.md) for workflow ideas rather than another agent manager.

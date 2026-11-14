# hc terminals, Pi sessions, Herdr app

## What runs where

- **hc / herdr-core** owns persistent programs/terminals, local or on configured machines. Read `hc --skill`, then `hc <command> --help` for installed flags. `$HC_TERMINAL_ID` is the caller's terminal address, not a pane ID. `hc ls` lists terminals; `hc get <t>` gives detailed argv/cwd/labels and observed status. The scripts in dotfiles act locally only.
- **herdr-app** arranges windows. Consult `herdr-app --skill` before UI control. Its `~/.config/herdr-app` state is app-managed; dotfiles never links or edits it. hc core configuration is machine-local too.
- **Ovis / herdr-app** group terminals using labels; they do not own Pi conversation files.
- **Pi** owns sessions under `~/.pi/agent/sessions/`. Resume with `pi --session <path-or-id>`. pi-subagents are temporary children inside the agent session, not durable workspace terminals. Keep one writer per worktree.
- The old **`herdr` TUI CLI is not required**. Old pane/workspace addresses (`w8`, `wE:p3`), `HERDR_ENV`, `HERDR_PANE_ID`, and socket variables are not hc identifiers. Do not translate IDs by string substitution.

## Labels and lifetime

A hidden worker has no `herdr.space` label. A visible workspace uses:

```sh
hc run --bg --no-parent --name api-fix --cwd /absolute/worktree \
  --label herdr.space=api-fix --label herdr.tab=api-fix:t1 \
  --label ovis.workspace=api-fix --label ovis.tab=worker --label ovis.pane=api-fix \
  '<caller-resolved Pi shell command>'
```

`herdr.space` and `herdr.tab` are grouping IDs; `ovis.workspace`, `ovis.tab`, `ovis.pane` are display names. Retaining labels retains grouping, not the old terminal address. Names are 1–32 characters from `a-z`, `0-9`, `-`, `_`. Always use `--no-parent` for durable terminals and restart helpers: they must survive their caller exiting. Without grouping labels, a helper stays hidden. New visible workspaces require explicit user authority; routine helpers should not reorganize UI.

On macOS the core may not see nvm. Scripts resolve `command -v pi` in the caller and pass one quoted shell command, e.g. `PATH='<node-bin>':$PATH exec '<absolute-pi>' --session '<exact-path>'`. A single quoted argument to `hc run` is a shell command. Never assume the core's PATH matches the caller's.

## Implemented command mapping

| Old TUI operation | Replacement used here |
|---|---|
| `herdr agent list` | `hc ls` JSON `.terminals[]`, filter live `agent == "pi"` for restarts |
| `herdr agent get`, `pane get`, `pane process-info` | `hc get <t>`; `.argv`, `.cwd`, `.labels`, `.state`, `.status` |
| `herdr agent read`, `pane read` | `hc read --lines N <t>` (text) |
| `herdr agent prompt <pane/name> <text>` | `hc send <address> <text>` (no forced dialogs or blind retries) |
| `herdr agent send-keys … esc` | `hc interrupt <t>` only with explicit interruption authority |
| `herdr agent wait` | `hc wait <t>`; inspect timeout/blocked/error, not an assumption of success |
| `herdr agent start … --pane …` | `hc run --bg --no-parent --name … --cwd … --label … '<Pi shell command>'`; new terminal address |
| `herdr worktree create` | `git worktree add -b worktree/<slug> ~/.herdr/worktrees/<repo>/<slug> <base>`, then labeled `hc run` |
| `herdr worktree remove` / close workspace | Approved script-owned terminal: `hc kill <t>`, `hc rm <t>`; retain worktree and branch |
| `herdr agent attach` | `hc attach <t>` for a human |
| `herdr workspace list` / tab grouping | Inspect `hc get` labels; window arrangement is a separate herdr-app concern |
| `herdr machine …` / `--machine` | `hc machine ls`, `--on <machine>` where supported; use `machine/t7` addresses |
| `herdr pane report-agent` / socket reporters | None: hc observes program OSC 7501 reports directly |
| `herdr integration install pi` / plugin setup | Not required for these hc workflows; no automatic installation |

Piped hc output is JSON except `read` (and other text commands documented in its manual). `hc ls` exposes flat `agent` and `status` strings, but `hc get` uses `.status.app` / `.status.state`; process `.state` is `live` or `finished`, not `working`. Do not infer agent status from screen text. Blocked dialogs must not be answered or interrupted automatically.

## Workflows and retained state

- `/skill:worktree` and `/skill:lead`: git branch + labeled durable Pi terminal, one-shot readiness check and one prompt submission. `status.sh` reads hc on demand; `prompt.sh` uses recorded addresses. State remains under `~/.pi/agent/state/worktree-watchers/` for compatibility, with `terminal` and `lead.terminal` fields, not pane IDs. Legacy state needs manual reconciliation. If an hc restart replaced a worker's address, scripts resolve its unique live name and still verify cwd/`dotfiles.worker` before input/close; that ownership label is preserved by restarts too. Read-only lead listing falls back to the lead cwd across caller replacement. `close.sh` always checks cwd and `dotfiles.worker` ownership. It does not delete worktrees/branches, even with `--force`. Existing `~/.herdr/worktrees` directories are real user data; never move or delete them during migration.
- `/restart-pi-agents`: inventory, restart other replaceable local Pi terminals, then explicitly schedule caller last. Require an observed Pi agent and its own literal Pi launch or a simple `sh -c … exec pi` wrapper before sending any input. Shell-hosted/unknown launchers and unsupported options are skipped with nonzero apply status; no override bypasses launcher safety. After `/quit` and verified exit, read `hc read --lines 40 <t>` and take the last `To resume this session: pi --session <id-or-path>` match. Relaunch with exactly that token; resolve an ID under the encoded cwd's session directory only to verify existence. Launch argv and mtimes are never session authority after `/new`, `/fork` or `/resume`. Missing/unresolvable exit messages leave Pi stopped with a diagnostic naming the terminal, cwd and candidate files for manual recovery; no guessing or relaunch. Session-file contents are not read. Preserve names/cwd/grouping labels. Launch-argument verification is not provider-readiness proof. Do not blindly retry failures.
- Legacy `herdr-agent-state.ts` remains ignored and excluded from Pi discovery, even if a host still has its generated file. `herdr-subagent-state`, `worktree-lead` and `worktree-watcher-status` are excluded and guarded on hc; the watcher status reporter also requires the old Herdr environment and executable; the Claude hook is an unregistered no-op compatibility stub. No watcher process, aggregate-child reporter, watcher footer or `/workers` notification is ported. Use hc status/wait and lead scripts instead.
- **Chief is disabled pending an hc port.** Its startup wrapper imports no SQLite/Telegram implementation on hc or without the legacy environment/executable. `pi-chief` also does nothing there. No Chief session, worker or UI exception is part of this migration. See [CHIEF.md](CHIEF.md).

Install only after inspecting `./install.sh --dry-run`; the migration does not link legacy Herdr config or app-managed hc/UI state. Reload changed instructions only after subagents finish. Historical plans/work orders and `agent-handoff-bench` describe the old system, not live commands. `pi-agent-watch` exists only untracked in the owner's main checkout and still requires a separate hc audit/port.

## Validation boundary

Run `timeout 180s bash tests/run-hc-tests.sh` for migration-only checks (no links or live terminal actions), and `timeout 30s ./install.sh --dry-run` to inspect installation. The older `tests/run-tests.sh` performs actual installs/symlinks and uses stale `--omarchy-baseline` arguments; it was not run under this migration's no-install mandate. The full retained Chief suite (`timeout 90s bash files/home/.pi/agent/chief-of-staff/test/run.sh`) has nine voice/MLX readiness failures on this Linux host; the same nine fail in the unchanged baseline. Those historical voice internals were not repaired by this hc port.

The TypeScript extension tests use the available npm Pi SDK (1.5.0 on this host), not an end-to-end startup of the bundled Pi 1.5.2 executable. Mocked hc tests exercise argv/session resolution, status safety, label/PATH preservation, spawn/prompt/status/close and caller-helper lifetime without controlling live terminals. Live restarts, real worker starts, macOS/nvm execution and herdr-app grouping were not exercised by those tests. Review those with the owner before rollout; do not start or stop a user's terminal as a test.

# WO: `/skill:lead`, a lead agent that runs worktree workers like linked subagents

**Branch:** `worktree/lead-skill` in the dotfiles repo, at `/home/baha/.herdr/worktrees/dotfiles/lead-skill`.

**Live setup:** `~/.pi/agent/skills` and `~/.pi/agent/extensions` are symlinks into the *main* dotfiles checkout (`~/code/dotfiles/files/home/.pi/agent/...`). Your worktree changes are not live until the manager merges them. Don't edit the main checkout, which has someone else's uncommitted changes.

## Why

The founder just ran a successful session on the postmixr repo. One Pi "lead" session:

- wrote work orders
- created a Herdr worktree per deliverable and started a Pi worker in each
- each worker delegated edits to Composer subagents
- the lead reviewed diffs and screenshots, sent corrections back, merged, verified and deployed
- the lead removed the worktrees

They want this as a reusable, one-command way of working. In their words: the worktrees behaved "like subagents here, not actual but kinda links". It needs to be set up for them when they invoke it.

**What went wrong, and must be fixed by design:**

1. **The lead was never told a worker had finished.**
   - The `worktree` skill's watcher only writes `<worktree>/.herdr-watch.log`. The footer extension `worktree-watcher-status.ts` only shows status inside the *worker's own* session (`isRelated` matches `sessionCwd`).
   - The lead missed a finished worker until the user pointed it out. The workaround, "waiter" subagents blocking on a bash loop, had several problems:
     - The `delegate` type always ran on Codex, which was out of quota. Agent frontmatter pins override the caller's `model` (see `docs/agent-stack/SUBAGENTS.md`).
     - A waiter missed a finish when its bash call timed out and restarted, because it only watched lines written after the restart.
     - It lingered after it was no longer needed.
     - It burned about 260k tokens doing nothing.
2. **The first prompt to a new worker was dropped every time.** `herdr agent start … --timeout 60000` returns before Pi has finished loading extensions, so the first `herdr agent prompt` is lost. The lead had to check the log for `status=working` and resend.
3. **`pkill -f <pattern>` / `kill $(pgrep -f …)` killed the lead's own shell**, because its own command line contained the pattern. Twice.
4. **A brief `done` → `working` blip happens** when a worker's turn ends and a background subagent completion starts a new one. In the log, `16:32:56 done` was followed by `16:32:57 working`. `herdr-subagent-state` keeps the status `working` while subagents run, so blips are rare but real.
5. **Cleanup was manual:** stop each watcher by PID, delete the state JSON, `herdr worktree remove --workspace <id> --force`, `git worktree prune`, and delete merged branches.

## Deliverables

### A. Notifier extension: `files/home/.pi/agent/extensions/worktree-lead.ts` (new file, under about 250 lines)

**State file:** extend `~/.pi/agent/state/worktree-watchers/<slug>.json` with optional fields:

```json
"lead": { "paneId": "wJ:p5", "cwd": "/home/baha/code/postmixr" }, "base": "master", "repoRoot": "…", "workspaceId": "wS", "notified": "<last log line notified>"
```

Old files without `lead` must keep working: ignore them in the lead, and keep showing them in the worker as today.

**In a lead session** (`process.env.HERDR_PANE_ID === state.lead.paneId`; fall back to `state.lead.cwd === ctx.cwd` when not in Herdr):

- **Footer:** one entry per worker, such as `ui-harmony · Working · 12m` or `follower-fix · Done · 16:13`, using `ctx.ui.setStatus`. Poll the logs every 2 s, as the existing extension does. Rescan the state dir every 15 s.
- **Notify** when a worker's latest status line is `done`, `idle` or `blocked`, or `pane exited`:
  - The state must have **held for 30 s**, which absorbs blips.
  - It must differ from `state.notified`.
  - Then call:

    ```ts
    pi.sendMessage(
      { customType: "worktree-lead", display: true, content },
      { triggerTurn: true, deliverAs: "followUp" },
    )
    ```

  - Write the line back to `state.notified` (atomic write: temp file + rename) so reloads, restarts and other lead sessions don't notify twice.
  - **Content** for done/idle: `Worktree worker <slug> finished (<status> at <time>). Read its report: herdr agent read <slug> · Review: git -C <worktreePath> log --oneline <base>..HEAD; git -C <worktreePath> diff <base>...HEAD`.
  - For blocked: "needs input".
  - For pane exited: "pane exited unexpectedly".
- **A slash command `/workers`:**
  - Prints the table of this lead's workers: slug, state, age, commits ahead of `base`, and dirty file count, via `git -C`.
  - Optional `/workers close <slug>` that shells out to `close.sh` (deliverable B).
- **Keep the logic testable:**
  - Put the decision ("given log lines, `notified` and now → notify or not, and what text") in pure exported functions.
  - Keep side effects (fs, timers, `pi`) thin.

**`worktree-watcher-status.ts`:** keep its worker-session behaviour unchanged. The only allowed change is to stop it also showing entries in the lead pane, if it would (it shouldn't, given `isRelated`).

### B. Scripts: `files/home/.pi/agent/skills/lead/scripts/` (bash, `set -euo pipefail`, shellcheck-clean)

**Shared helpers:**

- Move the watcher Python from `skills/worktree/SKILL.md` into `skills/worktree/scripts/herdr-watch.py`, so both skills run the same file. Update the worktree skill to call it.
- The `pane.exited` and `blocked` handling stays.

**`spawn.sh --slug <slug> --brief <file> [--repo <root, default git toplevel of cwd>] [--base <branch, default current>] [--model <id, default claude-bridge/claude-sonnet-5-5:medium>] [--setup "<cmd>"]`**

1. Validate the slug: kebab-case, at most 16 characters, and no existing branch `worktree/<slug>` or agent of that name.
2. Create the worktree with `herdr worktree create --cwd <repo> --branch worktree/<slug> --path ~/.herdr/worktrees/<repo>/<slug> --label <slug>`. Parse the pane and workspace IDs from the JSON.
3. **Setup:**
   - If `<repo>/.herdr/worktree-setup.sh` exists, run it in the new worktree. That is a per-repo hook, for example postmixr's "copy `apps/server/.env.local`, `pnpm install --frozen-lockfile`".
   - If `--setup` is given, run it too. Log the output to `<worktree>/.herdr-setup.log`.
   - **Never print env file contents.**
4. Start the agent with `herdr agent start <slug> --kind pi --pane <pane> --timeout 60000 -- --model <model>`.
5. Start the watcher: `nohup python3 -u herdr-watch.py … & disown`. Save the PID to `<worktree>/.herdr-watcher.pid`.
6. Write the state JSON with `lead.paneId=$HERDR_PANE_ID`, `lead.cwd=$PWD`, `base`, `repoRoot`, `workspaceId`, `worktreePath`, `logFile` and `spawnedAt`.
7. **Send the brief with the same confirm logic as `prompt.sh`.**
8. Print a short summary: slug, branch, path, pane, and model.

**`prompt.sh <slug> (--file <f> | --text "<msg>")`**

1. Record the log length.
2. Run `herdr agent prompt <slug> "$(<file)"`.
3. Wait up to 45 s for a `status=working` line *after* that point.
4. If none, wait until `herdr agent read <slug>` shows the Pi input area. If that's not detectable, just wait 10 s. Then re-send **once**, and wait again.
5. If it still hasn't started, exit non-zero with a clear WARN.

This fixes the dropped first prompt, and the lead uses it for follow-up corrections too.

**`status.sh [--all]`:** this lead's workers (or all with `--all`): slug, last status and time, commits ahead of base, dirty files (ignoring `.herdr-*` and `.changelog/pending.md`-style hook noise is fine via a repo-agnostic `.herdr-*` filter only), and whether the branch is merged into base.

**`close.sh <slug> [--force]`**

1. **Refuse** if `worktree/<slug>` is not an ancestor of `base`, or the worktree has uncommitted non-`.herdr-*` changes, unless `--force`.
2. **Stop the watcher by PID** from the PID file, **only after checking `/proc/<pid>/cmdline` contains `herdr-watch.py`**.
   - **Never `pkill -f` or `pgrep -f | kill`**, because that kills the caller's own shell.
3. Delete the state JSON.
4. Run `herdr worktree remove --workspace <id> --force` (ID from state; fall back to `herdr workspace list` matching the checkout path).
5. Run `git worktree prune`.
6. Run `git branch -d worktree/<slug>`; use `-D` only with `--force`.

### C. The skill: `files/home/.pi/agent/skills/lead/SKILL.md`

- **Frontmatter:** `name: lead`, plus a description that triggers on: "lead", "manage workers", "orchestrate", "work in worktrees", "you only do management", "delegate to multiple agents", and `/skill:lead`.
- **Body: the playbook,** concise and imperative:
  1. **Role:** the lead manages and does not write product code. One writer per worktree. A worker may itself delegate edits to `worker` (Composer) subagents.
  2. **Plan:**
     - Write one work order per bounded deliverable, from `templates/work-order.md`: background and evidence, locked decisions, exact files and lines, out of scope, how to work, verify, constraints, local running/ports, done-when, and report format.
     - Commit it inside the worktree's `docs/…/work-orders/`.
     - Run workers in parallel only if their file sets don't overlap. Give each worker distinct ports.
  3. **Spawn:** `scripts/spawn.sh` with a brief built from `templates/worker-brief.md`: context from the lead, a pointer to the work order, "you orchestrate, Composer edits, you review, commit, don't push".
  4. **Wait:**
     - Do not poll, sleep or start waiter subagents. The `worktree-lead` extension posts a message when a worker finishes or needs input.
     - Meanwhile, do other work or yield with a short status.
     - `/workers` or `scripts/status.sh` gives on-demand status.
  5. **Review**, following `templates/review-checklist.md`:
     - read the report (`herdr agent read`)
     - `git log` / `git diff` against the base
     - check the claims against the diff
     - look at the screenshots yourself
     - rerun the checks yourself
     - send corrections with `scripts/prompt.sh`, as one bounded follow-up with exact files, the reason, the expected commit message and the checks to rerun
  6. **Integrate:**
     - Merge with `--no-ff` into base.
     - Rerun the full checks *on the combined code*, including the production build.
     - **Ask the user before push or deploy**, unless they already approved it in this session.
     - Check compatibility when web and API deploy separately.
  7. **Close:** `scripts/close.sh <slug>` for every merged worker, and confirm with `/workers`.
  8. **Gotchas**, each one line:
     - the dropped first prompt (handled by the scripts)
     - never kill by pattern
     - `delegate` and `scout` ignore the `model` override, and frontmatter pins win, so check `/agents`
     - herdr `done` blips
     - shared services and ports belong to other projects; never stop them
     - keep secrets out of briefs
- **Templates:** `templates/work-order.md`, `templates/worker-brief.md` and `templates/review-checklist.md`. Base them on the postmixr work orders in `~/code/postmixr/docs/fix-plan/work-orders/` (WO-04 to WO-07 are good examples). Read them; don't copy postmixr specifics.

### D. Small updates

- **`files/home/.pi/agent/skills/worktree/SKILL.md`:**
  - Use `scripts/herdr-watch.py`.
  - Record `lead` in the state JSON when `HERDR_PANE_ID` is set.
  - Use the prompt-confirm logic (call `../lead/scripts/prompt.sh`, or share a helper).
  - Add "never pkill by pattern" to Don't.
  - Mention `/skill:lead` for multi-worker orchestration.
- **`files/home/.pi/agent/AGENTS.md`:** one line: "For one lead delegating to several worktree workers, use `/skill:lead`."
- **`docs/agent-stack/HERDR.md` or `SUBAGENTS.md`:** a short "Lead + worktree workers" section linking the skill and the extension.

## Tests (required)

- **`tests/pi-worktree-lead.test.mjs`**, following the style of `tests/pi-herdr-subagent-state.test.mjs`, and wired into `tests/run-tests.sh`. Unit-test the pure functions:
  - a worker going `working` → `done`, held for 30 s → notify once
  - the `done` → `working` blip within 30 s → no notify
  - `notified` equal to the last line → no repeat
  - `blocked` → "needs input" text
  - `pane exited` → "exited" text
  - a state without `lead` → ignored by the lead
  - lead matching by pane ID, and the cwd fallback
- **`shellcheck` and `bash -n`** on all new scripts.
- **End-to-end, in a scratch repo** (`/tmp/lead-e2e-<rand>`, created with `git init` and one commit):
  - Run `spawn.sh` with a trivial brief: "create hello.txt containing hi, commit it, reply done". Use model `cursor-ide/composer-2.5` to keep it cheap.
  - Confirm that the first prompt landed (a `working` line), that the commit appears, and that `status.sh` shows it.
  - Merge it into the scratch repo's base, then run `close.sh`. Confirm that:
    - the workspace is gone
    - the watcher PID is dead
    - the state JSON is removed
    - the branch is deleted
  - Also confirm `close.sh` refuses an unmerged worker without `--force`.
  - The live notification can't be tested from your worktree, because the extension isn't loaded from it. **The manager will test it live after merging.** You may load it explicitly with `pi -e <path>` in a non-interactive run if that helps, but don't open extra Herdr panes beyond what `spawn.sh` itself creates for the e2e test, and close those.

## Constraints

- No package installs and no changes to `settings.json`, `install.sh` or the main dotfiles checkout.
- Don't push.
- Don't touch other Herdr workspaces or agents, other than the e2e one you spawn and close.
- **Never stop processes you didn't start.**
- Keep each file under about 250 lines.
- **You are the orchestrator:** delegate edits to `worker` (Composer 2.5) subagents with self-contained prompts. Review every diff yourself, run every check yourself, and commit in logical steps, such as:
  - `feat(pi): notify the lead session when a worktree worker finishes`
  - `feat(skills): lead skill with spawn, prompt, status and close scripts`
  - `refactor(skills): worktree skill shares the watcher and confirms the first prompt`
  - `docs: …`

**Report** in under 250 words:

- the commits
- the file list
- the test results, with counts
- the e2e results
- anything not done
- exactly what the manager should do to test the live notification after merging

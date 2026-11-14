---
name: worktree
description: Create an isolated git worktree and a labeled hc terminal with a fresh Pi worker and the spawning session's context. Use for /worktree or requested parallel branch work. Requires hc, git, jq, Python and Pi.
---

# Worktree

Use only when a new durable worker/workspace is explicitly requested. For routine delegation reuse the current durable agent or a Pi background subagent. For several workers use `/skill:lead`.

## Preconditions

Read `hc --skill`; require `hc`, `git`, `jq`, `python3`, and caller-resolved `pi`. `HC_TERMINAL_ID` identifies the spawning terminal (not a pane). Check repository instructions, dirty state and quota. For implementation verify `cursor-ide/composer-2.5` and the local proxy are available; ask rather than silently change providers.

## Prompted worker

1. Choose a short kebab-case slug (1–2 words, preferably ≤12 characters, maximum 16). Check live terminal names with `hc ls` and branches with git. Append `-2`, etc. on collision; never reuse or delete an existing worktree directory.
2. Write a self-contained brief to an explicit file. Include repo/base SHA, recent work, locked decisions, exact writable/forbidden paths, user request, validation and reporting criteria. State the worker starts cold. Keep credentials and private session contents out. Follow `AGENTS.md`; one writer per worktree; no grandchildren when subagent depth is disabled. An implementation worker follows the approved direction and stops for uncovered decisions.
3. Resolve the sibling lead skill and run:

```sh
~/.pi/agent/skills/lead/scripts/spawn.sh \
  --slug <slug> --brief <absolute-brief-file> --repo <repo-root> \
  --base <base-branch> --model 'cursor-ide/composer-2.5:high'
```

This runs `git worktree add -b worktree/<slug> ~/.herdr/worktrees/<repo>/<slug> <base>`, optionally runs the reviewed repository `.herdr/worktree-setup.sh`, and launches Pi using `hc run --bg --no-parent`. Labels `herdr.space=<slug>`, `herdr.tab=<slug>:t1`, `ovis.workspace=<slug>`, `ovis.tab=worker`, `ovis.pane=<slug>` make it visible in Ovis/herdr-app. `dotfiles.worker=<slug>` identifies script-owned workers. The caller's Pi bin is prepended to PATH so the core need not see nvm/mise.

The script records `terminal`, cwd, branch/base, repository and lead terminal in `~/.pi/agent/state/worktree-watchers/<slug>.json`. This compatibility state directory does **not** imply a watcher process. It waits once for Pi readiness, checks status, then sends the brief once. If readiness or delivery is uncertain, inspect `hc read <terminal>`; never blindly resend or force through a dialog.

4. Report slug, branch, path, terminal address, workspace label, model, prompt summary and readiness/delivery failures. A failed setup/start retains the worktree for inspection, not silent cleanup.

## Empty worktree (no prompt)

Do not launch an agent or watcher. After the same collision checks:

```sh
git -C <repo-root> worktree add -b worktree/<slug> <worktree-path> <base>
hc run --bg --no-parent --name <slug> --cwd <worktree-path> \
  --label herdr.space=<slug> --label herdr.tab=<slug>:t1 --label ovis.workspace=<slug>
```

No argv starts the machine's shell. Do not arrange windows or change focus; that belongs to `herdr-app --skill` and requires approval.

## Follow-up and finish

- Read: `hc get <t>`, `hc read --lines 80 <t>`; attach for a human: `hc attach <t>`.
- Prompt: sibling `lead/scripts/prompt.sh <slug> --file <brief>` (one send, no automatic retry).
- On-demand status: sibling `lead/scripts/status.sh`; for a genuine immediate dependency: `hc wait <t>`. Do independent work or yield instead of polling or opening waiter agents.
- hc observes Pi status directly (OSC 7501). Legacy socket reporters, watcher footer and `/workers` notifications are disabled on hc. `scripts/herdr-watch.py` keeps its compatibility filename but is only an on-demand hc read/optional wait command; it is not spawned.
- Close only explicitly approved workers with sibling `lead/scripts/close.sh <slug>`. It checks ownership/merge/dirty state, removes the terminal and registration, and **retains the worktree and branch**. Never move/delete existing `~/.herdr/worktrees` directories in this migration.

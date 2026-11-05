---
name: review-change
description: Read-only review of a specific diff or plan with explicit git scope, fresh reviewer handoff, and BLOCK/OK verdict. Use for /skill:review-change before merge or after risky fixes.
disable-model-invocation: true
---

# Review change

**Read-only.** You coordinate evidence; you do not edit files or auto-apply fixes. The pinned `reviewer` subagent has no shell — you run any requested **safe** tests locally and paste results.

Do not override the reviewer's pinned model to simulate diversity. One fresh `reviewer` per review pass. Do not read credentials or private session history. Inspect requested test commands before running them; read-only review does not authorize installs, tracked-file writes, destructive/shared-instance checks, or external actions. Ask before those operations.

## 1. Define the target

If scope is unclear, ask before reviewing.

State:

- **Intent** — one paragraph from the user message, commits, or plan.
- **Base revision** — branch name and/or SHA (not assumed `main` without checking).
- **Change set** — run `git status` and classify: committed, staged, unstaged, untracked. Include dirty edits when they belong to the task; preserve unrelated work.
- **Invariants** — contracts, safety rules, compatibility promises the change must keep.

Gather the exact files or diff the reviewer needs. Prefer a focused diff over whole-repo dumps.

## 2. Spawn reviewer

Before substantial delegation: `bash ~/.pi/agent/extensions/quota-status.sh` and confirm the reviewer provider is available.

Hand off to `reviewer` with:

- intent, base, and change description;
- paths and symbols;
- invariants and known proof gaps;
- requested static checks, no-write boundaries, dirty constraints, and time/turn budget (no shell on their side).

Children disable skills/extensions — paste the relevant review rules into the brief. No grandchildren. Explicitly set `run_in_background: true` for independent review and wait for notification, not polling; `false` only when the next action needs the result and nothing else useful can proceed.

## 3. Validate findings (lead judgment)

For each reviewer finding, verify independently:

- location (`file:line` or section)
- mechanism (how it breaks)
- impact (who/what is affected)
- evidence (source, repro, or contract)

Dedupe duplicates. Bucket each item:

- **Act** — real, reachable, introduced or worsened by this change
- **Consider** — plausible tradeoff; user decides
- **Dismiss** — wrong, pre-existing only, or contradicted by evidence. Keep an unresolved plausible risk as **Consider** or a proof gap; uncertainty alone does not clear it.

Severity: **P0** blocks merge; **P1** before release; **P2** report-only. Do not severity-vote across models (single reviewer).

## 4. Contracts and blast radius

- Trace upstream/downstream callers touched by the diff.
- Name the **critical safety fact** the change relies on. Label evidence as **executed proof** (command and result), **source-supported** (an enforced contract with cites), or **unproven**. Static evidence is not an executed runtime check.
- Distinguish issues **introduced/reachable** by this change from pre-existing noise.

## 5. Verdict

Choose one:

- **BLOCK** — unresolved P0/P1, or a required safety check still unproven on a risky path.
- **OK** — no qualifying defects or material proof gaps in scope.
- **OK with notes** — P2, Consider items, or non-blocking proof gaps only. State what remains untested.

If no qualifying defect: say **`No issues found.`** Separately list proof gaps (tests not run, behavior not exercised). No findings does not imply the required checks passed.

Do not claim tests ran if only the reviewer summary exists.

## 6. Output

```markdown
### Intent
...

### Scope
(base, dirty summary, files/diff)

### Findings
(P0/P1/P2 with evidence)

### Proof gaps
...

### Verdict
BLOCK | OK | OK with notes
```

No automatic fix PR. Parent agent or user decides next steps.

## Related skills

Read a related file in full only if the user requests that next step. Review does not authorize repairs or a design change.

- `../bug-fix/SKILL.md` — when review follows a defect fix loop.
- `../design-change/SKILL.md` — when findings require a design fork before more code.

## Sources / adaptations

Adapted from pstack's [Interrogate](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/interrogate/SKILL.md) and [Blast radius](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/blast-radius/SKILL.md). One pinned Pi reviewer plus supervisor-run proof replaces Cursor panels. No automatic repairs. See [LICENSE](LICENSE).

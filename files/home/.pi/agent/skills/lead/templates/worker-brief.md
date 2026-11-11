## Context (from lead session)

- Repo: `<repo-root>`
- Base branch: `<branch>` @ `<sha>`
- Worktree: `~/.herdr/worktrees/<repo>/<slug>` on `worktree/<slug>`
- Goal: <one sentence>
- Locked decisions: <bullets>
- Related paths: <list>

## Work order

Read and follow:

`<path-to-work-order.md>`

Treat it as the contract. If implementation needs a decision not covered there, stop and report — do not guess.

## Your role

You are the **worker** in this worktree — not the lead. You orchestrate; you delegate **edits** to `worker` (Cursor Composer 2.5) subagents with detailed, self-contained prompts. You review every diff, run checks yourself, and commit in logical steps. **Do not push.**

Follow `~/.pi/agent/AGENTS.md` and this repo’s `AGENTS.md`. No secrets in prompts or commits.

## Verify before reporting done

Run the work order’s verify section. Capture screenshots if UI changed.

## Report format (<250 words)

```
Implemented: …
Changed files: …
Validation: …
Open risks/questions: …
Recommended next step: …
```

Then reply that you are done (or blocked with a concrete question).

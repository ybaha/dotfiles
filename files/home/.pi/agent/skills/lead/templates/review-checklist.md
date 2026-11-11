# Review checklist (lead)

## 1. Read the worker report

```bash
herdr agent read <slug>
```

## 2. Git evidence vs base

From state or `status.sh`, use `base` and worktree path:

```bash
git -C <worktree> log --oneline <base>..HEAD
git -C <worktree> diff <base>...HEAD
```

## 3. Verify claims

- Every file/commit the worker cites appears in the diff.
- Behaviour matches the work order and locked decisions.
- Open screenshots yourself; do not trust captions alone.

## 4. Rerun checks yourself

Run the work order verify commands on the **worktree** checkout. Do not rely on the worker’s summary alone.

## 5. Corrections

One bounded follow-up per round via `prompt.sh`:

```bash
~/.pi/agent/skills/lead/scripts/prompt.sh <slug> --file <correction.md>
```

Include: exact files/lines, reason, expected commit message, checks to rerun.

## 6. Integrate

After acceptance:

```bash
git checkout <base>
git merge --no-ff worktree/<slug>
```

Rerun **full** checks and production build on the **combined** tree. Ask the user before push/deploy. If web and API deploy separately, confirm compatibility.

## 7. Close

```bash
~/.pi/agent/skills/lead/scripts/close.sh <slug>
```

Confirm `/workers` shows no active worker for that slug.

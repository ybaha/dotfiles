---
name: bug-fix
description: Fix a confirmed defect with evidence-first reproduction, minimal worker implementation, and verified outcomes. Use for /skill:bug-fix, "fix this bug", or when runtime behavior is wrong and you need a disciplined repair loop.
disable-model-invocation: true
---

# Bug fix

Lead the repair loop in the main session. Use existing Pi roles only: `scout` for recon, `worker` for the single-writer fix, `reviewer` via **review-change** when risk warrants a fresh read. Invoke **design-change** only when the fix would cross a material design fork the user has not approved.

Read a related skill's `SKILL.md` from the paths below before using it. Use it once for the named step, not as a recursive task router. Children have skills/extensions disabled; include the relevant rules in their brief.

Do not read credentials or private session history. Ask before installs, destructive or shared/live operations, external actions, or new product/architecture decisions. Selecting this skill does not grant those permissions.

## 1. Preflight

- Read the repository's `AGENTS.md` and any local agent instructions.
- Record git status: branch, dirty files, and constraints (preserve unrelated edits).
- State the defect in one sentence and the expected behavior in one sentence.
- Name the user-visible surface (CLI, API, UI, job, library API) and the narrow writable scope.

Before substantial delegation: `bash ~/.pi/agent/extensions/quota-status.sh` and confirm the chosen provider is available. Do not silently fall back or try to override pinned agent models. Set `run_in_background: true` for independent calls and wait for notification, not polling. Set it to `false` only when the next action needs the result and no other useful work can proceed.

## 2. Reproduce (non-negotiable)

Drive the same surface the user hit. Prefer the repo's real launch/test path over invented steps.

- Build a **safe, identical-surface** repro: same commands, inputs, flags, and environment knobs that are safe to repeat.
- Capture failing output verbatim (exit code, stderr, observable state).
- If you cannot obtain a failing repro, continue read-only investigation or report **blocked/unreproduced** with the specific gap. Stop before repair unless the user separately approves an unverified patch. Never claim the defect is fixed without failing-then-passing proof.
- Tighten conditions, add logging, or use `scout` to find a cheaper local trigger before giving up.

## 3. Inspect mechanism

- Start at the caller seam named in the repro (route, handler, export, UI action).
- Read source and follow data/control flow until you can name a **single mechanism** supported by file evidence.
- Rank a short list of candidate causes; eliminate with source + repro, not guesses.
- When program state is unclear, add temporary instrumentation, run once, read it, then remove or gate it.

## 4. Regression test (when feasible)

When a cheap automated check can lock the behavior:

- Add or extend a test that fails on the current code **before** the fix.
- Keep it in the same final change set as the fix when possible. Do not create a deliberate broken commit solely for history.
- Skip when the test would be slow, flaky, or unclear; say why.

## 5. Plan the fix

- Prefer the smallest change the evidence justifies.
- If the fix changes ownership, public API shape, or cross-module contracts, stop and run **design-change** (read-only) for an approved shape before `worker` edits.
- Write a `worker` brief with: concrete goal; exact paths/symbols; dirty constraints; writable scope; forbidden scope; accepted design; proof commands; time/turn budget.

## 6. Implement

- One writer per worktree. Delegate implementation to `worker` with the brief.
- Independent recon may use `scout` with `run_in_background: true`. Do not spawn grandchildren (`maxSubagentDepth: 1`).

## 7. Verify

- Rerun the **same** repro. Paste failing-then-passing evidence.
- Run affected regression checks (unit/integration/lint) named in the brief.
- Inspect the actual diff; confirm no scope creep.
- For nontrivial or risky changes, invoke **review-change** once with explicit scope and invariants. Act on P0/P1 per that skill; do not auto-merge review text into code.

## 8. Report outcome

Use exactly one status word: **verified**, **partial**, or **blocked**.

Include:

- What was broken and root cause (mechanism + cites).
- What changed (paths).
- Commands run and key output.
- Open risks or proof gaps.

Default: no commit, push, or PR unless the user asked.

## Related skills

- `../design-change/SKILL.md` — material design fork before implementation.
- `../review-change/SKILL.md` — fresh read-only review of the resulting diff.
- `../create-verification-skill/SKILL.md` — when the repo lacks a repeatable drive harness for the surface.

## Sources / adaptations

Adapted from [pstack's Bug fix playbook](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/poteto-mode/playbooks/bug-fix.md). Pi-specific roles, quota checks, and approval gates replace Cursor tooling and automatic shipping. See [LICENSE](LICENSE).

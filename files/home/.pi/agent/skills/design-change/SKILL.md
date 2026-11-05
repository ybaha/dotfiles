---
name: design-change
description: Produce a read-only design plan with evidence, alternatives, and a worker brief. Use for /skill:design-change or before non-trivial shape changes. Does not authorize implementation by itself.
disable-model-invocation: true
---

# Design change

**Read-only by default.** End with a recommended design and an exact `worker` brief. Implementation happens only when the user separately requests it and accepts the shape (or an already-approved plan covers the work).

Invoking this skill alone does **not** permit code edits, commits, or installs. Keep inspection commands read-only. Do not read credentials or private session history. New product/architecture choices remain approval gates; this skill proposes them, not approves them.

## 1. Ground

- Read the repository's `AGENTS.md` and local instructions.
- Record requirements and explicit **non-goals**.
- List callers, types, domain boundaries, and ownership with `file:line` evidence.
- Note git dirty state and constraints on unrelated work.

Optional: `scout` recon for unknown seams. Before substantial delegation, run `bash ~/.pi/agent/extensions/quota-status.sh` and confirm provider availability; no silent model fallback or pinned-model override. Give each child the goal, paths, constraints, acceptance checks, and time/turn budget. Children cannot load skills or spawn grandchildren. Set `run_in_background: true` for independent calls; wait for notification, not polling. Use `false` only when the next action depends on the result and nothing else useful can proceed.

## 2. Usage first

Describe how call sites will use the new shape **before** module layout.

- Show 1–2 realistic call-site snippets in prose (not committed stubs).
- State invariants the design must preserve (safety, compatibility, performance budgets).

## 3. Shape in text

Propose data types, function signatures, module boundaries, and error semantics in plain text.

- Small change: one cohesive type/surface sketch.
- Larger change: module map plus public API list.
- No speculative files in the repo; no `not implemented` bodies unless the user asked for a sketch commit.

## 4. Alternatives (when uncertain)

When a meaningful design choice remains open, compare **two structurally different** options against:

- invariant preservation
- safety and failure modes
- simplicity of the public surface
- testability and operational cost

No mandatory multi-model arena. Pick a recommendation; list open decisions the user must make. Do not guess product preferences.

## 5. Throughput checkpoint

Before suggesting parallel implementation, answer briefly:

- **Blockers** — what must be decided first?
- **Independent slices** — what can land separately?
- **Shared state** — what must not be edited by two writers?
- **Smallest safe decomposition** — first slice that proves the design.

Optional: `oracle` continuity check when inherited decisions matter (read-only; paste sanitized context, never auth/session files).

## 6. Outputs

Deliver:

1. **Recommended design** — usage, types/modules, error and ownership rules.
2. **Choices made** — what you picked and why (with cites).
3. **Open decisions** — user or parent agent must answer.
4. **Worker brief** — goal; paths/symbols; dirty constraints; writable scope; forbidden changes; acceptance checks; proof commands; time/turn budget.

Stop here unless implementation was separately approved.

## Related skills

Read a related file in full before using it. Do not restart a parent bug-fix loop or silently expand the approved task.

- `../bug-fix/SKILL.md` — when the task is a defect with a repro, not a greenfield shape change.
- `../review-change/SKILL.md` — after implementation, for adversarial read of the diff.

## Sources / adaptations

Adapted from [pstack's Architect skill](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/architect/SKILL.md). Pi roles replace Cursor panels; alternatives are risk-based and implementation requires approval. See [LICENSE](LICENSE).

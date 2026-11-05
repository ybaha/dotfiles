# What to borrow from Cursor's pstack

## Recommendation

Borrow the engineering workflow, not the orchestration stack. Our Pi roles, provider routing, quota checks, and Herdr worktrees already supply most of the execution machinery. The missing layer is repeatable task-specific design and verification contracts.

The approved first step is now four independent, explicit-command-only Pi skills: `bug-fix`, `design-change`, `review-change`, and `create-verification-skill`. No central mode, package, new agents, nested delegation, or extra autonomy was added. The verification generator still needs a chosen real project before it can produce and prove a project-specific skill.

## Source and audit boundary

- Official upstream: [Cursor plugins / pstack](https://github.com/cursor/plugins/tree/main/pstack), by Lauren Tan (poteto).
- Snapshot inspected on 2026-10-13: [`1dcc2bacde73ddd284803b7af28164d0436198fc`](https://github.com/cursor/plugins/tree/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack).
- That snapshot contains 52 skills, including 24 principles, and 23 playbooks under `poteto-mode`. It is a workflow collection, not a single skill or a new underlying agent runtime.
- Its central router chooses investigation, bug fix, feature, performance, prototype, shipping, and other playbooks. Supporting skills supply design alternatives, review, verification, and retrospective learning.
- Inspected the router and selected design, review, blast-radius, verification, bug-fix, feature, performance, pause, eval, and orchestration workflows. This was not an execution/security audit of every bundled script. Public Pi ports surfaced in GitHub search but were not audited or installed.

The following links use that snapshot so recommendations remain reproducible.

## Highest-value adaptations

| Upstream idea | Why it earns its place | Adaptation for this setup |
|---|---|---|
| [Bug fix](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/poteto-mode/playbooks/bug-fix.md) | Turns a plausible patch into evidence of a fixed defect. | Reproduce on the affected surface, test competing causes, make the narrow approved fix, rerun the identical repro. Use failing-then-passing tests where cheap. Label missing runtime proof, never call it a pass. |
| [Architect](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/architect/SKILL.md) | Forces the public usage and data model to be decided before code locks them in. | Write caller usage, types, ownership, and boundaries first. Compare two genuinely different shapes only for consequential/uncertain decisions. Main agent owns approval; worker executes the chosen contract. Avoid committed placeholder bodies. |
| [Interrogate](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/interrogate/SKILL.md) | Independent reviewers challenge assumptions; the lead filters false positives. | Start with a fresh Sol reviewer and supervisor-run proof. For high stakes, add a separately configured reviewed role on `claude-bridge`. Synthesize actionable, optional, and dismissed findings with evidence; do not auto-fix every criticism. |
| [Blast radius](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/blast-radius/SKILL.md) | Looks past callers at wire formats, lifecycle, library versions, flags, and downstream consumers. | Identify the one or two facts change safety depends on. Prove them with real code where safe; otherwise mark them unproven. This is more valuable than a long speculative risk list. |
| [Create verification skill](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/create-verification-skill/SKILL.md) | Leaves the next agent a reusable way to prove actual user behavior. | Generate `.pi/skills/verify-<project>/` with launch, doctor, drive, evidence, cleanup, and a feature map. Ground it in the repo's existing harness; execute one mapped path end to end before calling it usable. |
| [Feature checkpoint](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/poteto-mode/playbooks/feature.md) | Makes safe decomposition explicit rather than equating more agents with throughput. | Name blockers, independent slices, shared mutable state, and the smallest safe decomposition. Our parent owns fan-out because nesting is disabled. One owner for coupled code; parallelize independent research. |
| [Performance](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/poteto-mode/playbooks/perf-issue.md) and [benchmark checklist](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/benchmark-checklist/SKILL.md) | Prevents optimizing a guess or reporting a misleading speedup. | Keep a comparable baseline, workload/build details, repeated measurements, errors, and post-fix artifacts. Prefer eliminating unnecessary work before making it concurrent or cheaper. |

### Verification is the best first investment

Design and review prompts improve judgment. A working `verify-<project>` skill improves both judgment and proof across future sessions.

A generated skill should:

- Reach a usable state from isolated test data, including migrations and seeds.
- Check that it is driving the intended build and an instance it owns.
- Exercise real UI/CLI/API/library entry points, not internal setters that bypass the bug.
- Record action plus resulting state, including persistent side effects.
- Declare exclusive ownership when an app, browser, simulator, port, or data directory cannot be isolated. One-writer discipline applies beyond Git.
- Stop only processes it started. Remove scratch state, not evidence.
- Keep proof artifacts at a named location after cleanup. Sanitize evidence before sharing.
- Report prerequisites or inaccessible surfaces precisely; no installing dependencies or weakening journeys just to make the proof green.

Use a feature map of a few concrete user journeys rather than a giant generic test checklist. Verify the changed path and its meaningful boundaries; scale coverage with actual risk.

## Useful later, not defaults

- **Arena:** two independent design candidates with a declared rubric, followed by one coherent base and selective synthesis. Useful for expensive decisions, wasteful for routine changes. Same-model agents are independent attempts, not cross-model diversity.
- **Orchestrate:** pilot one unit through build, proof, and integration before scaling. Give each unit an explicit owner, paths, acceptance, check commands, budget, and terminal disposition. Stop launching work early enough to harvest and integrate it. Roles outlive individual agents; reconcile late results against the current branch/SHA.
- **Decision trail and safe pause:** keep sanitized intent, approved decisions, current SHA/dirty state, checks and evidence, blockers, next action, and live resources in a resume note. Do not mine private transcripts or automatically commit someone else's dirty files.
- **Reflect / correct:** turn repeated mistakes into tests, types, lint, or scripts before adding more instructions. Start from supplied incidents and current artifacts, not forbidden history reads.
- **Skill evaluation:** compare the current workflow with the proposed one on a few real representative tasks, using identical acceptance criteria and blinded output review where practical. Judge observable outputs and executed checks, not a model's claim that it followed the recipe.

## What not to copy verbatim

| Upstream assumption | Why it does not fit |
|---|---|
| Cursor `Task`, `poteto-agent`, `generalPurpose`, `.cursor/rules/*.mdc`, `/loop`, custom-mode persistence, cloud workers | Different APIs and lifecycle. Use existing Pi Agent roles and explicit skill loading. A Pi skill does not automatically become Cursor's persistent mode. |
| Default Grok/Opus panels and automatic model fallback | Our approved execution uses Composer, Sol/Luna, and Claude through `claude-bridge`. Quota/availability must be checked. Pinned agent frontmatter overrides caller model arguments. |
| Nested coordinator trees | `maxSubagentDepth: 1` deliberately forbids grandchildren. Temporary children are not Herdr workspaces. |
| Mandatory multi-model design for every function-boundary change and mandatory arena implementation | Excess cost and complexity for routine work; current workers also cannot spawn. Escalate only for meaningful uncertainty or risk. |
| Broad "just do it" authority over MCPs, chat, tickets, evals, adjacent fixes, and shipping | The task does not grant all external actions or scope changes. Preserve package-install, host-change, product/architecture, deployment, destructive-action, and secret-handling gates. |
| History-mining recall/pickup and transcript-based eval inspection | Dotfiles forbids reading auth/session material. Use explicit sanitized checkpoints, source, supplied requirements, and verification receipts. |
| Always open a PR, commit liberally, or pause by automatically committing dirty work | Those actions need an appropriate task mandate and careful separation of pre-existing changes. A read-only investigation remains read-only. |
| Blanket comment stripping | Existing `remove-dumb-comments` requires approval and preserves useful rationale. Do not replace it with automatic deletion. |
| Bundled control/deslop/create-skill dependencies | Some workflows require `cursor-team-kit`, Cursor built-ins, MCPs, or environment-specific harnesses that we do not have by default. Reuse available project tools; ask before installing anything. |
| Bundled orchestration/state/bootstrap scripts | Do not run unseen helpers. Bootstrap can install dependencies; state paths require separate crash-safety review. Our lifecycle is already covered by Pi/Herdr. |
| Arbitrary upstream frontmatter | Normalize to Pi's skill spec (`name`, `description`, optional `disable-model-invocation`). Cursor-specific `mode`, reminder, icon, and model-rule behavior do not transfer. |

For future stateful orchestration, receipt processing should be durable claim/ack, with idempotent reconciliation and verifier-owned final verdicts. Do not assume an inbox file or "verified" ledger is an authorization boundary. A separate background/foreground limit also means `maxConcurrent: 2` is not a global spend cap; see [SUBAGENTS.md](SUBAGENTS.md).

## Implemented commands

Each skill lives in `files/home/.pi/agent/skills/` with `disable-model-invocation: true`. They are not automatically selected or added to the model's skill list. Run `/reload` to refresh commands in an existing Pi session. This Mac already links that directory; no new installation or settings entry is needed.

| Command | Contract |
|---|---|
| [`/skill:bug-fix`](../../files/home/.pi/agent/skills/bug-fix/SKILL.md) | Failing repro, mechanism, approved worker fix, identical repro, regression checks, risk-based fresh review. No automatic commit or PR. |
| [`/skill:design-change`](../../files/home/.pi/agent/skills/design-change/SKILL.md) | Read-only plan: usage, types, ownership, meaningful alternatives, and an exact worker brief. Stops before implementation without separate approval. |
| [`/skill:review-change`](../../files/home/.pi/agent/skills/review-change/SKILL.md) | Read-only targeted review, fresh reviewer, validated findings, separate static/executed proof, and verdict. Does not apply fixes. |
| [`/skill:create-verification-skill`](../../files/home/.pi/agent/skills/create-verification-skill/SKILL.md) | Writes `.pi/skills/verify-<project>/` in a chosen target project, maps real journeys, and proves one end to end or marks the result DRAFT. |

They keep existing roles and approval rules. Children have skills/extensions disabled, so the parent includes the relevant acceptance/proof contract in each brief. Design and review do not authorize repair. Related skills are read only when the current authorized step needs them; there is no persistent central mode.

Validation covers Pi's actual skill parser, explicit-only flags, discovery through the existing symlink, local references, provenance, licenses, and whitespace. Workflow behavior still needs representative real tasks; parser validation is not proof of better engineering results.

## Next checks, not yet done

1. Run bug-fix on a real defect with a safe repro, design-change on a material design choice, and review-change on a known diff.
2. Choose an actively developed repository with an existing runnable harness. Generate and execute one project-specific verification skill there, not in archived `pi-orchestra` by default.
3. Compare actual correctness, proof quality, review findings, elapsed time, and delegation usage with the previous workflow. Add arena, performance-specific commands, persistent checkpoints, or deterministic workflows only if they earn their complexity.

Leave nesting, workflow, provider, and concurrency settings unchanged. A different-model reviewer remains a separate approval and provider check, not a caller override of the pinned Sol reviewer.

## Licensing and maintenance

Upstream is [MIT, copyright 2026 Lauren Tan](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/LICENSE). If copying/adapting substantial skill text or scripts, retain the full license and copyright notice, record the source commit, and explain local deviations. This assessment summarizes ideas; each of the four local skill adaptations includes its source link, local differences, and the full upstream MIT license. No upstream executable code or whole plugin was vendored.

Prefer a small manually maintained adaptation over an auto-updating fork. An upstream update may change model routing, external-action authority, or dependencies. Review those changes deliberately rather than inheriting them through a package update.

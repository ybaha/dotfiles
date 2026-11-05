---
name: create-verification-skill
description: Generate a project-local Pi verification skill under .pi/skills/verify-<project>/ with launch, doctor, drive, evidence, and cleanup grounded in the repo. Use for /skill:create-verification-skill or when no scripted user-journey proof exists.
disable-model-invocation: true
---

# Create verification skill

Generate a **project-local** explicit command skill the next agent can run cold. Default output lives in the **target project** (ask which repo if unspecified). Do not target archived `pi-orchestra` unless the user names it.

Writes happen only inside the chosen target project and its approved skill paths. Preserve unrelated dirty work. Skill instructions are not permission to read credentials/private history, install packages, or perform destructive/shared/live or external operations.

## 1. Choose target

- Confirm project root path and short name. The generated skill name is at most 64 characters, with lowercase letters, digits, and single hyphens; no leading/trailing hyphen.
- Read `AGENTS.md`, local instructions, and README/Makefile/package scripts for real launch and test commands. Record Git status and approved writable scope.
- Do not read `.env`, auth, or session files. Do not install dependencies automatically.

If an existing matching skill is present, preserve custom edits; update only agreed sections. Use an existing verified harness instead of duplicating it.

Use `scout` only for useful independent inspection. Use `worker` for nontrivial helpers, with goal, exact paths, dirty constraints, approved scope, acceptance/proof commands, and time/turn budget. Parent owns generation and validation; children cannot load skills or spawn grandchildren. Before substantial delegation run `bash ~/.pi/agent/extensions/quota-status.sh` and confirm provider availability. Do not override pinned models or silently fall back. Set `run_in_background: true` for independent calls and wait for notification, not polling; `false` only when the next action depends on the result and nothing else useful can proceed.

## 2. Interview the repo

From source evidence only:

| Question | Source |
|----------|--------|
| User surface | UI, CLI, API, desktop, library CLI |
| Local run | documented dev command, ports, seeds |
| Drive harness | existing Playwright/curl/PTY scripts first |
| Evidence | screenshots, transcripts, HTTP bodies, exit codes |
| Isolation | disposable ports, data dirs, profiles |

Refuse to double-drive the user's personal session or a shared live instance. Use isolated ports/processes/data dirs.

## 3. Generate artifacts (target project)

Create:

- `.pi/skills/verify-<project>/SKILL.md` — `disable-model-invocation: true` unless the user asked for model-routed verification.
- Optional safe helpers under `.pi/skills/verify-<project>/` (executable, documented invocations in the skill body).
- `features/README.md` index plus up to **3–5** journey files for real user-facing flows. If the project has fewer flows, map those; do not invent features.

Follow the structural contract in [`references/verification-template.md`](references/verification-template.md). **No placeholders** may remain in generated output. Do not paste template pseudocommands as runnable steps.

Each feature file: user-visible behavior, entry points, harness steps with preconditions/action/expected state/boundaries, and gotchas.

## 4. Skill body requirements

Generated `SKILL.md` sections:

1. **Launch** — exact start command; readiness signal; teardown; empty-data bootstrap including migrations/seeds when required.
2. **Doctor** — read-only "worth driving?" check (process, port owner, build id, usable test data). If auth is needed, use an approved isolated test identity or ask the operator to authenticate; never inspect credential/session storage.
3. **Drive** — repo-specific selectors/commands; stable handles over coordinates.
4. **Evidence** — sanitized artifacts **outside** tracked files by default; include action, outcome, revision/build, and command. Survives cleanup.
5. **Cleanup** — stop only resources this run created; runs even after a failed drive; never kill by process name.
6. **Features** — pointer to the feature map.

Generated instructions must retain these approval and secret-handling rules, not just this generator. Ask before destructive actions, non-local external-network effects, or any action outside the approved proof scope. Local loopback checks on an owned test instance are permitted. Mocks belong only at existing production boundaries; record them and any resulting limits on proof.

## 5. Prove before delivery

Execute the generated instructions once in the target project:

`launch → doctor → one real mapped journey → evidence → cleanup → confirm evidence still on disk`

Fix failures and run cleanup after each failed iteration. If a prerequisite is missing on this host, label output **DRAFT/unverified** and list gaps — do not claim delivery success or weaken assertions.

Do not run example paths from this generator doc as commands.

## 6. Hand back

Report:

- generated paths;
- journey exercised and checks passed;
- evidence location;
- DRAFT gaps or stand-in setup not verified on the user's real environment.

Mention that ongoing map maintenance is a normal follow-up; no separate router skill is required.

## Related skills

- `../bug-fix/SKILL.md` — uses verification harnesses when fixing user-visible defects. Read it only for a separately requested repair; generation does not authorize fixing the app.

## Sources / adaptations

Adapted from [pstack's Create verification skill](https://github.com/cursor/plugins/blob/1dcc2bacde73ddd284803b7af28164d0436198fc/pstack/skills/create-verification-skill/SKILL.md). Pi project paths, explicit commands, owned resources, and DRAFT rules replace Cursor-specific assumptions. See [LICENSE](LICENSE).

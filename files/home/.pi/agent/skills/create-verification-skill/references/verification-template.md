# Verification skill template (generator reference only)

Use this structure when writing **generated** `.pi/skills/verify-<project>/SKILL.md` and feature files. Replace every `<placeholder>` with repo-specific facts. Placeholders must **not** appear in delivered project output.

## Generated SKILL.md skeleton

```markdown
---
name: verify-<project>
description: <App name> <surface> verification — launch, doctor, drive user journeys, capture evidence. Use when proving <behavior> end to end.
disable-model-invocation: true
---

# Verify <project>

Read the project's instructions first. Do not read credential/session storage. Use only owned isolated resources and approved test identities. Ask before installs, destructive/shared/live actions, or non-local external effects. Never weaken an assertion to make a journey pass.

## Launch

- Command: `<exact dev or build+run command>`
- Ready when: `<observable usable state, including migrations and seeds, not only process liveness or HTTP 200>`
- Isolation: `<owned test port, temporary data directory, approved test identity if needed>`
- Teardown: `<how to stop processes started here>`

## Doctor

Read-only checks before driving:

1. `<process or port check>`
2. `<build/revision check>`
3. `<data dir empty or seeded as expected>`

Fail fast with a one-line reason if any check fails.

## Drive

- Primary harness: `<playwright | curl | pty | cli subcommand>`
- Conventions: `<stable selectors, base URL, CLI prefix>`

## Evidence

- Directory: `<path outside git, e.g. /tmp/verify-<project>-$RUN_ID>`
- Per proof: action, outcome, git revision or build id, command transcript
- Rules: real user path; side effects checked; no secrets in artifacts; record mocks and proof limits
- Capture both the action and its resulting state

## Cleanup

- Stop: `<exact process IDs or owned instance handles recorded at launch; never match by process name>`
- Remove: `<temp dirs created by this run only>`
- Run cleanup after success and every failed iteration
- Confirm sanitized evidence remains at its named path

## Features

See `features/README.md` for journeys.
```

## Generated `features/README.md`

- Title and one paragraph on what the map covers.
- **Baseline preconditions** shared by all journeys (launch URL, seed data, env vars).
- **Driving conventions** (harness entrypoint, quoting rules).
- **Proof and skip reporting** (what counts as verified vs blocked precondition).
- **Feature list** linking to each journey file.

## Per-feature journey file

H1: feature name. One paragraph: user-visible behavior.

### Sub-features

Short IDs and one line each.

### How to get to it (user POV)

Every entry point (menu, route, command flag).

### Driving it with <harness>

**Preconditions:** bullets.

**Recipe:** for each step:

- **Action:** what the user does
- **Command:** exact invocation
- **Expected state:** observable result (UI text, file, DB row, exit code)
- **Boundaries:** what must not happen (network, production data)

### Gotchas

Traps that invalidate a run (timing, auth, shared ports).

## Proof report (after a proving run)

```markdown
### Status
VERIFIED | DRAFT

### Journey
<feature id> — <entry point>

### Commands
<ordered list actually run>

### Evidence
<paths to artifacts>

### Cleanup
<what was torn down; evidence retained at ...>

### Gaps
<unverified preconditions or stand-ins>
```

## Generator rules

- Ground every command in the target repo's scripts or docs.
- Never ship shell pseudocode from this file as if it were tested.
- If launch cannot be proven on the host, mark DRAFT and list blockers.

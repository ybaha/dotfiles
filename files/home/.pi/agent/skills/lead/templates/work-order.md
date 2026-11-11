# WO-<NNN>: <short title>

**Branch:** `worktree/<slug>`, based on `<base-branch>` @ `<sha if useful>`.

**From:** <link to evidence: issue, audit doc, user report, screenshots>

## Background & evidence

What is wrong or missing today. Cite paths and line ranges. Paste only non-secret excerpts. List what you read to confirm.

## Decisions (locked)

Bullets the worker must not reopen without asking the lead:

- …

## Exact files and lines

Named paths, symbols, and the change each deliverable requires. Prefer "change X in `path:lines` to Y" over vague areas.

## Out of scope

Explicit non-goals and files owned by another worker or deliverable.

## How to work

- You are the orchestrator in this worktree only.
- Delegate code edits to `worker` (Composer 2.5) subagents with self-contained prompts (files, current behaviour, target behaviour, checks).
- Review every diff; you commit in logical steps. Do not push.

## Verify

Exact commands (unit/integration/lint/build). Which tests to add or extend. Runtime proof if required.

## Constraints

Dependencies, API/response-shape stability, design tokens, no new packages, secrets stay local, etc.

## Local running / ports

How to run app/services; port if this worker shares a machine with others. Do not stop unrelated processes.

## Done when

Checklist the lead can verify from git diff, tests, and your report.

## Report format

Under 250 words: commits, files touched, test results, screenshots paths, blockers, anything deferred.

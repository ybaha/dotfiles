# Adaptive handoff v2 (recommended shape)

Pick envelope **kind** from task class. Same receiver contract: `{"need":[...]}` (max 2 IDs, max 2 rounds) or final `{"answer":...}` with schema-specific fields.

## ASK — trivial / quick config questions

One sentence question + contract + broker artifact IDs. **No** full GOAL/SCOPE/DECISIONS block.

```
PROTOCOL adaptive_handoff_v2 kind=ASK
ASK: What is the effective initial retry backoff (seconds) for the checkout worker?
CONTRACT: {"answer": <number>, "evidence": ["artifact-id", ...]}
ARTIFACT_REFS: config-snippet, note-current-2026-10, note-draft-obsolete
```

## TASK — bounded feature / table work

Structured scope for implementation handoffs.

```
PROTOCOL adaptive_handoff_v2 kind=TASK
GOAL: Add cancel transition per task-feature-spec.
SCOPE: Append queued+cancel→cancelled; preserve machine-v1 transitions.
CONSTRAINTS: Output machine_table JSON + evidence IDs.
POINTERS: task-feature-spec, machine-v1
DONE_WHEN: simulator accepts full table
```

## RESULT — long-running job completion

Compact outcome + open issues + evidence pointers. **Not** a substitute for live job telemetry.

```
PROTOCOL adaptive_handoff_v2 kind=RESULT
RESULT_SUMMARY: checkout-sync-4421 failed CI; dashboard snapshot predates failure.
OPEN_ISSUES: human triage; agent idle; dashboard stale vs log-ci truth.
CONTRACT: longrun_handoff JSON
EVIDENCE_REFS: log-ci-4421, dashboard-stale-4421, worker-status-4421, run-timeline-4421
```

### Long-job waiting (production)

Do **not** poll the LLM for status while work runs. Use Herdr **durable events / receipts** (job started, phase, failed test, needs-human). This benchmark’s long-result case is a **static** stale-vs-truth fixture; it does **not** measure real wall-clock long-running behavior.

## Cross-host artifact references

Recipient machines cannot read sender-local paths. Every pointer must be broker-resolvable metadata:

```json
{
  "artifact_id": "log-ci-4421",
  "host": "build-42.internal",
  "path": "/var/ci/logs/4421.txt",
  "sha256": "abc…",
  "version": 3,
  "fetch": "herdr-artifact-v1/get",
  "fallback": "inline_excerpt or targeted_transfer"
}
```

If fetch fails (missing/stale hash), receiver should `need[]` alternate IDs or request transfer — never invent facts.

## Herdr transport (illustrative)

```json
{"transport":"herdr-handoff-v2","task_id":"checkout-sync-4421","envelope_kind":"RESULT","body":"…"}
{"transport":"herdr-handoff-v2","task_id":"checkout-sync-4421","kind":"need","artifact_ids":["log-ci-4421"]}
{"transport":"herdr-handoff-v2","task_id":"checkout-sync-4421","kind":"answer","payload":{"answer":{…}}}
```

No session resume in benchmark runs; production should correlate via `task_id` + artifact receipts.

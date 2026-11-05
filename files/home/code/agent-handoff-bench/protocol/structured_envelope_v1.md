# Structured handoff v1 (producer output target)

Use full sections only for **TASK**-class work. For quick questions prefer `adaptive_handoff_v2.md` **ASK** (one sentence). See adaptive doc for **RESULT** long-run shape.

```
GOAL: <one line>
SCOPE: <bounded work>
CONSTRAINTS: <hard rules>
DECISIONS: <settled choices>
POINTERS: <artifact-id list with host/path/sha256/version when cross-host>
DONE_WHEN: <acceptance + JSON schema name>
```

Receiver contract: respond with `{"need":[...]}` (max 2 IDs, max 2 rounds) or final `{"answer":...}` including `evidence` IDs.

## Herdr ask/answer envelope (illustrative)

Sender → receiver (no session resume):

```json
{"transport":"herdr-handoff-v2","task_id":"job-123","envelope_kind":"TASK","body":"GOAL: ..."}
```

Receiver ask:

```json
{"transport":"herdr-handoff-v2","task_id":"job-123","kind":"need","artifact_ids":["config-snippet"],"artifact_meta":[{"artifact_id":"config-snippet","sha256":"…"}]}
```

Runner/broker supplies artifact bytes; receiver answers:

```json
{"transport":"herdr-handoff-v2","task_id":"job-123","kind":"answer","payload":{"answer":30,"evidence":["config-snippet"]}}
```

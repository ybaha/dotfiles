# Hybrid handoff v2 (tuned wrapper)

Deterministic header from `adaptive_handoff_v2` **kind** (ASK / TASK / RESULT) plus model-produced `hybrid_envelope` body. No gold in producer.

Observed pilot omissions (training, gpt-6-luna): obsolete note values; stale dashboard treated as truth; feature tables dropping baseline transitions; reference-only under-fetching.

```
<adaptive_envelope_header from case type>
RETRIEVAL: need[] max 2 IDs, max 2 rounds; inline excerpt if cross-host fetch fails

<body from hybrid_envelope producer>
```

Cross-host: see artifact metadata in `adaptive_handoff_v2.md`. Long jobs: Herdr events/receipts, not LLM polling.

Holdout comparison vs baseline was **not completed** in run `20261029T131435-ab3d3559` (55-call budget exhausted after training). Do not claim v2 beat baseline on held-out cases until those trials run.

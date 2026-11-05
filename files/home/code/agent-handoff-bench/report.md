# Agent handoff benchmark — audited pilot (20261029T131435-ab3d3559)

**Status: incomplete pilot, not a validated production winner.** This report uses real experiment logs only; fake test output is excluded. No additional model calls were made to produce it.

- Recorded model calls: **55** (10 producer, 45 receiver including retrieval continuations).
- Completed training trials: **30**, across three synthetic cases and five methods, two repetitions each.
- Held-out receiver trials: **0/6 planned**; the 55-call cap stopped the experiment before they ran.
- Provider-reported tokens: **29,203** = 23,181 input + 6,022 output. Cache reads/writes: 0/0.
- Configuration selected `openai-codex/gpt-6-luna`, minimal thinking. Original logs did not retain model identity or full responses, which limits independent verification.

## Measured cost and provisional quality

| Method | Original evaluator passes | Receiver tokens | Unique sender tokens | Actual used tokens | Mean tokens/handoff, including full sender cost |
|---|---:|---:|---:|---:|---:|
| full_evidence | 6/6 | 2,680 | 0 | 2,680 | 446.7 |
| hybrid_envelope | 6/6 | 7,049 | 2,288 | 9,337 | 1937.5 |
| reference_only | 3/6 | 4,576 | 0 | 4,576 | 762.7 |
| structured_envelope | 5/6 | 4,979 | 1,723 | 6,702 | 1404.2 |
| summary_200w | 2/6 | 3,799 | 1,561 | 5,360 | 1153.5 |

The experiment also spent 548 tokens preparing an unused holdout payload. Sender payloads were reused across repetitions. The final column instead charges the full generation cost for each handoff, so it does not hide preparation overhead.

## What the evidence supports
- On these **small source packets**, full evidence had the lowest measured cost and passed all six original checks. Summarization and retrieval overhead outweighed compression benefits.
- Free-text summary and reference-only methods lost required information in several trials. Structured/hybrid formats are not automatically more economical.
- This is not evidence that full transcripts are optimal for large repositories, nor that a condensed protocol has been proven for multi-hour feature work.

## Provisional adaptive operating rule
1. **ASK:** send the actual short question plus only necessary current facts; avoid paying another model to summarize a tiny packet.
2. **TASK:** use a concise goal/scope/constraints/done-when contract. Preserve authoritative artifacts and supply exact excerpts only when needed.
3. **RESULT:** return status, a brief outcome, verification, unresolved issues and artifact references. Keep logs/diffs out of the main conversation unless requested.
4. Keep task IDs and routing metadata in the transport. Waiting is handled by lifecycle events/task receipts, not repeated LLM status questions.
5. Cross-host references need a verified host/path/version/hash plus an actual transfer/resolution mechanism. Sender-local files are not magically readable remotely.

These TASK/RESULT templates are **design candidates**, not held-out benchmark winners. They have not been installed as an automatic Herdr transport.

## Limitations and harness repairs
- Original quality checks were permissive; some artifact names leaked recency/staleness clues. Original receiver responses are absent, so stricter scoring cannot be applied retroactively.
- Feature work was a declarative state-machine-table task, not a production-repository implementation. Long-running work was a static result packet, not an actual hours-long job.
- The initial aggregator double-counted receiver rollups; the numbers above count only producer/receiver_call records. Fake reports no longer overwrite this report during tests.
- The runner now retains future responses/evaluation reasons, uses a real subprocess deadline, resumes cumulative budgets, and requires explicit --allow-live. Limits are checked between requests; the final request can overshoot a token threshold.
- Retrieval is a synthetic artifact broker, not an implemented secure cross-host file transport. No statistical confidence or universal optimal compression ratio is claimed.

## Reproduce safely
`python3 summarize.py 20261029T131435-ab3d3559` regenerates this report offline. `python3 -m unittest discover -s tests -v` runs offline tests. Do not resume this capped experiment to evade its budget; a revised live study needs a new ID and explicit --allow-live.

Raw log SHA-256: `82af1b505eea44103c08e43da4ee6cfe9a906395b96f5e185e2b6a72b0994b0f`
Raw log: `results/20261029T131435-ab3d3559/per_call.jsonl`
Audited metrics: `results/20261029T131435-ab3d3559/audited-summary.json`

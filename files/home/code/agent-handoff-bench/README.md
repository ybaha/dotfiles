# Agent handoff protocol benchmark — experimental pilot

See `report.md` for audited REAL measurements and limitations. The initial study completed 30 synthetic training trials (55 model calls, 29,203 recorded tokens); the planned held-out receiver evaluation did not run. No universal large-context winner or production Herdr transport has been established.

## Files

- `fixtures.json`: public source packets/cases and separate evaluator gold; producer/receiver prompts do not include gold.
- `runner.py`: explicit opt-in model experiment, Pi JSONL accounting, bounded retrieval.
- `summarize.py`: offline audited reporting from existing actual call records (never calls a model).
- `tests/`: offline fake-process, deadline, metrics and evaluator regressions.
- `protocol/`: proposed ASK/TASK/RESULT templates, **not held-out-validated**.
- `results/20261029T131435-ab3d3559/per_call.jsonl`: preserved original run. Legacy response text/model identity were not retained; original pass flags cannot be rescaled under the improved evaluator.

## Safe offline commands

```sh
python3 -m unittest discover -s tests -v
python3 summarize.py 20261029T131435-ab3d3559
```

Test reports stay inside their own result folders and cannot overwrite the audited root report. The audited report excludes fake test calls and receiver-rollup duplicates.

## Future live study (costs provider quota)

Use a NEW run ID and explicit approval; don't resume a capped run to bypass its budget:

```sh
python3 runner.py --allow-live --run-id NEW_STUDY_ID
```

Review fixture sizes, method order and repetition/holdout allocation first. The default 55-call budget was insufficient for both training repetitions and holdout retrieval in the pilot. Caps: 55 calls, 180k reported tokens, 20 minutes wall time; each Pi subprocess has a 60-second deadline. Token limits are checked between calls, so a final request can overshoot a threshold. Cumulative call/token usage is reconstructed on resume. No additional live runs were made while repairing the harness.

Live receiver: configured `openai-codex/gpt-6-luna`, minimal thinking, tools/extensions/context files/MCP disabled, no session persisted, neutral temporary cwd. Requests require an already-authenticated local Pi; credentials are not copied or printed. Future records retain receiver text and evaluator reasons. Reported model costs are not actual subscription bills.

## Scope

Retrieval is a synthetic broker, not cross-host file access. A production handoff must validate artifact host/path/hash/version, route to a stable native agent identity, retain task receipts and distinguish idle from verified success. Long-job fixtures are static results, not hours-long execution tests. References and summarization can increase token consumption for small inputs; direct short requests are a sensible default until larger-source studies justify compaction.

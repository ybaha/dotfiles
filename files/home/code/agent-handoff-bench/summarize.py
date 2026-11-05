#!/usr/bin/env python3
"""Publish audited measurements from existing real JSONL; never calls a model."""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def summarize(run_id):
    if not run_id or '/' in run_id or run_id.startswith(('fake', '_unit')):
        raise ValueError('Supply an existing real experiment ID, not a test run')
    folder = ROOT / 'results' / run_id
    raw = (folder / 'per_call.jsonl').read_bytes()
    rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    calls = [r for r in rows if r.get('role') in ('producer', 'receiver_call')]
    trials = [r for r in rows if r.get('role') == 'receiver' and r.get('phase') == 'train']
    total = {k: sum(r.get('usage', {}).get(k, 0) for r in calls) for k in ('input','output','cacheRead','cacheWrite','totalTokens')}
    methods = []
    for strategy in sorted({r['strategy'] for r in trials}):
        ts = [r for r in trials if r['strategy'] == strategy]
        receiver = sum(r['usage']['totalTokens'] for r in calls if r['role']=='receiver_call' and r['strategy']==strategy and r.get('phase')=='train')
        producers = [r for r in calls if r['role']=='producer' and r['strategy']==strategy and r.get('phase')=='train']
        sender = sum(r['usage']['totalTokens'] for r in producers)
        normalized = receiver + sum(sum(p['usage']['totalTokens'] for p in producers if p['case_id']==trial['case_id']) for trial in ts)
        methods.append({'strategy':strategy,'trials':len(ts),'legacy_passes':sum(r.get('pass_eval') is True for r in ts),'receiver_tokens':receiver,'unique_sender_tokens':sender,'actual_used_tokens':receiver+sender,'per_handoff_tokens':normalized/len(ts)})
    holdout = [r for r in rows if r.get('role')=='receiver' and r.get('phase')=='holdout']
    summary = {'run_id':run_id,'raw_sha256':hashlib.sha256(raw).hexdigest(),'calls':len(calls),'producer_calls':sum(r['role']=='producer' for r in calls),'receiver_calls':sum(r['role']=='receiver_call' for r in calls),'training_trials':len(trials),'holdout_trials':len(holdout),'usage':total,'methods':methods,'quality_label':'legacy evaluator, provisional; responses not retained, cannot rescore retroactively'}
    (folder / 'audited-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    lines = [f'# Agent handoff benchmark — audited pilot ({run_id})','',
        '**Status: incomplete pilot, not a validated production winner.** This report uses real experiment logs only; fake test output is excluded. No additional model calls were made to produce it.','',
        f'- Recorded model calls: **{len(calls)}** ({summary["producer_calls"]} producer, {summary["receiver_calls"]} receiver including retrieval continuations).',
        f'- Completed training trials: **{len(trials)}**, across three synthetic cases and five methods, two repetitions each.',
        f'- Held-out receiver trials: **{len(holdout)}/6 planned**; the 55-call cap stopped the experiment before they ran.',
        f'- Provider-reported tokens: **{total["totalTokens"]:,}** = {total["input"]:,} input + {total["output"]:,} output. Cache reads/writes: {total["cacheRead"]}/{total["cacheWrite"]}.',
        '- Configuration selected `openai-codex/gpt-6-luna`, minimal thinking. Original logs did not retain model identity or full responses, which limits independent verification.','',
        '## Measured cost and provisional quality','',
        '| Method | Original evaluator passes | Receiver tokens | Unique sender tokens | Actual used tokens | Mean tokens/handoff, including full sender cost |',
        '|---|---:|---:|---:|---:|---:|']
    for m in methods:
        lines.append(f'| {m["strategy"]} | {m["legacy_passes"]}/{m["trials"]} | {m["receiver_tokens"]:,} | {m["unique_sender_tokens"]:,} | {m["actual_used_tokens"]:,} | {m["per_handoff_tokens"]:.1f} |')
    used = sum(m['actual_used_tokens'] for m in methods)
    lines += ['',f'The experiment also spent {total["totalTokens"]-used:,} tokens preparing an unused holdout payload. Sender payloads were reused across repetitions. The final column instead charges the full generation cost for each handoff, so it does not hide preparation overhead.',
        '', '## What the evidence supports',
        '- On these **small source packets**, full evidence had the lowest measured cost and passed all six original checks. Summarization and retrieval overhead outweighed compression benefits.',
        '- Free-text summary and reference-only methods lost required information in several trials. Structured/hybrid formats are not automatically more economical.',
        '- This is not evidence that full transcripts are optimal for large repositories, nor that a condensed protocol has been proven for multi-hour feature work.',
        '', '## Provisional adaptive operating rule',
        '1. **ASK:** send the actual short question plus only necessary current facts; avoid paying another model to summarize a tiny packet.',
        '2. **TASK:** use a concise goal/scope/constraints/done-when contract. Preserve authoritative artifacts and supply exact excerpts only when needed.',
        '3. **RESULT:** return status, a brief outcome, verification, unresolved issues and artifact references. Keep logs/diffs out of the main conversation unless requested.',
        '4. Keep task IDs and routing metadata in the transport. Waiting is handled by lifecycle events/task receipts, not repeated LLM status questions.',
        '5. Cross-host references need a verified host/path/version/hash plus an actual transfer/resolution mechanism. Sender-local files are not magically readable remotely.',
        '', 'These TASK/RESULT templates are **design candidates**, not held-out benchmark winners. They have not been installed as an automatic Herdr transport.',
        '', '## Limitations and harness repairs',
        '- Original quality checks were permissive; some artifact names leaked recency/staleness clues. Original receiver responses are absent, so stricter scoring cannot be applied retroactively.',
        '- Feature work was a declarative state-machine-table task, not a production-repository implementation. Long-running work was a static result packet, not an actual hours-long job.',
        '- The initial aggregator double-counted receiver rollups; the numbers above count only producer/receiver_call records. Fake reports no longer overwrite this report during tests.',
        '- The runner now retains future responses/evaluation reasons, uses a real subprocess deadline, resumes cumulative budgets, and requires explicit --allow-live. Limits are checked between requests; the final request can overshoot a token threshold.',
        '- Retrieval is a synthetic artifact broker, not an implemented secure cross-host file transport. No statistical confidence or universal optimal compression ratio is claimed.',
        '', '## Reproduce safely',
        f'`python3 summarize.py {run_id}` regenerates this report offline. `python3 -m unittest discover -s tests -v` runs offline tests. Do not resume this capped experiment to evade its budget; a revised live study needs a new ID and explicit --allow-live.',
        '',f'Raw log SHA-256: `{summary["raw_sha256"]}`',f'Raw log: `results/{run_id}/per_call.jsonl`',f'Audited metrics: `results/{run_id}/audited-summary.json`','']
    (ROOT/'report.md').write_text('\n'.join(lines))
    print(json.dumps({'run_id':run_id,'model_calls':len(calls),'tokens':total['totalTokens'],'training_trials':len(trials),'holdout_trials':len(holdout)}))
    return summary

if __name__=='__main__':
    if len(sys.argv)!=2: raise SystemExit('Usage: python3 summarize.py REAL_RUN_ID')
    summarize(sys.argv[1])

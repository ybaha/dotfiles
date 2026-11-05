#!/usr/bin/env python3
"""Fake pi JSONL emitter for unit tests."""
import json
import sys

payload = sys.stdin.read()

if "Write ~200 word" in payload or "structured handoff" in payload or "structured envelope" in payload:
    text = (
        "TASK preserved. goal: answer from authoritative artifacts. "
        "pointers: config-snippet, log-ci-4421. done_when: JSON with evidence."
    )
else:
    resp = {"answer": {"answer": 30, "evidence": ["config-snippet"]}}
    if "maximum retry backoff" in payload or "max_backoff" in payload:
        resp = {"answer": {"answer": 300, "evidence": ["config-snippet"]}}
    elif "ARTIFACT_CATALOG" in payload and "need" not in payload:
        resp = {"need": ["config-snippet"]}
    elif "machine_table" in payload or "feature_table" in payload or "cancel" in payload:
        mt = json.loads(
            '{"initial":"queued","transitions":['
            '{"from":"queued","event":"dispatch","to":"running"},'
            '{"from":"running","event":"success","to":"done"},'
            '{"from":"running","event":"fail","to":"failed"},'
            '{"from":"failed","event":"retry","to":"queued"},'
            '{"from":"queued","event":"cancel","to":"cancelled"}'
            ']}'
        )
        if "pause" in payload:
            mt["transitions"].extend(
                [
                    {"from": "running", "event": "pause", "to": "paused"},
                    {"from": "paused", "event": "resume", "to": "running"},
                ]
            )
        resp = {"answer": {"machine_table": mt, "evidence": ["machine-v1"]}}
    elif "longrun" in payload or "checkout-sync-4421" in payload:
        resp = {
            "answer": {
                "job_id": "checkout-sync-4421",
                "tests_failed": True,
                "dashboard_stale": True,
                "needs_human": True,
                "agent_idle": True,
                "failing_test": "integration_tests/test_payment_idempotency.py",
                "evidence": ["log-ci-4421", "dashboard-stale-4421"],
            }
        }
    text = json.dumps(resp)

lines = [
    {"type": "session", "version": 3, "id": "fake", "timestamp": "2026-01-01T00:00:00.000Z", "cwd": "/tmp"},
    {"type": "agent_start"},
    {
        "type": "message_end",
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}], "stopReason": "stop",
                    "usage": {"input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 15}},
    },
    {"type": "agent_settled", "aborted": False},
]
for line in lines:
    sys.stdout.write(json.dumps(line) + "\n")
    sys.stdout.flush()

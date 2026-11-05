#!/usr/bin/env python3
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import runner  # noqa: E402


class EvaluatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = runner.load_fixtures(ROOT / "fixtures.json")
        cls.arts = cls.fx["public_artifacts"]

    def test_feature_cancel_pass(self):
        base = json.loads(self.arts["machine-v1"])
        table = {
            "machine_table": {
                **base,
                "transitions": base["transitions"]
                + [{"from": "queued", "event": "cancel", "to": "cancelled"}],
            }
        }
        ok, _ = runner.eval_feature_table(table, self.fx["gold"]["case-feature-cancel"], self.arts)
        self.assertTrue(ok)

    def test_feature_unsafe_fail(self):
        base = json.loads(self.arts["machine-v1"])
        bad = {
            "machine_table": {
                **base,
                "transitions": base["transitions"]
                + [{"from": "running", "event": "cancel", "to": "cancelled"}],
            }
        }
        ok, _ = runner.eval_feature_table(bad, self.fx["gold"]["case-feature-cancel"], self.arts)
        self.assertFalse(ok)

    def test_retrieval_cap(self):
        self.assertEqual(runner.MAX_RETRIEVAL_ROUNDS, 2)

    def test_budget_caps(self):
        b = runner.Budget()
        b.calls = runner.MAX_CALLS
        with self.assertRaises(RuntimeError):
            b.check()

    def test_metrics_no_double_pass_count(self):
        d = runner.ROOT / "results" / "_unit_agg"
        d.mkdir(parents=True, exist_ok=True)
        (d / "per_call.jsonl").write_text(
            "\n".join(
                [
                    json.dumps({"role": "receiver_call", "usage": {"totalTokens": 10, "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0}}),
                    json.dumps(
                        {
                            "role": "receiver",
                            "strategy": "full_evidence",
                            "pass_eval": True,
                            "usage": {"totalTokens": 10, "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0},
                            "retrieval_rounds": 0,
                        }
                    ),
                ]
            )
            + "\n"
        )
        summary = runner.aggregate(d, self.fx, {})
        self.assertEqual(summary["total_usage"]["totalTokens"], 10)
        self.assertEqual(summary["by_strategy"]["full_evidence"]["pass_rate"], 1.0)


class FakePiTests(unittest.TestCase):
    def test_fake_pi_subprocess(self):
        fake = ROOT / "tests" / "fake_pi.py"
        client = runner.PiClient([], ROOT, "unit", fake=fake)
        text, usage, stop, ok = client.call("test", "simple question", runner.Budget())
        self.assertTrue(ok)
        self.assertIn("answer", text)
        self.assertGreater(usage.totalTokens, 0)
        self.assertEqual(stop, "stop")


if __name__ == "__main__":
    unittest.main()

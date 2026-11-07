import contextlib
import copy
import importlib.util
import io
import json
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "files/home/.pi/agent/extensions/quota-fetch.py"
spec = importlib.util.spec_from_file_location("quota_fetch", SCRIPT)
quota = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quota)


class CodexQuotaTests(unittest.TestCase):
    def setUp(self):
        self.auth = {"openai-codex": {"type": "oauth", "access": "fake-token", "accountId": "fake-account"}}
        self.payload = {
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {"used_percent": 3, "reset_at": 123},
                "secondary_window": {"used_percent": 34, "reset_at": 456},
            },
        }

    def test_pi_login_without_cli(self):
        with patch.object(Path, "read_text", return_value=json.dumps(self.auth)), \
             patch.object(quota.urllib.request, "urlopen", return_value=io.StringIO(json.dumps(self.payload))) as urlopen, \
             patch.object(quota, "fetch_codex_cli") as cli:
            snap = quota.fetch_codex()
        self.assertEqual(snap["primaryLeft"], 97)
        self.assertEqual(snap["weeklyLeft"], 66)
        self.assertEqual(snap["plan"], "Plus")
        self.assertEqual(snap["primaryResetsAt"], 123)
        self.assertEqual(snap["weeklyResetsAt"], 456)
        self.assertTrue(snap["live"])
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://chatgpt.com/backend-api/wham/usage")
        self.assertEqual(request.get_header("Authorization"), "Bearer fake-token")
        self.assertEqual(request.get_header("Chatgpt-account-id"), "fake-account")
        cli.assert_not_called()

    def test_cli_fallback_when_pi_login_absent(self):
        for auth in ({}, {"openai-codex": {"type": "api_key", "key": "fake"}}):
            with self.subTest(auth=auth), patch.object(Path, "read_text", return_value=json.dumps(auth)), \
                 patch.object(quota, "fetch_codex_cli", return_value={"source": "cli"}) as cli:
                self.assertEqual(quota.fetch_codex(), {"source": "cli"})
                cli.assert_called_once()
        with patch.object(Path, "read_text", side_effect=FileNotFoundError), \
             patch.object(quota, "fetch_codex_cli", return_value={"source": "cli"}):
            self.assertEqual(quota.fetch_codex(), {"source": "cli"})

    def assert_invalid(self, payload):
        with contextlib.redirect_stderr(io.StringIO()) as stderr, self.assertRaises(SystemExit):
            quota.codex_snapshot(payload, pi_oauth=True)
        self.assertEqual(stderr.getvalue(), "codex: invalid rate-limit response\n")

    def test_missing_windows_and_percent_fail(self):
        for window in ("primary_window", "secondary_window"):
            payload = copy.deepcopy(self.payload)
            del payload["rate_limit"][window]
            self.assert_invalid(payload)
            payload["rate_limit"][window] = {}
            self.assert_invalid(payload)
        self.assert_invalid({})
        self.assert_invalid(None)

    def test_invalid_percentages_fail(self):
        for value in (None, True, "3", -1, 101, float("nan"), float("inf")):
            with self.subTest(value=value):
                payload = copy.deepcopy(self.payload)
                payload["rate_limit"]["primary_window"]["used_percent"] = value
                self.assert_invalid(payload)

    def test_cli_response_normalization(self):
        snap = quota.codex_snapshot({
            "planType": "plus", "primary": {"usedPercent": 100, "resetsAt": 123},
            "secondary": {"usedPercent": 0, "resetsAt": 456},
        }, pi_oauth=False)
        self.assertEqual((snap["primaryLeft"], snap["weeklyLeft"]), (0, 100))

    def test_pi_failures_are_sanitized_and_never_switch_account(self):
        errors = (
            urllib.error.HTTPError("https://example.invalid", 401, "fake-secret", {}, None),
            urllib.error.URLError("fake-secret"),
            ValueError("fake-secret"),
        )
        for error in errors:
            with self.subTest(error=type(error).__name__), \
                 patch.object(Path, "read_text", return_value=json.dumps(self.auth)), \
                 patch.object(quota.urllib.request, "urlopen", side_effect=error), \
                 patch.object(quota, "fetch_codex_cli") as cli, \
                 contextlib.redirect_stderr(io.StringIO()) as stderr, self.assertRaises(SystemExit):
                quota.fetch_codex()
            self.assertNotIn("fake-secret", stderr.getvalue())
            self.assertNotIn("fake-token", stderr.getvalue())
            cli.assert_not_called()


if __name__ == "__main__":
    unittest.main()

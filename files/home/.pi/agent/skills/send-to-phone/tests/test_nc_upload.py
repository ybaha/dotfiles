#!/usr/bin/env python3
"""Exercise upload routing without Keychain access or network requests."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "nc-upload"


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.log = self.root / "requests.jsonl"
        self.file = self.root / "review file.md"
        self.file.write_text("phone review\n")
        curl = self.root / "curl"
        curl.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ['MOCK_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if '-X' in args:
    print(os.environ.get('MOCK_MKCOL', '201'), end='')
else:
    pathlib.Path(args[args.index('-D') + 1]).write_text('OC-FileId: 0000123\\r\\n')
    print(os.environ.get('MOCK_PUT', '201'), end='')
""")
        curl.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ["PATH"],
                        NC_AGENT_TOKEN="test-only-token", NC_AGENT_URL="https://example.invalid",
                        MOCK_LOG=str(self.log))

    def run_upload(self, *args):
        return subprocess.run(["bash", str(SCRIPT), *map(str, args)], env=self.env,
                              text=True, capture_output=True, timeout=10)

    def requests(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_destination_required(self):
        result = self.run_upload(self.file)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.log.exists())

    def test_invalid_destinations_make_no_requests(self):
        for destination in ("", "karardex", "/karardex/marketing", "karardex/marketing/",
                            "karardex//marketing", "karardex/../rooma", "../marketing",
                            "Karardex/marketing", "karardex/marketing videos",
                            "karardex/%2e%2e", "karardex/a--b", "karardex/marketing\n"):
            with self.subTest(destination=destination):
                result = self.run_upload("-d", destination, self.file)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(self.log.exists())

    def test_all_local_files_checked_before_requests(self):
        result = self.run_upload("-d", "karardex/marketing", self.file, self.root / "missing.md")
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.log.exists())

    def test_nested_upload_and_link(self):
        result = self.run_upload("-d", "karardex/marketing/reels/final-v1", self.file)
        self.assertEqual(result.returncode, 0, result.stderr)
        requests = self.requests()
        self.assertEqual(len(requests), 5)
        self.assertEqual([args[-1].split('/AI-Inbox/')[1] for args in requests[:-1]],
                         ["karardex", "karardex/marketing", "karardex/marketing/reels",
                          "karardex/marketing/reels/final-v1"])
        self.assertTrue(requests[-1][-1].endswith("/review%20file.md"))
        self.assertIn("AI-Inbox/karardex/marketing/reels/final-v1/review file.md", result.stdout)
        self.assertIn("https://example.invalid/index.php/f/123", result.stdout)
        self.assertNotIn(self.env["NC_AGENT_TOKEN"], self.log.read_text())

    def test_existing_folders_and_overwrite(self):
        self.env.update(MOCK_MKCOL="405", MOCK_PUT="204")
        second = self.root / "second.pdf"
        second.write_bytes(b"test")
        result = self.run_upload("-d", "rooma/support/case-id", self.file, second)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.requests()), 5)
        self.assertEqual(len(result.stdout.splitlines()), 2)

    def test_folder_failure_stops_upload(self):
        self.env["MOCK_MKCOL"] = "403"
        result = self.run_upload("-d", "rooma/support", self.file)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(self.requests()), 1)
        self.assertIn("HTTP 403", result.stderr)

    def test_upload_failure(self):
        self.env["MOCK_PUT"] = "507"
        result = self.run_upload("-d", "rooma/development", self.file)
        self.assertEqual(result.returncode, 1)
        self.assertIn("HTTP 507", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_missing_url_asks_for_local_env(self):
        del self.env["NC_AGENT_URL"]
        self.env["PI_AGENT_LOCAL_ENV"] = str(self.root / "absent.env")
        result = self.run_upload("-d", "rooma/support", self.file)
        self.assertEqual(result.returncode, 1)
        self.assertIn("NC_AGENT_URL is not set", result.stderr)
        self.assertFalse(self.log.exists())

    def test_url_read_from_local_env_file(self):
        del self.env["NC_AGENT_URL"]
        env_file = self.root / "local.env"
        env_file.write_text("NC_AGENT_URL=https://from-file.invalid\n")
        self.env["PI_AGENT_LOCAL_ENV"] = str(env_file)
        result = self.run_upload("-d", "rooma/support", self.file)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("https://from-file.invalid/index.php/f/123", result.stdout)

    def test_environment_url_beats_local_env_file(self):
        env_file = self.root / "local.env"
        env_file.write_text("NC_AGENT_URL=https://from-file.invalid\n")
        self.env["PI_AGENT_LOCAL_ENV"] = str(env_file)
        result = self.run_upload("-d", "rooma/support", self.file)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("https://example.invalid/index.php/f/123", result.stdout)


if __name__ == "__main__":
    unittest.main()

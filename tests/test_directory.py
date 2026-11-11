import os, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "directory" / "build.py"


class DirectoryBuild(unittest.TestCase):
    def test_builds_without_leaking_tailnet(self):
        with tempfile.TemporaryDirectory() as out:
            env = {**os.environ, "TAILNET": "example-tailnet.ts.net"}
            subprocess.run([sys.executable, "-I", str(BUILD), out], check=True, env=env, capture_output=True)
            for f in ("index.html", "index.md", "llms.txt", "services.json", "infrastructure.md", "health.tsv"):
                self.assertTrue((Path(out) / f).exists(), f)
            text = (Path(out) / "services.json").read_text()
            self.assertIn("example-tailnet.ts.net", text)
            self.assertNotIn("{tailnet}", text)
        registry = (ROOT / "directory" / "registry.toml").read_text()
        self.assertNotRegex(registry, r"\b(?!127\.)\d+\.\d+\.\d+\.\d+")
        self.assertNotRegex(registry, r"[a-z0-9]{6}\.ts\.net")


if __name__ == "__main__":
    unittest.main()

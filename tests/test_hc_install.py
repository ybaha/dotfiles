import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InstallDryRunTests(unittest.TestCase):
    def test_dry_run_preserves_home_and_does_not_link_herdr_state(self):
        with tempfile.TemporaryDirectory(prefix='hc-install-') as tmp:
            home = Path(tmp)
            for relative in ('.zshrc', '.config/herdr/config.toml', '.config/herdr-app/config.json'):
                path = home / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('owner-managed\n')
            before = {str(p.relative_to(home)): (p.lstat().st_mtime_ns, p.read_bytes() if p.is_file() else None)
                      for p in home.rglob('*')}
            result = subprocess.run(['bash', str(ROOT / 'install.sh'), '--dry-run'],
                                    cwd=ROOT, env=dict(os.environ, HOME=tmp),
                                    capture_output=True, text=True, check=True, timeout=15)
            after = {str(p.relative_to(home)): (p.lstat().st_mtime_ns, p.read_bytes() if p.is_file() else None)
                     for p in home.rglob('*')}
            self.assertEqual(before, after)
            self.assertNotIn('.config/herdr/', result.stdout)
            self.assertNotIn('.config/herdr-app/', result.stdout)
            self.assertNotIn('hooks/herdr-agent-state.sh', result.stdout)
            self.assertFalse(any(p.is_symlink() for p in home.rglob('*')))


if __name__ == '__main__':
    unittest.main()

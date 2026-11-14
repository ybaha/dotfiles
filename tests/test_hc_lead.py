"""Exercise lead scripts against a fake hc; never contact a running terminal."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'files/home/.pi/agent/skills/lead/scripts'

FAKE_HC = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
root = Path(os.environ['FAKE_HC_DIR'])
with (root / 'calls.jsonl').open('a') as f: f.write(json.dumps(args) + '\\n')
cmd = args[0]
if cmd == 'ls':
    if os.environ.get('FAIL_LS'): sys.exit(2)
    info = root / 'terminal.json'
    print(json.dumps({'terminals': [json.loads(info.read_text())] if info.exists() else []}))
elif cmd == 'run':
    def value(flag): return args[args.index(flag) + 1]
    labels = dict(args[i + 1].split('=', 1) for i, a in enumerate(args) if a == '--label')
    info = {'address':'t42', 'name':value('--name'), 'cwd':value('--cwd'), 'labels':labels,
            'state':'live', 'status':{'app':'pi', 'state':'idle'}, 'argv':['sh', '-c', args[-1]]}
    (root / 'terminal.json').write_text(json.dumps(info))
    print(json.dumps({'address':'t42'}))
elif cmd == 'get':
    print((root / 'terminal.json').read_text())
elif cmd == 'kill':
    info = json.loads((root / 'terminal.json').read_text()); info['state'] = 'finished'
    (root / 'terminal.json').write_text(json.dumps(info)); print('{}')
elif cmd in ('wait', 'send', 'rm'): print('{}')
else: sys.exit(99)
'''


class LeadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='hc-lead-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'node bin'
        self.bin.mkdir()
        for name, source in [('hc', FAKE_HC), ('pi', '#!/bin/sh\nexit 99\n')]:
            path = self.bin / name
            path.write_text(source)
            path.chmod(0o700)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.env = dict(os.environ, HOME=str(self.root / 'home'),
                        PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        WORKTREE_WATCHERS_DIR=str(self.root / 'state'),
                        FAKE_HC_DIR=str(self.root), HC_TERMINAL_ID='t1')
        self.git('init', '-b', 'master')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        (self.repo / 'README').write_text('base\n')
        self.git('add', 'README')
        self.git('commit', '-m', 'base')
        self.git('branch', 'chosen-base')
        (self.repo / 'README').write_text('later\n')
        self.git('commit', '-am', 'later')
        self.brief = self.root / 'brief'
        self.brief.write_text('Inspect only. Do not edit.\n')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], env=self.env,
                              capture_output=True, text=True, check=True, timeout=10).stdout.strip()

    def script(self, name, *args, check=True, env=None):
        return subprocess.run(['bash', str(SCRIPTS / name), *args], cwd=self.repo, env=env or self.env,
                              capture_output=True, text=True, check=check, timeout=15)

    def spawn(self):
        return self.script('spawn.sh', '--slug', 'fix', '--brief', str(self.brief),
                           '--base', 'chosen-base', '--model', 'test/model:high')

    def calls(self):
        return [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]

    def test_spawn_labels_path_base_prompt_and_status(self):
        self.spawn()
        state = json.loads((self.root / 'state/fix.json').read_text())
        self.assertEqual(state['terminal'], 't42')
        self.assertEqual(state['lead']['terminal'], 't1')
        wt = Path(state['worktreePath'])
        self.assertEqual((wt / 'README').read_text(), 'base\n')
        run = next(c for c in self.calls() if c[0] == 'run')
        self.assertEqual(run[:3], ['run', '--bg', '--no-parent'])
        for label in ('herdr.space=fix', 'herdr.tab=fix:t1', 'ovis.workspace=fix', 'dotfiles.worker=fix'):
            self.assertIn(label, run)
        self.assertIn("PATH='" + str(self.bin) + "':$PATH exec", run[-1])
        self.assertEqual([c for c in self.calls() if c[0] == 'send'], [['send', 't42', self.brief.read_text().rstrip()]])
        self.assertIn('idle', self.script('status.sh').stdout)
        self.assertFalse((wt / '.herdr-watcher.pid').exists())

    def test_prompt_not_repeated(self):
        self.spawn()
        self.script('prompt.sh', 'fix', '--text', 'follow up')
        self.assertEqual(len([c for c in self.calls() if c == ['send', 't42', 'follow up']]), 1)

    def test_restarted_worker_is_resolved_by_name_and_verified(self):
        self.spawn()
        info = json.loads((self.root / 'terminal.json').read_text())
        info['address'] = 't43'
        (self.root / 'terminal.json').write_text(json.dumps(info))
        self.script('prompt.sh', 'fix', '--text', 'after restart')
        self.assertIn(['send', 't43', 'after restart'], self.calls())
        self.assertIn('idle', self.script('status.sh', env=dict(self.env, HC_TERMINAL_ID='t9')).stdout)
        self.script('close.sh', 'fix')
        self.assertIn(['kill', 't43'], self.calls())

    def test_prompt_refuses_changed_ownership(self):
        self.spawn()
        info = json.loads((self.root / 'terminal.json').read_text())
        info['cwd'] = '/someone-else'
        (self.root / 'terminal.json').write_text(json.dumps(info))
        result = self.script('prompt.sh', 'fix', '--text', 'must not send', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c == ['send', 't42', 'must not send'] for c in self.calls()))

    def test_close_retains_worktree_and_branch(self):
        self.spawn()
        state = json.loads((self.root / 'state/fix.json').read_text())
        out = self.script('close.sh', 'fix')
        self.assertIn('retained:', out.stdout)
        self.assertTrue(Path(state['worktreePath']).is_dir())
        self.git('show-ref', '--verify', 'refs/heads/worktree/fix')
        self.assertFalse((self.root / 'state/fix.json').exists())
        self.assertEqual([c[0] for c in self.calls() if c[0] in ('kill', 'rm')], ['kill', 'rm'])

    def test_close_refuses_wrong_terminal_even_force(self):
        self.spawn()
        info = json.loads((self.root / 'terminal.json').read_text())
        info['labels'] = {}
        (self.root / 'terminal.json').write_text(json.dumps(info))
        result = self.script('close.sh', 'fix', '--force', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[0] == 'kill' for c in self.calls()))
        self.assertTrue((self.root / 'state/fix.json').exists())

    def test_inventory_failure_does_not_create_worktree(self):
        result = self.script('spawn.sh', '--slug', 'fix', '--brief', str(self.brief),
                             check=False, env=dict(self.env, FAIL_LS='1'))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'home/.herdr/worktrees/repo/fix').exists())


if __name__ == '__main__':
    unittest.main()

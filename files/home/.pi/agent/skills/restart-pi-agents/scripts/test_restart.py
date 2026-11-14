import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('restart', Path(__file__).with_name('restart.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RestartTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'session.jsonl'
        self.path.touch()
        self.a = {'address': 't7', 'state': 'live', 'status': {'app': 'pi', 'state': 'idle'},
                  'cwd': '/project', 'name': 'review', 'argv': ['pi', '--session', str(self.path)],
                  'labels': {'herdr.space': 'review', 'herdr.tab': 'review:t1', 'ovis.workspace': 'Review', 'dotfiles.worker': 'review', 'private': 'ignored'}}

    def test_missing_session_never_calls_hc(self):
        self.path.unlink()
        with patch.object(r, 'cli') as cli, self.assertRaises(RuntimeError):
            r.restart(self.a)
        cli.assert_not_called()

    def test_working_and_blocked_are_not_quit(self):
        for state in ('working', 'blocked', 'error', None):
            a = dict(self.a, status={'app': 'pi', 'state': state})
            with patch.object(r, 'agent', return_value=a), patch.object(r, 'cli') as cli:
                with self.assertRaises(RuntimeError):
                    r.restart(a, interrupt=state == 'blocked')
            cli.assert_not_called()

    def test_changed_session_is_not_quit(self):
        other = Path(self.tmp.name) / 'other.jsonl'
        other.touch()
        live = dict(self.a, argv=['pi', '--session', str(other)])
        with patch.object(r, 'agent', return_value=live), patch.object(r, 'cli') as cli:
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                r.restart(self.a)
        cli.assert_not_called()

    def test_newest_cwd_fallback_and_explicit_id(self):
        directory = Path(self.tmp.name) / '.pi/agent/sessions/--project--'
        directory.mkdir(parents=True)
        saved = directory / '2026_uuid.jsonl'
        saved.touch()
        self.assertEqual(r.session(dict(self.a, argv=['pi']), self.tmp.name), str(saved))
        self.assertEqual(r.session(dict(self.a, argv=['pi', '--session', 'uuid']), self.tmp.name), str(saved))

    def test_shared_cwd_without_explicit_session_refused(self):
        with patch.object(r, 'agents', return_value=[{'address': 't1'}, {'address': 't2'}]), patch.object(r, 'agent', side_effect=[dict(self.a, argv=['pi']), dict(self.a, address='t2', argv=['pi'])]):
            with self.assertRaisesRegex(RuntimeError, 'share cwd'):
                r.snapshot()

    def test_launch_flags_and_shell_command(self):
        info = {'argv': ['/bin/sh', '-c', "PATH='/node bin':$PATH exec '/node bin/pi' --no-mcp --tools read --session old"]}
        self.assertEqual(r.launch_options(info), ['--no-mcp', '--tools', 'read'])
        self.assertFalse(r.launch_argv_available({'argv': ['zsh']}))
        with self.assertRaisesRegex(RuntimeError, '--default-launch'):
            r.launch_options({'argv': ['zsh']})
        self.assertEqual(r.launch_options({'argv': ['zsh']}, True), [])
        with self.assertRaisesRegex(RuntimeError, 'Unsupported') as error:
            r.launch_options({'argv': ['pi', '--unknown', 'secret']}, True)
        self.assertNotIn('secret', str(error.exception))

    def test_custom_session_directory_needs_explicit_file(self):
        with self.assertRaisesRegex(RuntimeError, 'Custom session directory'):
            r.session(dict(self.a, argv=['pi', '--session-dir', '/custom']), self.tmp.name)

    def test_opaque_invocation_refused_before_quit(self):
        a = dict(self.a, argv=['zsh'], session_path=str(self.path))
        with patch.object(r, 'agent', return_value=a), patch.object(r, 'session', return_value=str(self.path)), patch.object(r, 'cli') as cli:
            with self.assertRaisesRegex(RuntimeError, '--default-launch'):
                r.restart(a)
        cli.assert_not_called()

    def test_no_relaunch_before_confirmed_exit(self):
        with patch.object(r, 'agent', return_value=self.a), patch.object(r.shutil, 'which', return_value='/bin/pi'), patch.object(r, 'cli') as cli, patch.object(r, 'wait_for', side_effect=RuntimeError('still live')):
            with self.assertRaisesRegex(RuntimeError, 'still live'):
                r.restart(self.a)
        cli.assert_called_once_with('send', 't7', '/quit')

    def test_mac_path_is_explicit_and_quoted(self):
        with patch.object(r.shutil, 'which', return_value='/home/test/.nvm/node bin/pi'):
            command = r.pi_command([], '/session with spaces.jsonl')
        self.assertIn("PATH='/home/test/.nvm/node bin':$PATH exec", command)
        self.assertIn("--session '/session with spaces.jsonl'", command)

    def test_restart_preserves_name_cwd_labels_and_exact_session(self):
        finished = dict(self.a, state='finished')
        replacement = dict(self.a, address='t8')
        with patch.object(r, 'agent', side_effect=[self.a, self.a, finished, replacement]), patch.object(r.shutil, 'which', return_value='/node/bin/pi'), patch.object(r, 'cli', return_value={'address': 't8'}) as cli:
            result = r.restart(self.a)
        self.assertEqual(result['replacement'], 't8')
        self.assertEqual(cli.call_args_list[0].args, ('send', 't7', '/quit'))
        launch = cli.call_args_list[1].args
        self.assertEqual(launch[:3], ('run', '--bg', '--no-parent'))
        self.assertIn('review', launch)
        self.assertIn('/project', launch)
        self.assertIn('herdr.space=review', launch)
        self.assertIn('ovis.workspace=Review', launch)
        self.assertIn('dotfiles.worker=review', launch)
        self.assertFalse(any('private=' in x for x in launch))
        self.assertIn('--session ' + str(self.path), launch[-1])

    def test_unnamed_restart_stays_unnamed(self):
        a = dict(self.a, name=None)
        with patch.object(r, 'agent', side_effect=[a, a, dict(a, state='finished'), dict(a, address='t8')]), patch.object(r.shutil, 'which', return_value='/bin/pi'), patch.object(r, 'cli', return_value={'address': 't8'}) as cli:
            r.restart(a)
        self.assertNotIn('--name', cli.call_args_list[-1].args)

    def test_interrupt_waits_before_quit(self):
        working = dict(self.a, status={'app': 'pi', 'state': 'working'})
        with patch.object(r, 'agent', return_value=working), patch.object(r.shutil, 'which', return_value='/bin/pi'), patch.object(r, 'cli') as cli, patch.object(r, 'wait_for', side_effect=RuntimeError('stop before quit')):
            with self.assertRaisesRegex(RuntimeError, 'stop before quit'):
                r.restart(working, interrupt=True)
        cli.assert_called_once_with('interrupt', 't7')

    def test_caller_helper_is_not_a_child_terminal(self):
        with patch.object(r.shutil, 'which', return_value='/bin/pi'), patch.object(r.tempfile, 'mkdtemp', return_value=self.tmp.name), patch.object(r, 'cli', return_value={'address': 't9'}) as cli:
            result = r.schedule_current(self.a)
        self.assertEqual(result['helper'], 't9')
        self.assertEqual(cli.call_args.args[:3], ('run', '--bg', '--no-parent'))
        self.assertIn('--current-worker', cli.call_args.args[-1])

    def test_ls_filters_non_pi_finished_and_uses_hc_json(self):
        with patch.object(r, 'cli', return_value={'terminals': [dict(self.a, agent='pi'), dict(self.a, agent='zsh'), dict(self.a, agent='pi', state='finished')]}):
            self.assertEqual(len(r.agents()), 1)


if __name__ == '__main__':
    unittest.main()

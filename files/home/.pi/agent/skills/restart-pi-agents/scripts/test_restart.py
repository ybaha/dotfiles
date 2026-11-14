import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('restart', Path(__file__).with_name('restart.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

A = '01a1d6d5-010b-757c-86ff-fc855aa491ed'
B = '01b2d6d5-010b-757c-86ff-fc855aa491ed'


class RestartTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.directory = self.home / '.pi/agent/sessions/--project--'
        self.directory.mkdir(parents=True)
        self.path_a = self.directory / ('2026_' + A + '.jsonl')
        self.path_b = self.directory / ('2026_' + B + '.jsonl')
        self.path_a.touch()
        self.path_b.touch()
        self.a = {'address': 't7', 'agent': 'pi', 'state': 'live', 'status': {'app': 'pi', 'state': 'idle'},
                  'cwd': '/project', 'name': 'review', 'pid': 10, 'created_ms': 1,
                  'argv': ['pi', '--no-mcp', '--session', A],
                  'labels': {'herdr.space': 'review', 'herdr.tab': 'review:t1', 'ovis.workspace': 'Review',
                             'dotfiles.worker': 'review', 'private': 'ignored'}}
        self.footer = 'To resume this session: pi --session ' + B + '\n'
        self.stopped = False
        self.replacement = None
        self.home_patch = patch.object(r.Path, 'home', return_value=self.home)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)
        self.pi_patch = patch.object(r.shutil, 'which', return_value='/node bin/pi')
        self.pi_patch.start()
        self.addCleanup(self.pi_patch.stop)

    def fake_hc(self, *args, **kwargs):
        if args[0] == 'get':
            if args[1] == 't8':
                return copy.deepcopy(self.replacement)
            return dict(copy.deepcopy(self.a), state='finished' if self.stopped else 'live')
        if args[0] == 'interrupt':
            self.a['status']['state'] = 'idle'
            return {}
        if args[0] == 'send':
            self.assertEqual(args, ('send', 't7', '/quit'))
            self.stopped = True
            return {}
        if args[0] == 'read':
            self.assertTrue(self.stopped, 'must read only after exit')
            self.assertEqual(args, ('read', '--lines', '40', 't7'))
            return self.footer
        if args[0] == 'run':
            self.assertTrue(self.stopped)
            self.replacement = dict(copy.deepcopy(self.a), address='t8', pid=11,
                                    argv=['sh', '-c', args[-1]], state='live')
            return {'address': 't8'}
        self.fail(f'unexpected fake hc call: {args}')

    def perform_restart(self, info=None):
        with patch.object(r, 'cli', side_effect=self.fake_hc) as cli:
            result = r.restart(copy.deepcopy(info or self.a))
        return result, cli.call_args_list

    def assert_no_input(self, cli):
        self.assertFalse(any(call.args[0] in ('send', 'interrupt', 'run') for call in cli.call_args_list))

    def test_new_session_exit_id_overrides_launch_argv_and_newest_file(self):
        self.path_a.touch()  # Even the newest launch-A file is not the active B.
        result, calls = self.perform_restart()
        self.assertEqual(result['session'], B)
        self.assertEqual(result['session_file'], str(self.path_b))
        launch = next(call.args for call in calls if call.args[0] == 'run')
        self.assertEqual(r.pi_args({'argv': ['sh', '-c', launch[-1]]}), ['--no-mcp', '--session', B])
        self.assertLess(next(i for i, c in enumerate(calls) if c.args[0] == 'read'),
                        next(i for i, c in enumerate(calls) if c.args[0] == 'run'))

    def test_last_exit_match_wins_after_fork_or_resume(self):
        self.footer = f'To resume this session: pi --session {A}\nother output\n' + self.footer
        result, _ = self.perform_restart()
        self.assertEqual(result['session'], B)

    def test_exit_absolute_path_is_preserved_exactly(self):
        self.footer = 'To resume this session: pi --session ' + str(self.path_b) + '\n'
        result, calls = self.perform_restart()
        self.assertEqual(result['session'], str(self.path_b))
        launch = next(call.args for call in calls if call.args[0] == 'run')
        self.assertEqual(r.pi_args({'argv': ['sh', '-c', launch[-1]]})[-1], str(self.path_b))

    def test_relative_exit_path_uses_terminal_cwd(self):
        info = dict(self.a, cwd=str(self.home))
        path = self.home / 'relative.jsonl'
        path.touch()
        self.assertEqual(r.exit_session(info, 'To resume this session: pi --session relative.jsonl'),
                         ('relative.jsonl', str(path)))

    def test_id_must_resolve_in_session_directory_not_arbitrary_cwd_file(self):
        (self.home / B).touch()
        with self.assertRaisesRegex(RuntimeError, 'already stopped.*does not resolve'):
            r.exit_session(dict(self.a, cwd=str(self.home)), self.footer)

    def test_missing_exit_path_never_falls_back(self):
        self.footer = 'To resume this session: pi --session /missing/session.jsonl\n'
        with patch.object(r, 'cli', side_effect=self.fake_hc) as cli:
            with self.assertRaisesRegex(RuntimeError, 'already stopped.*does not exist'):
                r.restart(self.a)
        self.assertFalse(any(call.args[0] == 'run' for call in cli.call_args_list))

    def test_missing_exit_line_stops_without_guessing_or_relaunching(self):
        self.footer = 'Pi exited without a resume message\n'
        with patch.object(r, 'cli', side_effect=self.fake_hc) as cli:
            with self.assertRaisesRegex(RuntimeError, 'Pi is already stopped') as error:
                r.restart(self.a)
        self.assertTrue(self.stopped)
        self.assertFalse(any(call.args[0] == 'run' for call in cli.call_args_list))
        for expected in ('t7', '/project', str(self.path_a), str(self.path_b), 'Resume manually'):
            self.assertIn(expected, str(error.exception))

    def test_unresolved_or_ambiguous_exit_id_never_falls_back(self):
        for token in ('missing', B):
            with self.subTest(token=token):
                if token == B:
                    (self.directory / ('other_' + B + '.jsonl')).touch()
                self.stopped = False
                self.footer = f'To resume this session: pi --session {A}\nTo resume this session: pi --session {token}\n'
                with patch.object(r, 'cli', side_effect=self.fake_hc) as cli:
                    with self.assertRaisesRegex(RuntimeError, 'already stopped.*no relaunch'):
                        r.restart(self.a)
                self.assertFalse(any(call.args[0] == 'run' for call in cli.call_args_list))

    def test_exit_read_failure_reports_stopped_terminal_and_candidates(self):
        def failed_read(*args, **kwargs):
            if args[0] == 'read':
                raise RuntimeError('failed read')
            return self.fake_hc(*args, **kwargs)
        with patch.object(r, 'cli', side_effect=failed_read) as cli:
            with self.assertRaisesRegex(RuntimeError, 't7.*cwd /project.*already stopped.*Candidate files'):
                r.restart(self.a)
        self.assertFalse(any(call.args[0] == 'run' for call in cli.call_args_list))

    def test_launch_session_need_not_still_exist(self):
        self.path_a.unlink()
        result, _ = self.perform_restart()
        self.assertEqual(result['session'], B)

    def test_shell_hosted_unknown_and_non_exec_launchers_receive_no_input(self):
        launchers = [[], ['zsh'], ['/bin/bash', '-l'], ['node', '/pkg/pi'],
                     ['sh', '-c', 'pi'], ['sh', '-c', 'pi; exec sh'],
                     ['sh', '-c', 'exec pi; exec sh'], ['sh', '-c', 'exec pi && exec pi'],
                     ['sh', '-c', 'exec pi\nexec pi'], ['sh', '-c', 'exec "$PI_BIN/pi"'],
                     ['sh', '-c', 'exec $(command -v pi)']]
        for argv in launchers:
            with self.subTest(argv=argv), patch.object(r, 'cli') as cli:
                with self.assertRaisesRegex(RuntimeError, 'shell-hosted or unknown launcher; restart manually'):
                    r.restart(dict(self.a, argv=argv), interrupt=True)
                self.assert_no_input(cli)

    def test_pi_argv_requires_pi_agent_before_quit(self):
        for agent in ('zsh', 'claude', None):
            with self.subTest(agent=agent), patch.object(r, 'cli') as cli:
                with self.assertRaisesRegex(RuntimeError, 'restart manually'):
                    r.restart(dict(self.a, agent=agent))
                self.assert_no_input(cli)

    def test_get_status_app_supported_when_agent_field_absent(self):
        del self.a['agent']
        result, _ = self.perform_restart()
        self.assertEqual(result['session'], B)

    def test_verified_exec_wrapper_restarts(self):
        self.a['argv'] = ['sh', '-c', "PATH='/node bin':$PATH exec '/node bin/pi' --no-mcp --session " + A]
        result, _ = self.perform_restart()
        self.assertEqual(result['session'], B)

    def test_working_blocked_error_unknown_never_quit_without_authority(self):
        for state in ('working', 'blocked', 'error', None):
            self.a['status']['state'] = state
            with patch.object(r, 'cli', side_effect=self.fake_hc) as cli:
                with self.assertRaises(RuntimeError):
                    r.restart(self.a, interrupt=state == 'blocked')
            self.assert_no_input(cli)

    def test_launcher_change_before_quit_is_refused(self):
        live = dict(self.a, argv=['zsh'])
        with patch.object(r, 'agent', return_value=live), patch.object(r, 'cli') as cli:
            with self.assertRaisesRegex(RuntimeError, 'restart manually'):
                r.restart(self.a)
        self.assert_no_input(cli)

    def test_no_relaunch_before_confirmed_exit(self):
        with patch.object(r, 'cli', side_effect=self.fake_hc) as cli, patch.object(r, 'wait_for', side_effect=RuntimeError('still live')):
            with self.assertRaisesRegex(RuntimeError, 'still live'):
                r.restart(self.a)
        self.assertFalse(any(call.args[0] in ('read', 'run') for call in cli.call_args_list))

    def test_restart_preserves_name_cwd_labels_restrictions_and_mac_path(self):
        _, calls = self.perform_restart()
        launch = next(call.args for call in calls if call.args[0] == 'run')
        self.assertEqual(launch[:3], ('run', '--bg', '--no-parent'))
        for expected in ('review', '/project', 'herdr.space=review', 'ovis.workspace=Review', 'dotfiles.worker=review'):
            self.assertIn(expected, launch)
        self.assertFalse(any('private=' in arg for arg in launch))
        self.assertIn("PATH='/node bin':$PATH exec '/node bin/pi' --no-mcp --session " + B, launch[-1])

    def test_unnamed_restart_stays_unnamed(self):
        self.a['name'] = None
        _, calls = self.perform_restart()
        launch = next(call.args for call in calls if call.args[0] == 'run')
        self.assertNotIn('--name', launch)

    def test_interrupt_waits_before_quit(self):
        self.a['status']['state'] = 'working'
        with patch.object(r, 'cli', side_effect=self.fake_hc) as cli, patch.object(r, 'wait_for', side_effect=RuntimeError('stop before quit')):
            with self.assertRaisesRegex(RuntimeError, 'stop before quit'):
                r.restart(copy.deepcopy(self.a), interrupt=True)
        self.assertTrue(any(call.args == ('interrupt', 't7') for call in cli.call_args_list))
        self.assertFalse(any(call.args[0] == 'send' for call in cli.call_args_list))

    def test_unknown_options_refused_without_exposing_argument_values(self):
        with patch.object(r, 'cli') as cli:
            with self.assertRaisesRegex(RuntimeError, 'Unsupported') as error:
                r.restart(dict(self.a, argv=['pi', '--unknown', 'secret']))
        self.assertNotIn('secret', str(error.exception))
        self.assert_no_input(cli)

    def test_caller_helper_validates_launcher_and_keeps_caller_path(self):
        with patch.object(r.tempfile, 'mkdtemp', return_value=self.tmp.name), patch.object(r, 'cli', return_value={'address': 't9'}) as cli:
            result = r.schedule_current(self.a)
        self.assertEqual(result['helper'], 't9')
        self.assertEqual(cli.call_args.args[:3], ('run', '--bg', '--no-parent'))
        self.assertIn('PATH=', cli.call_args.args[-1])
        self.assertIn('--current-worker', cli.call_args.args[-1])
        manifest = json.loads((self.home / 'current.json').read_text())
        self.assertNotIn('session_path', manifest['agent'])
        with patch.object(r, 'cli') as cli, self.assertRaisesRegex(RuntimeError, 'restart manually'):
            r.schedule_current(dict(self.a, argv=['bash']))
        self.assert_no_input(cli)

    def test_caller_uses_exit_session_not_saved_launch_session(self):
        manifest = self.home / 'current.json'
        manifest.write_text(json.dumps({'agent': self.a}))
        with patch.object(r, 'cli', side_effect=self.fake_hc):
            result = r.current_worker(str(manifest))
        self.assertEqual(result['session'], B)

    def test_apply_skips_shell_and_returns_nonzero(self):
        shell = dict(self.a, argv=['zsh'])
        out = io.StringIO()
        with patch.object(r.sys, 'argv', ['restart.py', '--apply']), patch.dict(r.os.environ, {'HC_TERMINAL_ID': 't1'}), patch.object(r, 'snapshot', return_value=[shell]), patch.object(r, 'cli') as cli, contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit) as error:
                r.main()
        self.assertEqual(error.exception.code, 1)
        self.assertIn('shell-hosted or unknown launcher; restart manually', out.getvalue())
        self.assert_no_input(cli)

    def test_default_launch_override_is_removed(self):
        with patch.object(r.sys, 'argv', ['restart.py', '--apply', '--default-launch']), patch.object(r, 'cli') as cli, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                r.main()
        self.assertEqual(error.exception.code, 2)
        cli.assert_not_called()

    def test_cli_read_is_plain_text_not_json(self):
        response = subprocess.CompletedProcess(['hc'], 0, self.footer, '')
        with patch.object(r.subprocess, 'run', return_value=response):
            self.assertEqual(r.cli('read', '--lines', '40', 't7'), self.footer)

    def test_ls_filters_non_pi_finished(self):
        with patch.object(r, 'cli', return_value={'terminals': [dict(self.a), dict(self.a, agent='zsh'), dict(self.a, state='finished')]}):
            self.assertEqual(len(r.agents()), 1)


if __name__ == '__main__':
    unittest.main()

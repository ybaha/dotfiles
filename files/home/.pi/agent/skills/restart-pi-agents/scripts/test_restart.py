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
        self.a = {'pane_id':'w1:p1', 'agent_status':'idle', 'cwd':'/project',
                  'agent_session':{'kind':'path', 'value':str(self.path)}}

    def test_missing_session_never_calls_herdr(self):
        self.path.unlink()
        with patch.object(r, 'cli') as cli, self.assertRaises(RuntimeError):
            r.restart(self.a)
        cli.assert_not_called()

    def test_working_requires_explicit_interrupt(self):
        self.a['agent_status'] = 'working'
        with patch.object(r, 'agent', return_value=self.a), patch.object(r, 'cli') as cli:
            with self.assertRaisesRegex(RuntimeError, '--interrupt'):
                r.restart(self.a)
        cli.assert_not_called()

    def test_blocked_is_never_dismissed(self):
        self.a['agent_status'] = 'blocked'
        with patch.object(r, 'agent', return_value=self.a), patch.object(r, 'cli') as cli:
            with self.assertRaisesRegex(RuntimeError, 'blocked'):
                r.restart(self.a, interrupt=True)
        cli.assert_not_called()

    def test_changed_session_is_not_quit(self):
        other_path = Path(self.tmp.name) / 'other.jsonl'
        other_path.touch()
        other = dict(self.a, agent_session={'kind':'path', 'value':str(other_path)})
        with patch.object(r, 'agent', return_value=other), patch.object(r, 'cli') as cli:
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                r.restart(self.a)
        cli.assert_not_called()

    def test_opaque_launch_requires_consent_before_quit(self):
        with patch.object(r, 'agent', return_value=self.a), patch.object(r, 'process', return_value={}), patch.object(r, 'cli') as cli:
            with self.assertRaisesRegex(RuntimeError, '--default-launch'):
                r.restart(self.a)
        cli.assert_not_called()

    def test_launch_restrictions_are_preserved(self):
        info = {'foreground_process_group_id':100, 'foreground_processes':[{'pid':100, 'argv':['pi', '--no-mcp', '--no-extensions', '--tools', 'read', '--session', 'old']} ]}
        self.assertEqual(r.launch_options(info), ['--no-mcp', '--no-extensions', '--tools', 'read'])

    def test_unknown_launch_options_are_refused_even_with_default_consent(self):
        info = {'foreground_process_group_id':100, 'foreground_processes':[{'pid':100, 'argv':['pi', '--unknown', 'secret']} ]}
        with self.assertRaisesRegex(RuntimeError, 'Unsupported') as error:
            r.launch_options(info, default_launch=True)
        self.assertNotIn('secret', str(error.exception))

    def test_shell_ready_handles_transient_missing_group(self):
        with patch.object(r, 'process', return_value={'shell_pid':10}):
            self.assertFalse(r.shell_ready('w1:p1'))
        with patch.object(r, 'process', return_value={'shell_pid':10, 'foreground_process_group_id':10}):
            self.assertTrue(r.shell_ready('w1:p1'))

    def test_authorized_interrupt_waits_before_quit(self):
        working = dict(self.a, agent_status='working')
        with patch.object(r, 'agent', side_effect=[working, self.a]), patch.object(r, 'cli') as cli, patch.object(r, 'process', return_value={}), patch.object(r, 'launch_options', return_value=[]), patch.object(r, 'wait_for', side_effect=RuntimeError('stopped before quit')):
            with self.assertRaisesRegex(RuntimeError, 'stopped before quit'):
                r.restart(working, interrupt=True)
        cli.assert_called_once_with('agent', 'send-keys', 'w1:p1', 'esc')

    def perform_restart(self, a):
        states = [
            {'foreground_process_group_id':100},
            {'foreground_process_group_id':10, 'shell_pid':10},
            {'foreground_process_group_id':10, 'shell_pid':10, 'foreground_processes':[{'cwd':'/project'}]},
            {'foreground_process_group_id':200},
        ]
        with patch.object(r, 'agent', return_value=a), patch.object(r, 'process', side_effect=states), patch.object(r, 'cli') as cli:
            result = r.restart(a, default_launch=True)
        self.assertEqual(result['new_pid'], 200)
        self.assertIn(unittest.mock.call('agent', 'prompt', 'w1:p1', '/quit'), cli.call_args_list)
        start = next(c for c in cli.call_args_list if c.args[:2] == ('agent', 'start'))
        self.assertEqual(start.args[-3:], ('--', '--session', str(self.path)))
        return cli

    def test_unnamed_agent_remains_unnamed(self):
        cli = self.perform_restart(self.a)
        self.assertIn(unittest.mock.call('agent', 'rename', 'w1:p1', '--clear'), cli.call_args_list)

    def test_named_agent_keeps_name(self):
        cli = self.perform_restart(dict(self.a, name='reviewer'))
        start = next(c for c in cli.call_args_list if c.args[:2] == ('agent', 'start'))
        self.assertEqual(start.args[2], 'reviewer')
        self.assertFalse(any(c.args[:2] == ('agent', 'rename') for c in cli.call_args_list))

    def test_wrong_shell_cwd_does_not_start(self):
        states = [{'foreground_process_group_id':100},
                  {'foreground_process_group_id':10, 'shell_pid':10},
                  {'foreground_processes':[{'cwd':'/elsewhere'}]}]
        with patch.object(r, 'agent', return_value=self.a), patch.object(r, 'process', side_effect=states), patch.object(r, 'cli') as cli:
            with self.assertRaisesRegex(RuntimeError, 'cwd differs'):
                r.restart(self.a, default_launch=True)
        self.assertFalse(any(c.args[:2] == ('agent', 'start') for c in cli.call_args_list))


if __name__ == '__main__':
    unittest.main()

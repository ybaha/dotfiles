import copy
import http.client
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader('preview', str(ROOT / 'previewctl'))
spec = importlib.util.spec_from_loader(loader.name, loader)
p = importlib.util.module_from_spec(spec)
loader.exec_module(p)


class FakeTailscale:
    target = staticmethod(p.Tailscale.target)

    def __init__(self):
        self.config = {'TCP': {'80': {'HTTP': True}}, 'Web': {'dev.ts.net:80': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:3200'}}}}}
        self.calls, self.offline, self.fail_remove = [], False, False

    def dns(self):
        if self.offline:
            raise RuntimeError('offline')
        return 'dev.ts.net'

    def status(self):
        if self.offline:
            raise RuntimeError('offline')
        return copy.deepcopy(self.config)

    def add(self, port, target):
        self.calls.append(('add', port, target))
        self.config['TCP'][str(port)] = {'HTTPS': True}
        self.config['Web'][f'dev.ts.net:{port}'] = {'Handlers': {'/': {'Proxy': target}}}

    def remove(self, port):
        self.calls.append(('remove', port))
        if self.fail_remove:
            raise RuntimeError('temporary failure')
        self.config['TCP'].pop(str(port), None)
        self.config['Web'].pop(f'dev.ts.net:{port}', None)


class App(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *args):
        pass


class HubTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.ts = FakeTailscale()
        self.hub = p.Hub(self.base / 'state', self.ts)
        self.app = ThreadingHTTPServer(('127.0.0.1', 0), App)
        self.app_thread = threading.Thread(target=self.app.serve_forever, daemon=True)
        self.app_thread.start()
        self.addCleanup(self.close_app)
        for name in ('a', 'b'):
            (self.base / name).mkdir()

    def close_app(self):
        self.app.shutdown()
        self.app.server_close()
        self.app_thread.join(2)

    def attach(self, name='a', **kw):
        return self.hub.dispatch({'op': 'attach', 'cwd': str(self.base / name), 'port': self.app.server_port, **kw})

    def test_order_refresh_and_poll_invariance(self):
        self.attach('a')
        self.attach('b')
        first = self.hub.entries()
        self.assertEqual(Path(first[0]['cwd']).name, 'b')
        self.hub.tick()
        self.assertEqual(self.hub.entries(), first)
        self.hub.dispatch({'op': 'up', 'cwd': str(self.base / 'a')})
        self.assertEqual(Path(self.hub.entries()[0]['cwd']).name, 'a')
        self.assertEqual(len(self.hub.entries()), 2)

    def test_attach_is_idempotent_and_never_kills_external_process(self):
        result = self.attach()
        count = len(self.ts.calls)
        self.assertEqual(self.attach()['url'], result['url'])
        self.assertEqual(len(self.ts.calls), count)
        self.assertNotIn('pid', self.hub.entries()[0])
        with patch.object(p.os, 'killpg') as kill:
            self.hub.dispatch({'op': 'stop', 'cwd': str(self.base / 'a')})
            kill.assert_not_called()
        self.assertTrue(p.http_ok(self.app.server_port))
        self.assertFalse(self.hub.entries())

    def test_publish_change_port_replaces_route_without_leak(self):
        self.attach()
        other = ThreadingHTTPServer(('127.0.0.1', 0), App)
        th = threading.Thread(target=other.serve_forever, daemon=True)
        th.start()
        try:
            self.hub.dispatch({'op': 'attach', 'cwd': str(self.base / 'a'), 'port': other.server_port})
            self.assertEqual(len(self.hub.entries()), 1)
            self.assertEqual(len(self.hub.data['routes']), 2)  # hub and current preview
        finally:
            other.shutdown()
            other.server_close()
            th.join(2)

    def test_expired_and_unhealthy_are_removed(self):
        self.attach()
        entry = self.hub.entries()[0]
        entry['expires_at'] = time.time() - 1
        self.hub.put(entry)
        self.hub.tick()
        self.assertFalse(self.hub.entries())
        self.attach()
        entry = self.hub.entries()[0]
        entry['unhealthy_since'] = time.time() - 61
        self.hub.put(entry)
        with patch.object(p, 'http_ok', return_value=False):
            self.hub.tick()
        self.assertFalse(self.hub.entries())

    def test_failed_cleanup_is_persistent_and_retried(self):
        self.attach()
        ext = self.hub.entries()[0]['external']
        self.ts.fail_remove = True
        self.hub.dispatch({'op': 'stop', 'cwd': str(self.base / 'a')})
        self.assertTrue(self.hub.data['routes'][str(ext)]['pending'])
        again = p.Hub(self.hub.base, self.ts)
        self.assertTrue(again.data['routes'][str(ext)]['pending'])
        self.ts.fail_remove = False
        again.tick()
        self.assertNotIn(str(ext), again.data['routes'])

    def test_foreign_route_never_claimed_even_if_target_matches(self):
        target = 'http://127.0.0.1:8766'
        self.ts.add(443, target)
        before = copy.deepcopy(self.ts.config)
        with self.assertRaisesRegex(RuntimeError, 'another service'):
            self.hub.ensure_route(443, target)
        self.assertEqual(self.ts.config, before)

    def test_dashboard_port_fallback_is_persistent_and_preserves_443(self):
        self.ts.add(443, 'http://127.0.0.1:3200')
        existing = copy.deepcopy(self.ts.config['Web']['dev.ts.net:443'])
        self.attach()
        self.assertEqual(self.hub.hub_url(), 'https://dev.ts.net:8443/')
        self.assertEqual(self.hub.entries()[0]['external'], 8444)
        again = p.Hub(self.hub.base, self.ts)
        again.tick()
        self.assertEqual(again.hub_url(), 'https://dev.ts.net:8443/')
        self.assertEqual(self.ts.config['Web']['dev.ts.net:443'], existing)
        self.assertIn('8443', self.ts.config['TCP'])

    def test_extra_handler_or_funnel_is_foreign(self):
        self.attach()
        ext = self.hub.entries()[0]['external']
        self.ts.config['Web'][f'dev.ts.net:{ext}']['Handlers']['/other'] = {'Text': 'foreign'}
        before = copy.deepcopy(self.ts.config)
        self.hub.dispatch({'op': 'stop', 'cwd': str(self.base / 'a')})
        self.assertEqual(self.ts.config, before)
        self.ts.config['AllowFunnel'] = {'dev.ts.net:443': True}
        self.assertIs(self.ts.target(self.ts.config, 443), False)

    def test_boot_retries_offline_and_restores_missing_routes(self):
        self.ts.offline = True
        self.hub.tick()
        self.assertEqual(self.hub.error, 'offline')
        self.ts.offline = False
        self.hub.tick()
        self.assertEqual(self.hub.error, '')
        self.attach()
        self.ts.config = {'TCP': {}, 'Web': {}}
        self.hub.tick()
        self.assertEqual(len(self.ts.config['TCP']), 2)

    def test_persisted_state_and_public_metadata(self):
        self.attach(title='<script>alert(1)</script>')
        again = p.Hub(self.hub.base, self.ts)
        again.tick()
        snap = again.snapshot()
        self.assertEqual(len(snap['previews']), 1)
        self.assertNotIn(str(self.base), json.dumps(snap))
        self.assertTrue(snap['previews'][0]['url'].startswith('https://'))
        self.assertEqual((self.hub.base / 'state.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.ts.config['TCP']['80'], {'HTTP': True})

    def test_managed_start_and_stop(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        (self.base / 'a' / 'index.html').write_text('safe fixture')
        try:
            self.hub.dispatch({'op': 'up', 'cwd': str(self.base / 'a'), 'port': port,
                              'argv': [sys.executable, '-m', 'http.server', '{port}', '--bind', '127.0.0.1']})
            entry = self.hub.entries()[0]
            child = self.hub.children[entry['pid']]
            self.assertTrue(p.http_ok(port))
            self.hub.dispatch({'op': 'stop', 'cwd': str(self.base / 'a')})
            self.assertIsNotNone(child.poll())
            self.assertFalse(self.hub.entries())
        finally:
            for entry in self.hub.entries():
                self.hub.stop(entry)

    def test_busy_port_not_hijacked(self):
        with self.assertRaisesRegex(RuntimeError, 'in use'):
            self.hub.dispatch({'op': 'up', 'cwd': str(self.base / 'a'), 'port': self.app.server_port,
                              'argv': [sys.executable, '-m', 'http.server', '{port}']})
        self.assertFalse(self.hub.entries())

    def test_pid_reuse_never_signals(self):
        with patch.object(p, 'process_identity', return_value='new'), patch.object(p.os, 'killpg') as kill:
            p.stop_process({'pid': 123, 'identity': 'old'})
            kill.assert_not_called()

    def test_socket_http_and_shutdown_are_bounded(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.hub.port = sock.getsockname()[1]
        thread = threading.Thread(target=p.serve, args=(self.hub,), daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 3
            while not (self.hub.base / 'control.sock').exists():
                if not thread.is_alive() or time.monotonic() > deadline:
                    self.fail('daemon failed to start')
                time.sleep(.02)
            self.assertEqual((self.hub.base / 'control.sock').stat().st_mode & 0o777, 0o600)
            response = p.control({'op': 'attach', 'cwd': str(self.base / 'a'), 'port': self.app.server_port}, self.hub.base)
            self.assertTrue(response['ok'])
            with self.assertRaisesRegex(ValueError, 'too large'):
                p.control({'op': 'x', 'padding': 'a' * 70000}, self.hub.base)
            conn = http.client.HTTPConnection('127.0.0.1', self.hub.port, timeout=2)
            conn.request('GET', '/api/previews', headers={'Host': 'evil.example'})
            self.assertEqual(conn.getresponse().status, 403)
            conn.close()
            conn = http.client.HTTPConnection('127.0.0.1', self.hub.port, timeout=2)
            conn.request('GET', '/api/previews')
            body = json.loads(conn.getresponse().read())
            conn.close()
            self.assertEqual(len(body['previews']), 1)
        finally:
            self.hub.running = False
            thread.join(3)
        self.assertFalse(thread.is_alive(), 'server shutdown hung')


class PortableTests(unittest.TestCase):
    def test_single_daemon_lock_is_nonblocking(self):
        with tempfile.TemporaryDirectory() as tmp:
            with p.daemon_lock(Path(tmp)):
                with self.assertRaisesRegex(RuntimeError, 'already running'):
                    with p.daemon_lock(Path(tmp)):
                        pass

    def test_services_and_readonly_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, HOME=tmp, PREVIEW_HUB_STATE_DIR=tmp + '/state'):
            for platform in ('darwin', 'linux'):
                with patch.object(p.sys, 'platform', platform):
                    path, content, start, stop = p.service_plan()
                    self.assertIn(p.MARKER, content)
                    if platform == 'darwin':
                        self.assertIn('<key>KeepAlive</key><true/>', content)
                    else:
                        self.assertIn('Restart=on-failure', content)
                        self.assertIn('systemctl', start[0])
                    with patch.object(p.subprocess, 'run') as command:
                        self.assertIn('dry-run', p.service('install', True))
                        command.assert_not_called()
                    self.assertFalse(path.exists())
            self.assertFalse(Path(tmp + '/state').exists())

    def test_ttl_host_and_dashboard_safety(self):
        self.assertEqual(p.ttl_seconds('2h'), 7200)
        for invalid in ('0h', '-1h', 'blah'):
            with self.assertRaises(ValueError):
                p.ttl_seconds(invalid)
        self.assertTrue(p.allowed_host('dev.ts.net:443', 'dev.ts.net'))
        self.assertFalse(p.allowed_host('evil.example', 'dev.ts.net'))
        page = (ROOT / 'dashboard.html').read_text()
        self.assertIn('textContent', page)
        self.assertNotIn('innerHTML', page)
        self.assertNotIn('https://cdn', page)

    def test_cli_absent_daemon_is_short_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, PREVIEW_HUB_STATE_DIR=tmp)
            result = subprocess.run([sys.executable, str(ROOT / 'previewctl'), 'status', '--json'],
                                    env=env, text=True, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(result.stdout)['ok'])
            self.assertEqual(len(result.stdout.splitlines()), 1)
            self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()

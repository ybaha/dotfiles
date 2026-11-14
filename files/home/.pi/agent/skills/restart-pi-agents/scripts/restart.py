#!/usr/bin/env python3
"""Restart replaceable local hc Pi terminals using Pi's authoritative exit message."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


MANUAL_LAUNCHER = 'shell-hosted or unknown launcher; restart manually'


def cli(*args, timeout=75):
    result = subprocess.run(['hc', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'hc {" ".join(args[:2])}: {result.stderr or result.stdout}')
    return result.stdout if args[0] == 'read' else json.loads(result.stdout)


def status(info):
    value = info.get('status')
    return value.get('state') if isinstance(value, dict) else value


def agents():
    return [a for a in cli('ls')['terminals'] if a.get('agent') == 'pi' and a['state'] == 'live']


def agent(address):
    return cli('get', address)


def pi_args(info):
    argv = info.get('argv') or []
    if not argv:
        raise RuntimeError(MANUAL_LAUNCHER)
    if Path(argv[0]).name in ('sh', 'bash', 'zsh'):
        # Only a simple exec replaces the top-level shell. A shell merely hosting
        # Pi would survive /quit, so never send input to that launcher.
        if len(argv) != 3 or argv[1] not in ('-c', '-lc') or any(c in argv[2] for c in ('\n', '`', '$(')):
            raise RuntimeError(MANUAL_LAUNCHER)
        lexer = shlex.shlex(argv[2], posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ''
        try:
            argv = list(lexer)
        except ValueError:
            raise RuntimeError(MANUAL_LAUNCHER) from None
        if any(token and all(c in '();<>|&' for c in token) for token in argv):
            raise RuntimeError(MANUAL_LAUNCHER)
        while argv and re.match(r'^[A-Za-z_][A-Za-z_0-9]*=', argv[0]):
            argv = argv[1:]
        if not argv or argv[0] != 'exec':
            raise RuntimeError(MANUAL_LAUNCHER)
        argv = argv[1:]
        if any('$' in token for token in argv):
            raise RuntimeError(MANUAL_LAUNCHER)
    if not argv or Path(argv[0]).name != 'pi':
        raise RuntimeError(MANUAL_LAUNCHER)
    return argv[1:]


def launch_options(info):
    args = pi_args(info)
    toggles = {'--no-mcp', '--no-extensions', '-ne', '--no-skills', '-ns', '--no-prompt-templates', '-np',
               '--no-themes', '--no-context-files', '-nc', '--no-tools', '-nt', '--no-builtin-tools', '-nbt',
               '--no-approve', '-na', '--offline', '--verbose'}
    values = {'--tools', '-t', '--exclude-tools', '-xt', '--provider', '--model', '--models', '--thinking',
              '--tui-mode', '--session-dir'}
    kept = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in toggles:
            kept.append(arg)
        elif arg in values or arg in ('--session', '--session-id'):
            if i + 1 >= len(args):
                raise RuntimeError('Incomplete original Pi invocation; restart manually')
            if arg in values:
                kept.extend(args[i:i + 2])
            i += 1
        elif arg.startswith('--session='):
            pass
        elif arg not in ('--continue', '-c', '--resume', '-r'):
            raise RuntimeError('Unsupported original Pi launch options; restart manually')
        i += 1
    return kept


def preflight(info):
    reported = info.get('status')
    # hc get versions expose either agent or status.app; an explicit non-Pi
    # agent must never be overridden by a stale status report.
    app = reported.get('app') if isinstance(reported, dict) else None
    if info.get('agent', app) != 'pi':
        raise RuntimeError(MANUAL_LAUNCHER)
    options = launch_options(info)
    if info.get('state') != 'live' or not info.get('cwd') or not re.fullmatch(r't[0-9]+', info['address']):
        raise RuntimeError('Not a live local Pi terminal with a known cwd; restart manually')
    if info.get('name') and not re.fullmatch('[a-z0-9_-]{1,32}', info['name']):
        raise RuntimeError('Invalid hc terminal name; refusing to quit')
    return options


def same_launcher(before, after):
    return all(before.get(key) == after.get(key) for key in ('address', 'cwd', 'argv', 'pid', 'created_ms', 'name'))


def session_candidates(info):
    directory = Path.home() / '.pi/agent/sessions' / ('--' + info['cwd'].strip('/').replace('/', '-') + '--')
    return sorted(directory.glob('*.jsonl'))


def stopped_failure(info, reason):
    candidates = ', '.join(str(path) for path in session_candidates(info)) or '(none)'
    return RuntimeError(f'{info["address"]} (cwd {info["cwd"]}): Pi is already stopped; {reason}; '
                        f'no relaunch. Candidate files (not selected): {candidates}. Resume manually.')


def exit_session(info, output):
    # Strip presentation escapes, never inspect private JSONL session contents.
    output = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output)
    matches = re.findall(r'To resume this session: pi --session (\S+)', output)
    if not matches:
        raise stopped_failure(info, 'authoritative exit resume line is missing')
    token = matches[-1]
    if '/' in token or token.startswith('~') or token.endswith('.jsonl'):
        candidate = Path(token).expanduser()
        if not candidate.is_absolute():
            candidate = Path(info['cwd']) / candidate
        if not candidate.is_file():
            raise stopped_failure(info, f'exit session path {token!r} does not exist')
        return token, str(candidate.resolve())
    # An id is resolved only to verify existence, never to choose a different
    # session. Keep the exact exit token in the replacement invocation.
    candidates = [path for path in session_candidates(info) if path.stem == token or path.stem.endswith('_' + token)]
    if len(candidates) != 1:
        raise stopped_failure(info, f'exit session {token!r} does not resolve to one existing file')
    return token, str(candidates[0])


def wait_for(check, description, timeout=25):
    deadline = time.monotonic() + timeout
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise RuntimeError(f'Timed out: {description}')
        time.sleep(0.3)


def pi_executable():
    executable = shutil.which('pi')
    if not executable:
        raise RuntimeError('pi is not on the caller PATH; refusing to quit')
    return executable


def pi_command(options, token, executable):
    # The core may not inherit nvm/mise; resolve in the caller and prepend its bin.
    return f'PATH={shlex.quote(str(Path(executable).parent))}:$PATH exec {shlex.join([executable, *options, "--session", token])}'


def restart(info, interrupt=False):
    address = info['address']
    preflight(info)
    live = agent(address)
    options = preflight(live)
    if not same_launcher(info, live):
        raise RuntimeError(f'{address}: occupant/launcher changed; refusing restart')
    state = status(live)
    if state not in ('idle', 'done') and (state != 'working' or not interrupt):
        raise RuntimeError(f'{address}: {state}; not restarted (working requires --interrupt)')
    executable = pi_executable()
    labels = {k: v for k, v in (live.get('labels') or {}).items() if k in ('herdr.space', 'herdr.tab', 'dotfiles.worker') or k.startswith('ovis.')}
    name = live.get('name')
    if state == 'working':
        cli('interrupt', address)
        wait_for(lambda: status(agent(address)) in ('idle', 'done'), f'{address} to stop work')
    final = agent(address)
    preflight(final)
    if not same_launcher(live, final) or status(final) not in ('idle', 'done'):
        raise RuntimeError(f'{address}: changed before quit; refusing restart')
    cli('send', address, '/quit')
    wait_for(lambda: agent(address)['state'] == 'finished', f'{address} to exit Pi')
    try:
        output = cli('read', '--lines', '40', address)
    except Exception:
        raise stopped_failure(live, 'could not read the authoritative exit resume line') from None
    token, path = exit_session(live, output)
    args = ['run', '--bg', '--no-parent', '--cwd', live['cwd']]
    if name:
        args += ['--name', name]
    for key, value in sorted(labels.items()):
        args += ['--label', f'{key}={value}']
    new = cli(*args, pi_command(options, token, executable))
    new_address = new['address']
    replacement = agent(new_address)
    if (new_address == address or replacement['state'] != 'live' or replacement.get('cwd') != live['cwd']
            or replacement.get('name') != name or any((replacement.get('labels') or {}).get(k) != v for k, v in labels.items())
            or pi_args(replacement) != [*options, '--session', token]):
        raise RuntimeError(f'{new_address}: restart verification failed; inspect before retrying')
    return {'terminal': address, 'replacement': new_address, 'ok': True, 'session': token, 'session_file': path}


def schedule_current(info):
    preflight(info)
    pi_executable()
    directory = Path(tempfile.mkdtemp(prefix='hc-pi-restart-'))
    manifest = directory / 'current.json'
    manifest.write_text(json.dumps({'agent': info}))
    manifest.chmod(0o600)
    log = directory / 'result.log'
    command = ('PATH=' + shlex.quote(os.environ['PATH']) + ' exec '
               + shlex.join([sys.executable, str(Path(__file__).resolve()), '--current-worker', str(manifest)]))
    helper = cli('run', '--bg', '--no-parent', '--name', 'reload-' + uuid.uuid4().hex[:12],
                 command + ' >' + shlex.quote(str(log)) + ' 2>&1')
    return {'scheduled_current': info['address'], 'helper': helper['address'], 'log': str(log)}


def current_worker(manifest):
    info = json.loads(Path(manifest).read_text())['agent']
    def ready():
        live = agent(info['address'])
        preflight(live)
        if not same_launcher(info, live):
            raise RuntimeError('Calling launcher changed; cancelled self-restart')
        return status(live) in ('idle', 'done')
    wait_for(ready, 'calling agent to finish its response', timeout=180)
    return restart(info)


def snapshot():
    return [agent(info['address']) for info in agents()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--interrupt', action='store_true')
    parser.add_argument('--schedule-current', action='store_true')
    parser.add_argument('--current-worker', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not shutil.which('hc') or not os.environ.get('HC_TERMINAL_ID'):
        parser.error('Must run inside an hc terminal with hc on PATH')
    if args.current_worker:
        try:
            print(json.dumps(current_worker(args.current_worker)), flush=True)
        except Exception as error:
            print(json.dumps({'ok': False, 'error': str(error)}), flush=True)
            sys.exit(1)
        return
    rows = snapshot()
    caller = os.environ['HC_TERMINAL_ID']
    if args.schedule_current:
        if args.apply or args.interrupt:
            parser.error('--schedule-current must be a separate final action')
        current = next((info for info in rows if info['address'] == caller), None)
        if not current:
            parser.error('Caller is not a local Pi terminal')
        print(json.dumps(schedule_current(current)), flush=True)
        return
    if not args.apply:
        for info in rows:
            error = None
            try:
                preflight(info)
            except RuntimeError as failure:
                error = str(failure)
            print(json.dumps({'terminal': info['address'], 'name': info.get('name'), 'status': status(info),
                              'cwd': info.get('cwd'), 'caller': info['address'] == caller,
                              'restartable_launcher': error is None, 'skip_reason': error,
                              'session_source': 'Pi exit message after quit'}))
        return
    failed = False
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(restart, info, args.interrupt): info for info in rows if info['address'] != caller}
        for future in concurrent.futures.as_completed(futures):
            try:
                result = future.result()
            except Exception as error:
                failed = True
                result = {'terminal': futures[future]['address'], 'ok': False, 'error': str(error)}
            print(json.dumps(result), flush=True)
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Restart local hc Pi terminals, resuming saved sessions; schedule the caller last."""
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


def cli(*args, timeout=75):
    result = subprocess.run(['hc', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'hc {" ".join(args[:2])}: {result.stderr or result.stdout}')
    return json.loads(result.stdout)


def status(a):
    value = a.get('status')
    return value.get('state') if isinstance(value, dict) else value


def agents():
    return [a for a in cli('ls')['terminals'] if a.get('agent') == 'pi' and a['state'] == 'live']


def agent(address):
    return cli('get', address)


def pi_args(info, default_launch=False):
    argv = info.get('argv') or []
    # hc stores a quoted shell launch as sh -c; only unwrap a simple exec.
    if len(argv) >= 3 and Path(argv[0]).name in ('sh', 'bash', 'zsh') and argv[1] in ('-c', '-lc'):
        argv = shlex.split(argv[2])
        while argv and re.match(r'^[A-Za-z_][A-Za-z_0-9]*=', argv[0]):
            argv = argv[1:]
        if argv and argv[0] == 'exec':
            argv = argv[1:]
    if argv and Path(argv[0]).name == 'pi':
        return argv[1:]
    if len(argv) > 1 and Path(argv[0]).name.startswith('node') and ('pi-coding-agent' in argv[1] or Path(argv[1]).name == 'pi'):
        return argv[2:]
    if default_launch:
        return []
    raise RuntimeError('Original Pi launch flags unavailable; confirm current defaults and use --default-launch')


def session(a, home=None):
    cwd = a.get('cwd')
    if not cwd:
        raise RuntimeError(f'{a["address"]}: missing cwd; refusing to quit')
    directory = (Path(home) if home else Path.home()) / '.pi/agent/sessions' / ('--' + cwd.strip('/').replace('/', '-') + '--')
    args = pi_args(a, default_launch=True)
    explicit = None
    for i, arg in enumerate(args):
        if arg in ('--session', '--session-id'):
            if i + 1 == len(args):
                raise RuntimeError('Incomplete session argument')
            explicit = args[i + 1]
        elif arg.startswith('--session='):
            explicit = arg.split('=', 1)[1]
    custom_directory = '--session-dir' in args
    if explicit:
        candidate = Path(explicit).expanduser()
        if not candidate.is_absolute():
            candidate = Path(cwd) / candidate
        if candidate.is_file():
            return str(candidate.resolve())
        if custom_directory:
            raise RuntimeError('Custom session directory requires an existing explicit session path')
        matches = list(directory.glob('*.jsonl')) if directory.is_dir() else []
        matches = [p for p in matches if p.stem == explicit or p.stem.endswith('_' + explicit)]
        if len(matches) == 1:
            return str(matches[0])
        raise RuntimeError(f'{a["address"]}: explicit session not found uniquely; refusing to quit')
    if custom_directory:
        raise RuntimeError('Custom session directory requires an existing explicit session path')
    matches = list(directory.glob('*.jsonl')) if directory.is_dir() else []
    if not matches:
        raise RuntimeError(f'{a["address"]}: no saved session; refusing to quit')
    return str(max(matches, key=lambda p: p.stat().st_mtime_ns))


def launch_argv_available(info):
    try:
        pi_args(info)
        return True
    except RuntimeError:
        return False


def launch_options(info, default_launch=False):
    args = pi_args(info, default_launch)
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


def wait_for(check, description, timeout=25):
    deadline = time.monotonic() + timeout
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise RuntimeError(f'Timed out: {description}')
        time.sleep(0.3)


def pi_command(options, path):
    executable = shutil.which('pi')
    if not executable:
        raise RuntimeError('pi is not on the caller PATH; refusing to quit')
    # The core may not inherit nvm/mise; resolve in the caller and prepend its bin.
    return f'PATH={shlex.quote(str(Path(executable).parent))}:$PATH exec {shlex.join([executable, *options, "--session", path])}'


def restart(a, interrupt=False, default_launch=False):
    address = a['address']
    path = a.get('session_path') or session(a)
    if not Path(path).is_file():
        raise RuntimeError(f'{address}: saved session disappeared; refusing to quit')
    live = agent(address)
    if live['state'] != 'live' or (live.get('status') or {}).get('app') != 'pi' or live.get('cwd') != a['cwd'] or session(live) != path:
        raise RuntimeError(f'{address}: occupant/session changed; refusing restart')
    state = status(live)
    if state not in ('idle', 'done') and (state != 'working' or not interrupt):
        raise RuntimeError(f'{address}: {state}; not restarted (working requires --interrupt)')
    command = pi_command(launch_options(live, default_launch), path)
    labels = {k: v for k, v in live.get('labels', {}).items() if k in ('herdr.space', 'herdr.tab', 'dotfiles.worker') or k.startswith('ovis.')}
    name = live.get('name')
    if name and not re.fullmatch('[a-z0-9_-]{1,32}', name):
        raise RuntimeError('Invalid hc terminal name; refusing to quit')
    if state == 'working':
        cli('interrupt', address)
        wait_for(lambda: status(agent(address)) in ('idle', 'done'), f'{address} to stop work')
    final = agent(address)
    if final['state'] != 'live' or (final.get('status') or {}).get('app') != 'pi' or session(final) != path or status(final) not in ('idle', 'done'):
        raise RuntimeError(f'{address}: changed before quit; refusing restart')
    cli('send', address, '/quit')
    # Agent waits can return on idle before process teardown; verify exit, not idleness.
    wait_for(lambda: agent(address)['state'] == 'finished', f'{address} to exit Pi')
    args = ['run', '--bg', '--no-parent', '--cwd', live['cwd']]
    if name:
        args += ['--name', name]
    for key, value in sorted(labels.items()):
        args += ['--label', f'{key}={value}']
    new = cli(*args, command)
    new_address = new['address']
    info = agent(new_address)
    if (new_address == address or info['state'] != 'live' or info.get('cwd') != live['cwd']
            or info.get('name') != name or any(info.get('labels', {}).get(k) != v for k, v in labels.items())
            or session(info) != path):
        raise RuntimeError(f'{new_address}: restart verification failed; inspect before retrying')
    return {'terminal': address, 'replacement': new_address, 'ok': True, 'session': path}


def schedule_current(a, default_launch=False):
    a = dict(a, session_path=a.get('session_path') or session(a))
    pi_command(launch_options(a, default_launch), a['session_path'])
    directory = Path(tempfile.mkdtemp(prefix='hc-pi-restart-'))
    manifest = directory / 'current.json'
    manifest.write_text(json.dumps({'agent': a, 'default_launch': default_launch}))
    manifest.chmod(0o600)
    log = directory / 'result.log'
    command = ('PATH=' + shlex.quote(os.environ['PATH']) + ' exec '
               + shlex.join([sys.executable, str(Path(__file__).resolve()), '--current-worker', str(manifest)]))
    helper = cli('run', '--bg', '--no-parent', '--name', 'reload-' + uuid.uuid4().hex[:12],
                 command + ' >' + shlex.quote(str(log)) + ' 2>&1')
    return {'scheduled_current': a['address'], 'helper': helper['address'], 'log': str(log)}


def current_worker(manifest):
    saved = json.loads(Path(manifest).read_text())
    a = saved['agent']
    def ready():
        live = agent(a['address'])
        if live['state'] != 'live' or session(live) != a['session_path']:
            raise RuntimeError('Calling session changed; cancelled self-restart')
        return status(live) in ('idle', 'done')
    wait_for(ready, 'calling agent to finish its response', timeout=180)
    return restart(a, default_launch=saved['default_launch'])


def snapshot():
    rows = [agent(a['address']) for a in agents()]
    # A cwd-only guess cannot distinguish two live Pi sessions in the same folder.
    for a in rows:
        explicit = any(x in ('--session', '--session-id') or x.startswith('--session=') for x in pi_args(a, True))
        if not explicit and sum(b['cwd'] == a['cwd'] for b in rows) > 1:
            raise RuntimeError(f'{a["address"]}: multiple Pi terminals share cwd without explicit --session; resolve manually')
        a['session_path'] = session(a)
        a['session_source'] = 'argv' if explicit else 'newest-for-cwd'
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--interrupt', action='store_true')
    parser.add_argument('--default-launch', action='store_true')
    parser.add_argument('--schedule-current', action='store_true')
    parser.add_argument('--current-worker', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not shutil.which('hc') or not os.environ.get('HC_TERMINAL_ID'):
        parser.error('Must run inside an hc terminal with hc on PATH')
    if args.current_worker:
        print(json.dumps(current_worker(args.current_worker)), flush=True)
        return
    rows = snapshot()
    caller = os.environ['HC_TERMINAL_ID']
    if args.schedule_current:
        if args.apply or args.interrupt:
            parser.error('--schedule-current must be a separate final action')
        current = next((a for a in rows if a['address'] == caller), None)
        if not current:
            parser.error('Caller is not a local Pi terminal')
        print(json.dumps(schedule_current(current, args.default_launch)), flush=True)
        return
    if not args.apply:
        for a in rows:
            print(json.dumps({'terminal': a['address'], 'name': a.get('name'), 'status': status(a),
                              'cwd': a['cwd'], 'session': a['session_path'], 'session_source': a['session_source'],
                              'caller': a['address'] == caller, 'launch_argv_available': launch_argv_available(a)}))
        return
    failed = False
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(restart, a, args.interrupt, args.default_launch): a for a in rows if a['address'] != caller}
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

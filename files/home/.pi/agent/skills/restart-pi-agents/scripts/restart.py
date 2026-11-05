#!/usr/bin/env python3
"""Restart local Herdr Pi occupants without replacing panes or session files."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


def cli(*args, timeout=75):
    result = subprocess.run(['herdr', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'herdr {" ".join(args[:3])}: {result.stderr or result.stdout}')
    return json.loads(result.stdout)['result']


def agents():
    return [a for a in cli('agent', 'list')['agents'] if a['agent'] == 'pi']


def process(pane):
    return cli('pane', 'process-info', '--pane', pane)['process_info']


def agent(pane):
    return cli('agent', 'get', pane)['agent']


def session(a):
    s = a.get('agent_session', {})
    if s.get('kind') != 'path' or not s.get('value') or not Path(s['value']).is_file():
        raise RuntimeError(f'{a["pane_id"]}: no existing exact session path; refusing to quit')
    return s['value']


def wait_for(check, description, timeout=25):
    deadline = time.monotonic() + timeout
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise RuntimeError(f'Timed out: {description}')
        time.sleep(0.3)


def shell_ready(pane):
    p = process(pane)
    # During process teardown Herdr can temporarily omit the foreground group.
    return bool(p.get('shell_pid')) and p.get('foreground_process_group_id') == p['shell_pid']


def launch_options(info, default_launch=False):
    foreground = info.get('foreground_process_group_id')
    pi_process = next((p for p in info.get('foreground_processes', []) if p.get('pid') == foreground), {})
    argv = pi_process.get('argv')
    if not argv:
        if default_launch:
            return []
        raise RuntimeError('Original Pi launch flags are unavailable. Confirm restarting with current defaults, then use --default-launch')
    executable = Path(argv[0]).name if argv else ''
    if executable == 'pi':
        args = argv[1:]
    elif executable.startswith('node') and len(argv) > 1 and ('pi-coding-agent' in argv[1] or Path(argv[1]).name == 'pi'):
        args = argv[2:]
    else:
        raise RuntimeError('Cannot safely identify original Pi invocation; restart manually')
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
        elif arg not in ('--continue', '-c', '--resume', '-r'):
            # Do not print unknown arguments: they may contain secrets or prompts.
            raise RuntimeError('Unsupported original Pi launch options; restart manually')
        i += 1
    return kept


def restart(a, interrupt=False, default_launch=False):
    pane = a['pane_id']
    path = session(a)
    live = agent(pane)
    if session(live) != path:
        raise RuntimeError(f'{pane}: occupant/session changed; refusing restart')
    state = live['agent_status']
    if state not in ('idle', 'done') and (state != 'working' or not interrupt):
        raise RuntimeError(f'{pane}: {state}; not restarted (working requires --interrupt)')
    old = process(pane)
    options = launch_options(old, default_launch)
    if state == 'working':
        cli('agent', 'send-keys', pane, 'esc')
        wait_for(lambda: agent(pane)['agent_status'] in ('idle', 'done'), f'{pane} to stop work')
    live = agent(pane)
    if session(live) != path or live['agent_status'] not in ('idle', 'done'):
        raise RuntimeError(f'{pane}: changed before quit; refusing restart')
    cli('agent', 'prompt', pane, '/quit')
    wait_for(lambda: shell_ready(pane), f'{pane} to return to its shell')
    shell = process(pane)
    shell_cwds = {p.get('cwd') for p in shell.get('foreground_processes', [])}
    expected_cwd = a.get('foreground_cwd') or a.get('cwd')
    if expected_cwd and expected_cwd not in shell_cwds:
        raise RuntimeError(f'{pane}: shell cwd differs; left at shell. Resume manually with pi --session {path}')
    name = a.get('name') or ('reload-' + uuid.uuid4().hex[:16])
    cli('agent', 'start', name, '--kind', 'pi', '--pane', pane, '--timeout', '60000', '--', *options, '--session', path)
    new = agent(pane)
    new_pid = process(pane).get('foreground_process_group_id')
    if session(new) != path or not new_pid or new_pid == old.get('foreground_process_group_id'):
        raise RuntimeError(f'{pane}: restart verification failed; inspect before retrying')
    if not a.get('name'):
        cli('agent', 'rename', pane, '--clear')
    return {'pane': pane, 'ok': True, 'session': path, 'old_pid': old.get('foreground_process_group_id'), 'new_pid': new_pid}


def schedule_current(a, default_launch=False):
    session(a)
    launch_options(process(a['pane_id']), default_launch)
    directory = Path(tempfile.mkdtemp(prefix='herdr-pi-restart-'))
    manifest = directory / 'current.json'
    manifest.write_text(json.dumps({'agent': a, 'default_launch': default_launch}))
    manifest.chmod(0o600)
    log = directory / 'result.log'
    with log.open('w') as output:
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--current-worker', str(manifest)],
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                 start_new_session=True, close_fds=True)
    return {'scheduled_current': a['pane_id'], 'helper_pid': child.pid, 'log': str(log)}


def current_worker(manifest):
    saved = json.loads(Path(manifest).read_text())
    a = saved['agent']
    path = session(a)
    def ready():
        live = agent(a['pane_id'])
        if session(live) != path:
            raise RuntimeError('Calling session changed; cancelled self-restart')
        return live['agent_status'] in ('idle', 'done')
    wait_for(ready, 'calling agent to finish its response', timeout=180)
    time.sleep(1)
    return restart(a, default_launch=saved['default_launch'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Restart other Pi agents; default is inventory only')
    parser.add_argument('--interrupt', action='store_true', help='Allow Escape to abort working turns; blocked/unknown are never dismissed')
    parser.add_argument('--default-launch', action='store_true', help='Confirmed consent to use current defaults if original CLI flags are unavailable')
    parser.add_argument('--schedule-current', action='store_true', help='Only schedule caller restart after it becomes idle; use as final tool action')
    parser.add_argument('--current-worker', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if os.environ.get('HERDR_ENV') != '1' or not os.environ.get('HERDR_PANE_ID'):
        parser.error('Must run inside a Herdr-managed pane')
    if args.current_worker:
        print(json.dumps(current_worker(args.current_worker)), flush=True)
        return
    snapshot = agents()
    caller = os.environ['HERDR_PANE_ID']
    if args.schedule_current:
        if args.apply or args.interrupt:
            parser.error('--schedule-current must be a separate final action')
        current = next(a for a in snapshot if a['pane_id'] == caller)
        print(json.dumps(schedule_current(current, args.default_launch)), flush=True)
        return
    if not args.apply:
        for a in snapshot:
            info = process(a['pane_id'])
            argv_available = any(p.get('argv') for p in info.get('foreground_processes', []) if p.get('pid') == info.get('foreground_process_group_id'))
            print(json.dumps({'pane':a['pane_id'], 'name':a.get('name'), 'status':a['agent_status'],
                              'cwd':a.get('cwd'), 'session':session(a), 'caller':a['pane_id'] == caller,
                              'launch_argv_available':bool(argv_available)}))
        return
    targets = [a for a in snapshot if a['pane_id'] != caller]
    failed = False
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(restart, a, args.interrupt, args.default_launch):a for a in targets}
        for future in concurrent.futures.as_completed(futures):
            try:
                result = future.result()
            except Exception as error:
                failed = True
                result = {'pane':futures[future]['pane_id'], 'ok':False, 'error':str(error)}
            print(json.dumps(result), flush=True)
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()

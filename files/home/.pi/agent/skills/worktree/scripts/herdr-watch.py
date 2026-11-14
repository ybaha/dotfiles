#!/usr/bin/env python3
"""Compatibility filename: read hc status once, optionally wait for one turn.

No socket reporter or background watcher is needed on hc. Not launched by spawn.sh.
"""
import argparse
import json
import os
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('terminal', nargs='?', default=os.environ.get('HC_TERMINAL_ID'))
    parser.add_argument('--wait', action='store_true')
    args = parser.parse_args()
    if not args.terminal:
        parser.error('Provide an hc terminal address or HC_TERMINAL_ID')
    if args.wait:
        subprocess.run(['hc', 'wait', args.terminal, '--timeout', '180'], check=True, timeout=190)
    result = subprocess.run(['hc', 'get', args.terminal], capture_output=True, text=True, check=True, timeout=15)
    info = json.loads(result.stdout)
    state = info.get('status') or {}
    status = state.get('state', 'unknown') if isinstance(state, dict) else state
    label = info.get('name') or args.terminal
    body = 'terminal exited' if info['state'] == 'finished' else f'status={status} agent={state.get("app", "?") if isinstance(state, dict) else "?"}'
    print(f'[{time.strftime("%H:%M:%S")}] {label}: {body}', flush=True)


if __name__ == '__main__':
    main()

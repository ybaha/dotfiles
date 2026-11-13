#!/usr/bin/env python3
"""Log a Herdr pane's agent status changes until the pane exits.

Long-lived: idle stretches, socket timeouts and Herdr restarts reconnect instead of
exiting. Each (re)connect re-reads the current status, so a change that happened while
disconnected is still logged. A status is only printed when it differs from the last one.
"""
import json
import os
import socket
import subprocess
import time

sock_path = os.environ.get("HERDR_SOCK", os.path.expanduser("~/.config/herdr/herdr.sock"))
pane_id = os.environ["HERDR_PANE_ID"]
label = os.environ["HERDR_AGENT_LABEL"]
IDLE_RECONNECT_SECONDS = 600
last_status = None


def ts():
    return time.strftime("%H:%M:%S")


def report(status, agent):
    global last_status
    if not status or status == last_status:
        return
    last_status = status
    print(f"[{ts()}] {label}: status={status} agent={agent}", flush=True)
    if status == "blocked":
        print(f"[{ts()}] {label}: BLOCKED — needs user input", flush=True)


def current_pane():
    """Return the pane dict, None if the pane is gone, or {} if Herdr is unreachable."""
    try:
        out = subprocess.run(
            ["herdr", "pane", "get", pane_id], capture_output=True, text=True, timeout=15
        )
    except Exception:
        return {}
    if out.returncode != 0:
        return None if "not found" in (out.stderr + out.stdout).lower() else {}
    try:
        return json.loads(out.stdout).get("result", {}).get("pane", {}) or {}
    except Exception:
        return {}


def watch_once():
    """Subscribe and log events. Returns True when the pane has exited."""
    pane = current_pane()
    if pane is None:
        print(f"[{ts()}] {label}: pane exited", flush=True)
        return True
    report(pane.get("agent_status"), pane.get("agent") or "?")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(IDLE_RECONNECT_SECONDS)
    try:
        s.connect(sock_path)
        subscribe = {
            "jsonrpc": "2.0",
            "id": "watcher",
            "method": "events.subscribe",
            "params": {
                "subscriptions": [
                    {"type": "pane.agent_status_changed", "pane_id": pane_id},
                    {"type": "pane.exited", "pane_id": pane_id},
                ]
            },
        }
        s.sendall((json.dumps(subscribe) + "\n").encode())
        buf = b""
        while True:
            try:
                chunk = s.recv(4096)
            except socket.timeout:
                return False  # idle: reconnect and re-read status
            if not chunk:
                return False
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    evt = json.loads(line.decode())
                except Exception:
                    continue
                kind = evt.get("event", "?")
                data = evt.get("data", {})
                if kind == "pane.agent_status_changed":
                    report(
                        data.get("agent_status", ""),
                        data.get("agent") or data.get("display_agent") or "?",
                    )
                elif kind == "pane.exited":
                    print(f"[{ts()}] {label}: pane exited", flush=True)
                    return True
    finally:
        s.close()


print(f"[{ts()}] subscribed pane={pane_id} label={label}", flush=True)
while True:
    try:
        if watch_once():
            break
    except Exception as e:
        print(f"[watcher-error] {e} (reconnecting)", flush=True)
        time.sleep(5)

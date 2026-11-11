#!/usr/bin/env python3
import json
import os
import socket
import time

sock_path = os.environ.get("HERDR_SOCK", os.path.expanduser("~/.config/herdr/herdr.sock"))
pane_id = os.environ["HERDR_PANE_ID"]
label = os.environ["HERDR_AGENT_LABEL"]
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(3600)
    s.connect(sock_path)
    s.sendall(
        (
            json.dumps(
                {
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
            )
            + "\n"
        ).encode()
    )
    print(f"[{time.strftime('%H:%M:%S')}] subscribed pane={pane_id} label={label}", flush=True)
    buf = b""
    while True:
        chunk = s.recv(4096)
        if not chunk:
            break
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
            ts = time.strftime("%H:%M:%S")
            if kind == "pane.agent_status_changed":
                status = data.get("agent_status", "")
                agent = data.get("agent") or data.get("display_agent") or "?"
                print(f"[{ts}] {label}: status={status} agent={agent}", flush=True)
                if status == "blocked":
                    print(f"[{ts}] {label}: BLOCKED — needs user input", flush=True)
            elif kind == "pane.exited":
                print(f"[{ts}] {label}: pane exited", flush=True)
                s.close()
                break
except Exception as e:
    print(f"[watcher-error] {e}", flush=True)

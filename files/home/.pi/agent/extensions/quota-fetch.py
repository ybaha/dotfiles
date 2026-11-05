#!/usr/bin/env python3
"""One-shot quota fetcher used by the quota-cache extension.

Reads a single provider and prints a JSON snapshot on stdout:

    {"fetchedAt": 1234567890000, "live": true, ...fields...}

Never prints tokens or raw response bodies. Exit code 0 on success, non-zero
on transport failure; the cache layer keeps the previous reading in either
case. Designed to run under `python3` (any modern 3.x).
"""

import json
import os
import re
import select
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HOME = Path.home()
NOW_MS = int(time.time() * 1000)


def bail(message: str) -> "None":
    sys.stderr.write(f"{message}\n")
    sys.exit(1)


def bail_if_unknown(provider: str) -> None:
    if provider not in {"claude", "codex", "minimax", "cursor"}:
        bail(f"unknown provider: {provider}")


def fetch_claude() -> dict:
    """OAuth usage endpoint; read-only and never sends a model prompt."""
    path = HOME / ".claude" / ".credentials.json"
    token = None
    try:
        token = json.loads(path.read_text())["claudeAiOauth"]["accessToken"]
    except (OSError, KeyError, TypeError, ValueError):
        pass
    if not token and shutil.which("security"):
        try:
            result = subprocess.run(
                ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                check=True, capture_output=True, text=True, timeout=5,
            )
            token = json.loads(result.stdout)["claudeAiOauth"]["accessToken"]
        except (OSError, subprocess.SubprocessError, KeyError, TypeError, ValueError):
            pass
    if not token:
        bail("claude: no credential")
    request = urllib.request.Request(
        "https://api.anthropic.com/api/oauth/usage",
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        bail(f"claude: http {exc.code}")
    except (OSError, ValueError, urllib.error.URLError) as exc:
        bail(f"claude: transport {exc}")
    five_hour = payload.get("five_hour") or {}
    seven_day = payload.get("seven_day") or {}
    def resets_to_epoch(value):
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return int(round(float(value)))
        try:
            from datetime import datetime
            return int(round(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()))
        except (TypeError, ValueError, OSError):
            return None

    return {
        "fetchedAt": NOW_MS,
        "live": True,
        "primaryLeft": 100 - int(round(float(five_hour.get("utilization", 0)))),
        "weeklyLeft": 100 - int(round(float(seven_day.get("utilization", 0)))),
        "primaryResetsAt": resets_to_epoch(five_hour.get("resets_at")),
        "weeklyResetsAt": resets_to_epoch(seven_day.get("resets_at")),
    }


def fetch_codex() -> dict:
    """Local Codex app-server's documented account/rateLimits/read request."""
    if not shutil.which("codex"):
        bail("codex: cli missing")
    process = subprocess.Popen(
        ["codex", "app-server", "--stdio"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    try:
        def send(payload):
            process.stdin.write(json.dumps(payload) + "\n")
            process.stdin.flush()

        def receive(request_id, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                readable, _, _ = select.select([process.stdout], [], [], deadline - time.monotonic())
                if not readable:
                    break
                line = process.stdout.readline()
                if not line:
                    break
                message = json.loads(line)
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(message["error"].get("message", "codex error"))
                    return message["result"]
            raise RuntimeError("codex timeout")

        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "pi-quota-cache", "version": "1.0"}, "capabilities": {}}})
        receive(1)
        send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        send({"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": {}})
        payload = receive(2)["rateLimits"]
    except Exception as exc:
        bail(f"codex: {exc}")
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
    primary, secondary = payload["primary"], payload.get("secondary") or {}
    return {
        "fetchedAt": NOW_MS,
        "live": True,
        "plan": str(payload.get("planType") or "subscription").title(),
        "primaryLeft": 100 - int(round(float(primary.get("usedPercent", primary.get("utilization", 0))))),
        "weeklyLeft": 100 - int(round(float(secondary.get("usedPercent", secondary.get("utilization", 100 - 100))))) if secondary else 100,
        "primaryResetsAt": primary.get("resetsAt"),
        "weeklyResetsAt": secondary.get("resetsAt"),
    }


def fetch_minimax() -> dict:
    """Coding-plan remaining endpoint."""
    auth_path = HOME / ".pi" / "agent" / "auth.json"
    try:
        key = json.loads(auth_path.read_text())["minimax"]["key"]
    except (OSError, KeyError, TypeError, ValueError) as exc:
        bail(f"minimax: auth missing ({exc})")
    request = urllib.request.Request(
        "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.load(response)
    except (OSError, ValueError, urllib.error.URLError) as exc:
        bail(f"minimax: transport {exc}")
    if payload.get("base_resp", {}).get("status_code") not in (None, 0):
        bail(f"minimax: {payload['base_resp'].get('status_msg')}")
    general = next(item for item in payload["model_remains"] if item.get("model_name") == "general")
    return {
        "fetchedAt": NOW_MS,
        "live": True,
        "currentLeft": int(round(float(general["current_interval_remaining_percent"]))),
        "weeklyLeft": int(round(float(general["current_weekly_remaining_percent"]))),
        "currentResetsAt": general.get("end_time"),
        "weeklyResetsAt": general.get("weekly_end_time"),
    }


def fetch_cursor() -> dict:
    """Just the launchd state — `running`/`stopped` for the IDE proxy."""
    if not shutil.which("launchctl"):
        return {"fetchedAt": NOW_MS, "live": False, "state": "unknown", "detail": "launchctl missing"}
    try:
        result = subprocess.run(
            ["launchctl", "print", f"gui/{os.getuid()}/com.baha.cursor2api-ide"],
            capture_output=True, text=True, timeout=3,
        )
        running = result.returncode == 0 and bool(re.search(r"^\s*state = running\s*$", result.stdout, re.M))
        return {"fetchedAt": NOW_MS, "live": True, "state": "running" if running else "stopped"}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"fetchedAt": NOW_MS, "live": False, "state": "unknown", "detail": str(exc)}


HANDLERS = {
    "claude": fetch_claude,
    "codex": fetch_codex,
    "minimax": fetch_minimax,
    "cursor": fetch_cursor,
}


def main() -> None:
    if len(sys.argv) != 2:
        bail("usage: quota-fetch.py <claude|codex|minimax|cursor>")
    bail_if_unknown(sys.argv[1])
    snap = HANDLERS[sys.argv[1]]()
    json.dump(snap, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()

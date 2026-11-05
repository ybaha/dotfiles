# Preview Hub

Small, dependency-free Python 3.9+ service for macOS/Linux. One tailnet-only HTTPS dashboard, latest publication first. Apps use separate HTTPS ports so asset paths and WebSockets work without subpath rewrites.

## Install

From the dotfiles repository: `./install.sh --pi-only --dry-run`, review, then `./install.sh --pi-only`. This links the CLI, source, and Pi skill/prompt. In an existing Pi session run `/reload` to discover `/preview`.

```sh
previewctl service install --dry-run
previewctl service install
previewctl url                          # bookmark on your phone
```

Requires Tailscale connected with HTTPS certificates enabled. No packages or ACL changes are installed automatically. macOS starts at login using launchd. Linux uses systemd --user; enable lingering yourself (`loginctl enable-linger "$USER"`) for boot/logout persistence. Sleeping/offline machines remain unreachable.

## Use

```sh
previewctl up --title "My app" -- npm run dev -- --host 127.0.0.1 --port '{port}'
previewctl up                           # reuse, refresh TTL, move to top
previewctl attach --port 5173 --title "Existing app"
previewctl list                         # --json available on control commands
previewctl stop                         # this worktree only; --all is explicit
previewctl doctor
```

Use `/preview`, `/preview stop`, or `/preview list` in Pi. Default TTL is 24 hours after the latest publication, configurable with `--ttl 2h`; browser visits do not extend it. Unhealthy apps disappear from the dashboard immediately and are cleaned up after 60 seconds. App processes are detached from Pi and survive its restart, but are not relaunched after an OS reboot; stopped previews are reconciled away.

## Boundaries

The dashboard prefers HTTPS443; if occupied, it selects a free HTTPS8443–8499 port and persists that choice. Previews use remaining ports in the same range. Existing Tailscale routes are preserved; a later conflict on a recorded port causes an error instead of replacement. No Funnel. HTTP8766 and app servers bind loopback. Administrative commands use a private Unix socket; the phone dashboard is read-only. Tailnet ACLs determine who can access it. Frameworks may need their exact tailnet host/origin allowed (Vite receives a narrow host hint); never disable host validation globally. Do not serve repository roots containing secrets.

State/logs live in `~/.local/state/preview-hub` (`XDG_STATE_HOME` or `PREVIEW_HUB_STATE_DIR` overrides). Only hub-started processes are terminated; attached apps are never killed. Failed route cleanup is retained and retried. `previewctl service uninstall` cleans owned previews/routes before removing its marked service. Retain state until cleanup succeeds—deleting metadata does not remove Tailscale routes.

## Test

`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s files/home/.local/share/preview-hub/tests -v`

Tests mock Tailscale/service mutations and use temporary local HTTP fixtures. Linux service definitions are tested; live Linux deployment is not validated from macOS.

# directory: tiny tailnet service directory

Static site at `http://agents/` (also `https://agents.<tailnet>/`) listing every durable service on the tailnet, for humans (searchable page) and AI agents (`/index.md`, `/llms.txt`, `/services.json`, `/status.json`, `/services/<id>.md`).

- `registry.toml`: the only file you edit. `{tailnet}` is filled from `TAILNET` in `~/.config/pi-agent/local.env` (kept out of git).
- `build.py OUTDIR`: stdlib generator (no deps).
- `deploy`: build, push to LXC 109 `agents`, verify. `deploy --setup` also installs the 5-minute health-check timer and `tailscale serve`.
- `status.sh`: runs in the container; probes each `health_url`, writes `status.json`.

Serving needs no web server: `tailscale serve` serves `/srv/agents` directly. The container (Debian 12, 192 MB, 2 GB disk) runs only `tailscaled` and a systemd timer.

Add a service: append a `[[service]]` block, run `directory/deploy`. Never put secrets in the registry, only where they live.

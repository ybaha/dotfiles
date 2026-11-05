# Optional Cursor IDE proxy

The `cursor-ide/composer-2.5` Pi model points to `http://127.0.0.1:8787/v1` in the shared `models.json`. It needs a **separate** local `cursor2api-ide` fork; the model entry alone does not install or start it. Never use Cursor's `agent` CLI as a substitute (different pool) or assume the proxy is unlimited: slow-pool routing is unverified. Keep proxy tokens in local `~/.config/cursor2api/credentials.json` (0600), not Git.

On a host with that fork checked out at `~/code/cursor2api-ide`, follow its own README to set up Python/dependencies, run `python -m cursor2api login`, then `python -m cursor2api serve`. The proxy must listen on `127.0.0.1:8787`; validate `GET /v1/models` and a small real Composer request before delegating. On macOS an optional local launchd service may manage it; on Linux use an approved local service. If the proxy is unavailable, ask before switching worker models.

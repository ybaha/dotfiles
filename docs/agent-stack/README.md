# Pi + Herdr

Dotfiles owns the shared Pi configuration (`files/home/.pi/agent/`) and short global instructions (`AGENTS.md` there). Pi loads global instructions/extensions at startup and advertises global skills; it reads a skill's full instructions only when needed. Project `AGENTS.md` stays with each project.

On each Mac/Linux machine:

1. Install Pi/Herdr separately; clone dotfiles (default `~/code/dotfiles`). Inspect `./install.sh --dry-run`, then run `./install.sh` after reviewing replacements and backups. Do not sync auth, sessions, sockets, or caches.
2. `herdr integration install pi && herdr integration status` (per-machine generated code; not committed). Install Herdr workflow plugins separately if needed; `herdr plugin list`.
3. Verify `pi --version`, `pi list`, `pi --list-models`, and `/agents` if using subagents. Configure credentials locally in `~/.pi/agent/auth.json` (0600). A model listed in config is not proof that its provider works.
4. Start Pi in the target folder, preferably inside Herdr. Use `/reload` after pulling changed settings/skills in an existing session; start a new Pi process after changing installed integrations.

Shared settings/models, `subagents.json`, and the five `agents/*.md` definitions belong in dotfiles; `install.sh` links them into `~/.pi/agent/`. Update once there and include new files in the commit before pulling on other machines. Packages pinned in settings and Herdr integrations require deliberate per-machine updates; Git pull alone does not fetch upstream releases. `~/.pi/agent/AGENTS.md` is the only always-loaded cross-project policy. Read [ROUTING.md](ROUTING.md), [SUBAGENTS.md](SUBAGENTS.md), [HERDR.md](HERDR.md), and [PROVIDERS.md](PROVIDERS.md) only as needed. [PSTACK.md](PSTACK.md) records the pstack assessment and four local skill adaptations; no plugin or package was added.

## Explicit workflow skills

Run `/reload` after pulling these skills, then choose the command you need:

- `/skill:bug-fix <defect>`: reproduce, fix within approved scope, and verify.
- `/skill:design-change <change>`: produce a plan; no implementation by default.
- `/skill:review-change <diff or plan>`: review and report; no automatic fixes.
- `/skill:create-verification-skill <target repo>`: create and prove a project-specific verification skill.

These instructions use the existing agents. They do not change settings, auto-run, or install dependencies. To roll back, remove the four new skill directories and these documentation entries, then `/reload`; leave other dirty files alone.

Before relying on portable skills that SSH into tailnet boxes (`send-to-phone`, etc.),
follow the one-time setup in [TAILSCALE-SSH.md](TAILSCALE-SSH.md): tailnet ACL SSH
rule + `sudo tailscale up --ssh` on each Linux host + the Mac's public key in
`baha`'s `authorized_keys`. Without this, the skills silently fall back to plain
`sshd` and prompt for credentials every run.

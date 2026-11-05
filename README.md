# Dotfiles

My portable developer cockpit: macOS-first dotfiles, agent skills, Pi/Herdr integration, and a Linux-safe CLI baseline.

## Install

```sh
git clone git@github.com:ybaha/dotfiles.git ~/code/dotfiles
cd ~/code/dotfiles
./install.sh --dry-run
./install.sh --packages  # optional
```

`install.sh` backs up replaced paths to `~/.dotfiles-backups/<timestamp>/`. Never use `--force` unless you have reviewed the backup plan.

## Commands

```sh
./install.sh                 # link managed configuration
./install.sh --dry-run       # preview changes
./install.sh --pi-only --dry-run # preview only Pi links
./install.sh --pi-only       # link only Pi config/resources
./install.sh --packages      # install package manifests
./install.sh --legacy-editors # install archived macOS VS Code preferences
```

`--packages` installs CLI tools from `Brewfile` on any Homebrew host. GUI casks in `Brewfile.macos` are applied only on macOS; Linux hosts explicitly skip them. `--legacy-editors` is macOS-only.

## Included

- Zsh with the existing Antigen `dst` theme and plugin set
- Git, GitHub CLI, htop, btop, Zed, and Herdr preferences
- Pi settings/extensions/skills and global `AGENTS.md` rules; portable Claude/shared-agent skills
- On-demand `/skill:browser-use` (Browser Use Pi SDK); run its `scripts/setup` once per machine. The SDK installs to `~/.local/share/browser-use-pi` and needs its own `OPENROUTER_API_KEY`, kept out of the repo
- Optional archived VS Code preferences
- Project-owned skill links when their source repositories are present

Git identity/credential helpers belong in ignored `~/.gitconfig.local`; host-specific shell paths belong in ignored `~/.config/zsh/local.zsh`; network values (tailnet host names, Nextcloud URL) belong in ignored `~/.config/pi-agent/local.env`. `install.sh` creates both from the tracked `.example` files, and docs use placeholders such as `<your-tailnet>`.

## Pi and Herdr on another machine

Pull dotfiles, inspect `./install.sh --dry-run`, then link with `./install.sh` only after reviewing replacements/backups. Install Pi and Herdr separately; run `herdr integration install pi` on **each machine**, then check `herdr integration status`. The integration file under `~/.pi/agent/extensions/` is generated locally, not synced. Run `/reload` in an open Pi session after changing skills/instructions; new sessions pick them up at startup. Pinned Pi packages are upgraded deliberately, not automatically. Herdr workflow plugins are separate installations (`herdr plugin list`), not Pi skills.

Dotfiles is the only active source for shared Pi settings, models, global instructions, skills, extensions, and short [agent-stack guides](docs/agent-stack/README.md). Pi loads only the global instructions automatically—not every guide. Review the dry run before linking over existing settings/models. Keep auth and host-specific service state local; `pi-orchestra` is an archived repo, not a runtime dependency.

## Safety

No credentials, tokens, sessions, histories, caches, logs, databases, virtualenvs, or application runtime state are tracked. Herdr includes only `config.toml`; Pi/Claude auth and sessions are excluded.

## Publishing a public copy

`bin/make-public-snapshot <new-dir>` exports the committed tree as a fresh single-commit repo (no history, GitHub noreply identity, `docs/plans` left out) and refuses to keep it if gitleaks or `~/.config/pi-agent/public-blocklist.txt` (one never-publish string per line, kept local) finds anything. It does not push; publish the result with `gh repo create`. Do not make this repository itself public: its history predates the placeholders.

## Agents

Read [`AGENTS.md`](AGENTS.md) before changing a host. It requires agents to inspect the OS, server/desktop role, installed tools, and existing configuration; prepare an approved plan; then begin with `./install.sh --dry-run`.

Host-specific rollout plans stay outside this repository.

# Agent instructions

This repository manages real user environments. Treat every host as unknown until inspected.

## Required preflight

Before proposing or applying any installation, first gather **read-only** evidence:

```sh
uname -srm
cat /etc/os-release 2>/dev/null || true
id
printf 'shell=%s\n' "${SHELL:-unknown}"
command -v git zsh brew apt-get mise pi claude gh antigen btop htop || true
```

Then inspect, without printing credentials:

- whether the host is interactive/desktop or a headless server;
- existing shell startup files and package-manager state;
- whether the destination paths already exist;
- Git working-tree state and whether the private repository is reachable.

Do **not** infer the platform from a hostname, IP address, or prior conversation.

## Plan before mutation

For a new host, write a concise host-specific plan before changing files or installing packages. The plan must classify every candidate as one of:

1. already present — leave it alone;
2. safe CLI dependency to install;
3. configuration to link after backup;
4. desktop-only configuration/app to skip;
5. missing prerequisite, credential, or user decision.

Show the plan and ask for approval before package installation, linking existing paths, changing the login shell, or restarting services. Start any approved rollout with `./install.sh --dry-run`; never use `--force` unless the user explicitly approves replacement without a backup.

## Platform policy

- **Linux/headless server:** CLI tools only. Never install GUI casks/apps (Zed, iTerm, VS Code integrations) or desktop defaults. Preserve existing SSH/service configuration. Use the distribution package manager unless Homebrew is explicitly requested.
- **macOS workstation:** GUI packages may be installed only through `./install.sh --packages`; that command is responsible for the OS guard.
- Keep platform-specific shell paths behind an OS/host guard or in ignored local configuration. A shared shell config must never assume `/opt/homebrew`, macOS SDKs, or a particular Antigen location exists.

## Safety and secrets

Never read, copy, commit, log, or display authentication/session material. This includes SSH keys, cloud credentials, `gh/hosts.yml`, Pi/Claude auth and session files, `.env*`, package-manager tokens, and browser/application databases.

Back up existing managed paths through `install.sh`; do not delete user configuration merely because it is absent from this repository. Runtime state, caches, logs, sockets, histories, and virtual environments are not dotfiles.

## Validation and reporting

After an approved change, run only relevant validation: shell syntax/startup checks, `./install.sh --dry-run`, and package/config checks. Report changed paths, backups, commands run, validation results, deferred items, and rollback instructions.

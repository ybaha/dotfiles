#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
home_dir=${HOME:?HOME must be set}
dry_run=false
include_legacy_editors=false
force=false
install_packages=false
pi_only=false
os_name=$(uname -s)

usage() {
  cat <<'EOF'
Usage: ./install.sh [--dry-run] [--force] [--packages] [--legacy-editors] [--pi-only]

Links curated dotfiles into $HOME. Existing non-symlink files are backed up
under ~/.dotfiles-backups/<timestamp>/ unless --force is provided.

Options:
  --dry-run          Print planned changes only.
  --force            Replace existing paths without a backup.
  --packages         Install the CLI Brewfile; apply GUI casks only on macOS.
  --legacy-editors   Also link archived macOS VS Code settings/keybindings.
  --pi-only          Link only shared Pi config, instructions, extensions, skills.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    --force) force=true ;;
    --packages) install_packages=true ;;
    --pi-only) pi_only=true ;;
    --legacy-editors) include_legacy_editors=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$pi_only" == true && ( "$install_packages" == true || "$include_legacy_editors" == true ) ]]; then
  echo "--pi-only cannot be combined with --packages or --legacy-editors." >&2
  exit 2
fi

if [[ "$include_legacy_editors" == true && "$os_name" != "Darwin" ]]; then
  echo "--legacy-editors is macOS-only." >&2
  exit 2
fi

install_packages() {
  if ! command -v brew >/dev/null; then
    echo "Homebrew is required for --packages. Install it first, then retry." >&2
    exit 1
  fi

  echo "install    CLI packages from Brewfile"
  [[ "$dry_run" == true ]] || brew bundle --file "$repo_dir/Brewfile"

  if [[ "$os_name" == "Darwin" ]]; then
    echo "install    macOS GUI packages from Brewfile.macos"
    [[ "$dry_run" == true ]] || brew bundle --file "$repo_dir/Brewfile.macos"
  else
    echo "skip       GUI packages: $os_name is not a macOS workstation"
  fi
}

[[ "$install_packages" == true ]] && install_packages

backup_root="$home_dir/.dotfiles-backups/$(date +%Y%m%d-%H%M%S)"
backup_path() {
  local target=$1 relative
  relative=${target#"$home_dir"/}
  printf '%s/%s\n' "$backup_root" "$relative"
}

link_path() {
  local relative source target
  relative=$1
  source="$repo_dir/files/home/$relative"
  target="$home_dir/$relative"
  [[ -e "$source" || -L "$source" ]] || { echo "Missing source: $source" >&2; exit 1; }

  if [[ -L "$target" && "$(readlink "$target")" == "$source" ]]; then
    echo "unchanged  $target"
    return
  fi

  if [[ -e "$target" || -L "$target" ]]; then
    if [[ "$force" == false ]]; then
      local backup
      backup=$(backup_path "$target")
      echo "backup     $target -> $backup"
      [[ "$dry_run" == true ]] || { mkdir -p "$(dirname "$backup")"; mv "$target" "$backup"; }
    else
      echo "replace    $target"
      [[ "$dry_run" == true ]] || rm -rf "$target"
    fi
  fi

  echo "link       $target -> $source"
  [[ "$dry_run" == true ]] || { mkdir -p "$(dirname "$target")"; ln -s "$source" "$target"; }
}

link_pi_paths() {
  link_path .pi/agent/AGENTS.md
  link_path .pi/agent/settings.json
  link_path .pi/agent/models.json
  link_path .pi/agent/subagents.json
  link_path .pi/agent/agents
  link_path .pi/agent/extensions
  link_path .pi/agent/skills
  link_path .pi/agent/prompts
  link_path .pi/agent/chief-of-staff
  link_path .agents/skills
  link_path .local/share/preview-hub
  link_path .local/bin/previewctl
  link_path .local/bin/pi-chief
  link_path .local/bin/pi-dotfiles-push
}

if [[ "$pi_only" == true ]]; then
  link_pi_paths
  exit 0
fi

# Shell and Git
link_path .zshrc
link_path .zprofile
link_path .zshenv
link_path .gitconfig

# Preferred editor and selected CLI/UI config. Credential/session data is never linked.
if [[ "$os_name" == "Darwin" ]]; then
  link_path .config/zed/settings.json
else
  echo "skip       Zed settings: $os_name is not a macOS workstation"
fi
link_path .config/git/ignore
link_path .config/gh/config.yml
link_path .config/htop/htoprc
link_path .config/herdr/config.toml
link_path .config/zsh/local.zsh.example
link_path .config/pi-agent/local.env.example

# Agent configuration, extensions, hooks, and source-only skills.
link_pi_paths
link_path .claude/settings.json
link_path .claude/statusline-command.sh
link_path .claude/hooks/herdr-agent-state.sh
link_path .claude/skills

if [[ "$include_legacy_editors" == true ]]; then
  link_path 'Library/Application Support/Code/User/settings.json'
  link_path 'Library/Application Support/Code/User/keybindings.json'
fi

if [[ "$dry_run" == false && ! -e "$home_dir/.config/zsh/local.zsh" ]]; then
  cp "$repo_dir/files/home/.config/zsh/local.zsh.example" "$home_dir/.config/zsh/local.zsh"
  chmod 600 "$home_dir/.config/zsh/local.zsh"
  echo "created    $home_dir/.config/zsh/local.zsh"
fi

if [[ "$dry_run" == false && ! -e "$home_dir/.config/pi-agent/local.env" ]]; then
  cp "$repo_dir/files/home/.config/pi-agent/local.env.example" "$home_dir/.config/pi-agent/local.env"
  chmod 600 "$home_dir/.config/pi-agent/local.env"
  echo "created    $home_dir/.config/pi-agent/local.env (fill in your network values)"
fi

if [[ "$dry_run" == false && ! -e "$home_dir/.gitconfig.local" ]]; then
  cp "$repo_dir/files/home/.gitconfig.local.example" "$home_dir/.gitconfig.local"
  chmod 600 "$home_dir/.gitconfig.local"
  echo "created    $home_dir/.gitconfig.local (set your identity before committing)"
fi

[[ "$dry_run" == true ]] || "$repo_dir/bin/link-external-skills"

echo "\nDone. Review any backup under $backup_root. Antigen bundles are configured in files/home/.zshrc."

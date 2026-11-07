# Managed by ~/code/dotfiles. This preserves the existing plugin set exactly.

if [[ -z ${EDITOR-} ]]; then
  if command -v nvim >/dev/null 2>&1; then
    export EDITOR=nvim
  else
    export EDITOR=vi
  fi
fi
: "${VISUAL:=$EDITOR}"

typeset -U path PATH
path=( $path )

export GOPATH="${GOPATH:-$HOME/go}"
export GOBIN="$GOPATH/bin"
path=( "$GOBIN" $path )

if [[ "$(uname -s)" == Darwin ]]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
  path=(
    $path
    "$ANDROID_HOME/emulator"
    "$ANDROID_HOME/tools"
    "$ANDROID_HOME/tools/bin"
    "$ANDROID_HOME/platform-tools"
  )

  if [[ -d /usr/local/go ]]; then
    export GOROOT="/usr/local/go"
    path=( $path "$GOROOT/bin" )
  fi

  path=(
    /usr/local/bin
    /opt/homebrew/bin
    /opt/homebrew/bin/python3.11
    $path
  )
else
  if command -v mise >/dev/null 2>&1; then
    if [[ -o interactive ]]; then
      eval "$(mise activate zsh)"
    else
      path=( "${XDG_DATA_HOME:-$HOME/.local/share}/mise/shims" $path )
    fi
  fi
fi

path=( /usr/local/bin $path )

# Load/configure Antigen only once in an interactive shell. This prevents
# `source ~/.zshrc` from repeatedly reapplying plugins, while preserving the
# original dynamic Antigen loading path that supplies the current theme/plugins.
# Missing antigen.zsh or bundle deps surface Antigen warnings; bundles are not removed.
if [[ -o interactive && -z ${DOTFILES_ANTIGEN_READY-} ]]; then
  if [[ -r "$HOME/antigen.zsh" ]]; then
    source "$HOME/antigen.zsh"
    antigen use oh-my-zsh

    alias ze="$EDITOR ~/.zshrc"
    alias zs="source ~/.zshrc"
    alias ve="$EDITOR ~/.vimrc"

    export ZSH="$HOME/.oh-my-zsh"
    antigen bundle git
    antigen bundle heroku
    antigen bundle pip
    antigen bundle lein
    antigen bundle command-not-found
    antigen bundle fasd
    antigen bundle z
    antigen bundle thefuck
    antigen bundle SinaKhalili/ignore-dollarsign
    antigen bundle zsh-users/zsh-completions
    antigen bundle zsh-users/zsh-autosuggestions
    # Must be last: it instruments ZLE widgets created by other plugins.
    antigen bundle zsh-users/zsh-syntax-highlighting
    antigen theme dst
    antigen apply

    typeset -g DOTFILES_ANTIGEN_READY=1
  else
    print -u2 'dotfiles: ~/.antigen.zsh is missing or unreadable; Antigen plugins skipped.'
  fi
fi

# NVM and Bun initialize once per shell on macOS only (Linux uses mise).
if [[ "$(uname -s)" == Darwin && -z ${DOTFILES_NODE_READY-} ]]; then
  export NVM_DIR="$HOME/.nvm"
  [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
  [[ -s "$NVM_DIR/bash_completion" ]] && source "$NVM_DIR/bash_completion"
  [[ -s "$HOME/.bun/_bun" ]] && source "$HOME/.bun/_bun"
  export BUN_INSTALL="$HOME/.bun"
  path=( "$BUN_INSTALL/bin" $path )
  typeset -g DOTFILES_NODE_READY=1
fi

if [[ "$(uname -s)" == Darwin ]]; then
  path=(
    $path
    /usr/local/mysql-8.0.31-macos12-arm64/bin
    /opt/homebrew/opt/ruby@3.1/bin
    /Library/Developer/Toolchains/swift-5.9-RELEASE.xctoolchain/usr/bin
    /opt/homebrew/opt/llvm/bin
    /opt/homebrew/opt/openjdk@21/bin
    /opt/homebrew/bin
  )
fi

path=( "$HOME/.local/bin" $path )

alias tm='task-master'
alias taskmaster='task-master'

TENNIS_VISION_DIR="$HOME/code/Tennis-Vision"
tenvis_chpwd() {
  if [[ -n "${VIRTUAL_ENV-}" ]]; then
    deactivate 2>/dev/null
  fi
  if [[ "$PWD" == "$TENNIS_VISION_DIR"* && -f "$TENNIS_VISION_DIR/.venv/bin/activate" ]]; then
    source "$TENNIS_VISION_DIR/.venv/bin/activate"
  fi
}
autoload -U add-zsh-hook
add-zsh-hook chpwd tenvis_chpwd
tenvis_chpwd

path=( "$HOME/.opencode/bin" $path )
[[ -f "$HOME/.local/share/vastai/env.sh" ]] && source "$HOME/.local/share/vastai/env.sh"

[[ -r "$HOME/.config/karardex/meta-ads.env" ]] && source "$HOME/.config/karardex/meta-ads.env"
path=( $path "$HOME/.maestro/bin" )

[[ -r "$HOME/.config/zsh/local.zsh" ]] && source "$HOME/.config/zsh/local.zsh"

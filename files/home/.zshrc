# Managed by ~/code/dotfiles. This preserves the existing plugin set exactly.

export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/tools:$ANDROID_HOME/tools/bin:$ANDROID_HOME/platform-tools"

export GOPATH="$HOME/go"
export GOROOT="/usr/local/go"
export GOBIN="$GOPATH/bin"
export PATH="$PATH:$GOPATH:$GOROOT/bin"
export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/bin/python3.11:$PATH"

# Load/configure Antigen only once in an interactive shell. This prevents
# `source ~/.zshrc` from repeatedly reapplying plugins, while preserving the
# original dynamic Antigen loading path that supplies the current theme/plugins.
if [[ -o interactive && -z ${DOTFILES_ANTIGEN_READY-} ]]; then
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
fi

export PATH="/usr/local/bin:$PATH"

# NVM and Bun initialize once per shell, so a manual .zshrc reload is fast.
if [[ -z ${DOTFILES_NODE_READY-} ]]; then
  export NVM_DIR="$HOME/.nvm"
  [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
  [[ -s "$NVM_DIR/bash_completion" ]] && source "$NVM_DIR/bash_completion"
  [[ -s "$HOME/.bun/_bun" ]] && source "$HOME/.bun/_bun"
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  typeset -g DOTFILES_NODE_READY=1
fi

export PATH="$PATH:/usr/local/mysql-8.0.31-macos12-arm64/bin"
export PATH="/opt/homebrew/opt/ruby@3.1/bin:$PATH"
export PATH="/Library/Developer/Toolchains/swift-5.9-RELEASE.xctoolchain/usr/bin:$PATH"
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"
export PATH="/opt/homebrew/bin:$PATH"

alias tm='task-master'
alias taskmaster='task-master'

TENNIS_VISION_DIR="$HOME/code/Tennis-Vision"
tenvis_chpwd() {
  [[ -n "$VIRTUAL_ENV" ]] && deactivate 2>/dev/null
  if [[ "$PWD" == "$TENNIS_VISION_DIR"* && -f "$TENNIS_VISION_DIR/.venv/bin/activate" ]]; then
    source "$TENNIS_VISION_DIR/.venv/bin/activate"
  fi
}
autoload -U add-zsh-hook
add-zsh-hook chpwd tenvis_chpwd
tenvis_chpwd

export PATH="$HOME/.opencode/bin:$PATH"
[[ -f "$HOME/.local/share/vastai/env.sh" ]] && source "$HOME/.local/share/vastai/env.sh"

[[ -r "$HOME/.config/karardex/meta-ads.env" ]] && source "$HOME/.config/karardex/meta-ads.env"
export PATH=$PATH:$HOME/.maestro/bin

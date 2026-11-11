#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL="$ROOT/install.sh"
PASS=0
FAIL=0

assert() {
  local label=$1
  shift
  if "$@"; then
    echo "ok   $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL $label" >&2
    FAIL=$((FAIL + 1))
  fi
}

linux_path() {
  local fake
  fake=$(mktemp -d)
  cat >"$fake/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "${1-}" == -s ]]; then
  echo Linux
else
  command -v /usr/bin/uname >/dev/null && /usr/bin/uname "$@" || /bin/uname "$@"
fi
EOF
  chmod +x "$fake/uname"
  printf '%s' "$fake"
}

assert "install.sh bash syntax" bash -n "$INSTALL"

if command -v zsh >/dev/null 2>&1; then
  assert ".zshrc zsh syntax" zsh -n "$ROOT/files/home/.zshrc"
else
  echo "skip zsh syntax (zsh not installed)"
fi

tmpdir=$(mktemp -d)
fake_uname_dir=$(linux_path)
trap 'rm -rf "$tmpdir" "$fake_uname_dir"' EXIT

export HOME="$tmpdir"
export PATH="$fake_uname_dir:$PATH"

out=$("$INSTALL" --dry-run --omarchy-baseline 2>&1)
assert "dry-run prints link lines" grep -q 'link.*\.zshrc' <<<"$out"
assert "dry-run prints local.zsh create" grep -q 'create.*local.zsh' <<<"$out"
assert "dry-run no home mutation" test ! -e "$tmpdir/.zshrc"
assert "dry-run no backup dir" test ! -d "$tmpdir/.dotfiles-backups"

printf 'legacy\n' >"$tmpdir/.zshrc"
"$INSTALL" --omarchy-baseline >/dev/null
assert "zshrc is symlink" test -L "$tmpdir/.zshrc"
assert "backup created" test -n "$(find "$tmpdir/.dotfiles-backups" -name .zshrc -print -quit 2>/dev/null || true)"

second=$("$INSTALL" --omarchy-baseline 2>&1)
assert "idempotent unchanged zshrc" grep -q 'unchanged.*\.zshrc' <<<"$second"
assert "no gitconfig link" test ! -e "$tmpdir/.gitconfig"
assert "no pi settings link" test ! -e "$tmpdir/.pi/agent/settings.json"
assert "local.zsh created once" test -f "$tmpdir/.config/zsh/local.zsh"

set +e
"$INSTALL" --omarchy-baseline --pi-only >/dev/null 2>&1
rc=$?
set -e
assert "omarchy+pi-only rejected" test "$rc" -eq 2

if [[ "$(uname -s)" == Darwin ]]; then
  set +e
  env -i HOME="$tmpdir" PATH="/usr/bin:/bin:/usr/sbin:/sbin" "$INSTALL" --omarchy-baseline >/dev/null 2>&1
  rc=$?
  set -e
  assert "omarchy rejected on real Darwin uname" test "$rc" -eq 2
fi

assert "pi worktree-lead unit tests" node --test "$ROOT/tests/pi-worktree-lead.test.mjs"

if [[ "$FAIL" -gt 0 ]]; then
  echo "$PASS passed, $FAIL failed" >&2
  exit 1
fi
echo "$PASS passed, $FAIL failed"

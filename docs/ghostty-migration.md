# iTerm2 → Ghostty migration (Mac)

Status: the user confirmed the exported standalone Mac configuration works well. Shared appearance and Mac-specific shortcuts are stored in this repository and are now installed on the local Mac through a native include wrapper, with a backup of the previous config. Both default and explicit config validation pass with Ghostty 1.3.1. iTerm2, shell startup files and installer code remain unchanged; no app/session was restarted.

## Host-specific adoption plan

Read-only preflight confirmed macOS/arm64 with Zsh, Homebrew and Ghostty 1.3.1 already installed at `/Applications/Ghostty.app`. At inspection, the native Ghostty configuration at `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty` was empty and no `~/.config/ghostty` directory was present. Recheck before applying on any host.

| Category | Action |
| --- | --- |
| Already present — leave alone | Ghostty 1.3.1, Cascadia Code font, iTerm2, Zsh/Antigen and Herdr. No installation or upgrade required. |
| Safe CLI dependency to install | None needed for this migration. |
| Configuration to activate after backup | Shared Ghostty config plus Mac-specific keybindings. For repository-backed activation, approve and back up any existing native config before replacing it with the two-line include wrapper below. |
| Desktop-only config/app to skip | No iTerm preferences changes, terminal-default change, autostart, app launch or additional GUI installation. Linux deployment is deferred until target inspection. |
| Missing prerequisite/decision | Per-host approval for repository-backed activation. Confirm before adding automatic Herdr attachment; it is not part of the appearance migration. |

The general `install.sh` was not changed and was run only with `--dry-run`; its normal rollout covers unrelated shell/agent paths. Automatic Ghostty linking on future hosts should be a separate, reviewed installer change.

## Source and new files

Only appearance fields and relevant key-action metadata from the default iTerm2 preferences profile were inspected. No sessions, credentials, saved shell commands or environment payloads were imported. This is the default profile, not a claim about transient per-window/session overrides.

- Shared: `files/home/.config/ghostty/config.ghostty`
- Mac-only: `files/home/.config/ghostty/macos.ghostty`

For repository-backed activation, the native Mac config should include the shared file first, then the Mac overlay. Substitute the actual absolute checkout path:

```ini
config-file = /absolute/path/to/dotfiles/files/home/.config/ghostty/config.ghostty
config-file = /absolute/path/to/dotfiles/files/home/.config/ghostty/macos.ghostty
```

Keep this machine-specific wrapper outside Git. The Linux profile should use only the shared file, with Linux-specific changes reviewed independently. Alternatively, concatenating the shared file followed by the Mac overlay produces a standalone Mac config with no include-path dependency, as in the phone export.

## Mapped settings

- Cascadia Code Regular at 14pt; Ghostty confirms this family is available.
- Black background, `#bbbbbb` foreground, white default bold text and the 16 iTerm ANSI palette values; bold ANSI text uses bright colors through Ghostty's `bold-color` behavior.
- Selection background `#b5d5ff` with black selected text; gray cursor with white cursor text.
- Transparency `0.0978424202` becomes opacity `0.902158`.
- Blur radius about 21.21 becomes Ghostty intensity 21 as an approximation.
- Non-blinking block cursor; block is the iTerm default because this profile has no explicit cursor-type field. Ghostty shell integration remains enabled, but its prompt-cursor override is disabled.
- New-window grid 80×25, subject to desktop/window-manager constraints.
- Option-left/right → escape-b/f (word movement).
- Command-left/right → Ctrl-A/E (line movement).
- Command-backspace → Ctrl-U; Option-backspace → escape + DEL.
- Forward Delete → Ctrl-D; Option-forward-Delete → escape-d, matching the profile's explicit bindings.
- Shift-Return → literal newline, matching the global iTerm binding.
- Both Option keys otherwise retain normal macOS Unicode entry, matching the profile's `Normal` setting.

## Split-pane visibility

Ghostty-native split separators use `split-divider-color = #212228`. The user requested a true dark-gray inactive background with unchanged text, not a whole-pane tint. Ghostty 1.3.1 exposes no independent inactive-split background color: `unfocused-split-fill` paints an overlay over the whole split, including text. The approximation was therefore removed and `unfocused-split-opacity = 1` disables dimming/tinting. Both pane backgrounds currently retain the configured black; the exact requested iTerm2 effect is not implemented. Reload settings with Command-Shift-comma. Herdr panes are unaffected.

Herdr appearance is intentionally left as it was. An initially applied Herdr border override was reverted locally and in the repository after the user clarified the scope; its server configuration was reloaded without restarting agents.

## Deliberate differences and deferred behavior

- Ghostty measures scrollback in bytes, not lines. The config uses 1,000,000 bytes per surface as an explicit approximation to the profile's 1,000 lines. There is no exact constant conversion; tune after use. Herdr has its own scrollback behavior.
- iTerm's calibrated RGB values are copied numerically to Ghostty's hex colors; color management, font rendering and blur may look slightly different.
- Linux blur is compositor-specific; the Mac intensity does not guarantee the same Hyprland appearance.
- Legacy numeric-keypad mappings and the Insert/Help action were not forcibly translated; test those keys if used. No arbitrary text/command bindings were copied.
- Ghostty retains its native `xterm-ghostty` TERM and default shell-integration behavior except cursor switching. Do not globally force `xterm-256color` solely because iTerm uses it. Test SSH/Herdr first; remote terminfo/fallback behavior needs a deliberate decision. Automatic remote terminfo installation is not enabled by this migration.
- No `command=herdr` or shell startup changes are included. Existing terminal/session ownership must not change as a side effect of copying appearance settings.

## Validation performed

Ghostty 1.3.1 `+validate-config --config-file=<path>` accepted the shared config, the Mac overlay and a temporary wrapper including both. A separate intentionally invalid test file was rejected, confirming the validation actually loaded its input. `+show-face --font-family="Cascadia Code" --cp=65` resolved the expected font. New files passed `git diff --no-index --check`.

The user reported the exported configuration works well when tested remotely. Local activation was then approved: the native wrapper loads the shared config followed by the Mac overlay. Both `ghostty +validate-config` and explicit validation of the native wrapper passed; default `+show-config` confirmed Cascadia Code 14pt, the migrated colors/opacity/blur, scrollback and Option behavior. No GUI was launched or restarted by the assistant. Full keyboard dispatch through Herdr/Pi, SSH and terminal-close persistence should still be checked on each target host. `+show-config` does not accept the same arbitrary config-file argument in this installed build, so it was not used as proof of the merged configuration.

## Local activation record

- Installed wrapper: `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty`.
- Previous empty config backed up to `~/.dotfiles-backups/20261028-152052-ghostty/Library/Application Support/com.mitchellh.ghostty/config.ghostty`.
- No competing `~/.config/ghostty` config existed at activation.
- Restart Ghostty when convenient to apply opacity, which requires a full app restart on macOS. Do not stop the Herdr server merely to reload terminal appearance.

## Activation and rollback on another host (after approval)

1. Recheck the native config and both possible default search locations in case settings changed since inspection.
2. Back up the native config to a timestamped location under `~/.dotfiles-backups/`.
3. Write only the native include wrapper; do not change iTerm2, login shell or running Herdr sessions.
4. Validate the default configuration again, then ask before opening/reloading the GUI.
5. Compare typography/colors, word/line/delete/newline shortcuts, a Herdr/Pi task and SSH. Closing the client must preserve the durable Herdr server/session.

Rollback: restore the backed-up native config, or return to iTerm2 (which remains untouched). The new repository files are additive and can remain unused. No package removal or shell reset is needed.

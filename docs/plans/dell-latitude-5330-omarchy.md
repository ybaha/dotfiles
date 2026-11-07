# Dell Latitude 5330 2-in-1 — Omarchy dev workstation plan

Status: planning; user choices confirmed below. No target laptop inspected; no package installs, configuration rollout or actual disk erase performed/approved by this document. Written 2026-10-28.

## Confirmed choices

- Linux-only Omarchy; no Windows dual boot. Confirm the physical target disk and backups before executing the destructive install.
- Terminal-first workflow: Ghostty is the chosen local terminal, Zsh/Antigen the shell, and Herdr/Pi the main development interface.
- Zed is the default graphical editor for text/code files, opened on demand when using the laptop locally; it is not the main daily development interface and should not autostart. Keep a terminal editor available for headless/SSH editing.
- Enroll the Dell in the existing fleet Go watcher so its online status and available metrics remain visible while headless and across network changes.
- Zsh with the existing Antigen plugin set and `dst` theme is the intended daily shell, subject to Linux compatibility checks. Stock Bash remains a fallback, not the intended final setup.
- Herdr + Pi are mandatory day-one workstation components. A working integrated agent/worktree workflow is a release gate, not optional polish.
- Dual-role machine: local laptop with lid open; remote home dev server with lid closed, releasing desktop RAM rather than merely blanking the display.
- On external power, remain awake and remotely reachable regardless of lid position. Support Ethernet and Wi-Fi with a stable Tailscale identity/address.
- Discover and use the 360-degree convertible's tablet-mode signal if the hardware exposes one. Folded tablet/tent posture must keep the GUI running and must not be mistaken for closing the lid into headless-server mode. Numeric hinge-angle readings are not assumed.
- These choices update the plan; implementation and per-host installation remain separate approval steps.

## Goal and recommendation

Make the Dell primarily a remote home dev server for web/backend development, containers and Pi/Herdr agents, with a normal local laptop mode when needed. Reuse this repository without transplanting a Mac home directory. Keep the Mac available for Xcode, Apple signing, iOS Simulator, and native iOS builds.

Start with stock Omarchy, then add a small, explicit personal layer: Ghostty, portable Zsh/Antigen, the existing Herdr/Pi workflow, fleet monitoring, and Zed for occasional local editing. Laptop reliability and this core workflow come first; desktop styling and tablet ergonomics second. Do not try to recreate every historical Mac tool.

## Evidence and unknowns

Installation media is prepared locally: `~/Downloads/omarchy-4.0.6.iso` (6,448,529,408 bytes), SHA-256 verified against the official manifest: `b542db5fecc37395d9af6654a8146ebed225f275ae4d5a6fcf432e40afe7bb88`. USB flashing has not been performed. Use release 4.0.6 as the initial compatibility baseline; recheck behavior after updates.

The seller lists an Intel Core i7-1265U (12th gen), 32GB soldered RAM, 512GB SSD, Intel Iris Xe, 13.3-inch 1920×1080 touchscreen, 360-degree hinge, two Thunderbolt 4 ports, and US backlit QWERTY keyboard. Listing notes cosmetic wear and a two-year warranty. Confirm the delivered unit; battery health, SSD condition, exact wireless/touch/sensor devices, firmware locks, and Linux compatibility remain unknown.

32GB is useful for several projects, containers, and coding agents. The U-series CPU and small chassis mean sustained builds and battery life need measurement, not assumptions. This is not a CUDA workstation. Avoid planning around large local LLMs.

Local planning host was inspected: macOS/arm64, Zsh, Homebrew, Git, Pi, Claude, gh and monitoring tools available. Dotfiles origin is reachable. The working tree already has substantial unrelated changes, including the installer, shell and agent setup; preserve them. Agree a reviewed revision to commit/push before cloning on the Dell. Uncommitted Mac changes do not travel with a clone.

## Ownership boundaries

| Layer | Owner |
| --- | --- |
| Boot, encryption, desktop, compositor defaults, updates | Omarchy |
| Personal Git/shell helpers, selected desktop overrides, agent source configuration | dotfiles |
| Runtime versions | Prefer Omarchy's mise integration; project-local pins |
| Credentials, machine identity, runtime/session state | This machine only; never Git |
| Project dependencies/services | Project manifests, lockfiles and Compose files |

Use the customization paths belonging to the installed Omarchy release. Do not edit distribution-owned defaults or replace the entire `~/.config` tree. Upstream master and the published web manual currently differ, so verify the downloaded release's behavior/configuration before following commands.

## Dual-role architecture — headless server and local laptop

Omarchy uses Hyprland, not GNOME. Separate the machine's long-lived work from the graphical login session before introducing automatic lid behavior.

### Target behavior

| State | Behavior |
| --- | --- |
| Lid open, on AC | Normal Hyprland laptop; Ghostty/Herdr for development, Zed only when requested; no automatic system suspend. |
| Folded into tablet/tent posture | Keep the display/GUI running; apply only tested touch/rotation/input changes. A tablet-mode signal is not a request to enter headless mode. |
| Lid genuinely closed, on AC | After distinguishing true closure from folded-tablet posture, stop the graphical session and, where appropriate, the display manager to reclaim memory; keep networking, SSH, Herdr/Pi sessions and selected development services running. |
| Lid reopened | Restore the graphical login interface; require authentication. Reattach existing Herdr work rather than starting duplicate agents. Applications terminated for headless mode need reopening; the old desktop process state is not retained. |
| Lid closed, on battery | Proposed: suspend after a short grace period to prevent bag overheating/battery exhaustion. User confirmation pending; remote access is unavailable while suspended. |
| AC lost while lid already closed | Re-evaluate policy on power-source change, not only on lid events. Allow a short outage grace period, then apply the agreed battery/critical-battery policy. |
| Ethernet unplugged/Wi-Fi used | Retain the same Tailscale node/IP and DNS name; brief connectivity interruption is possible. Long-lived work survives outside the connection. |

### Persistence and desktop teardown

- Run `tailscaled`, the approved SSH service and networking independently of a graphical login. Use appropriately scoped system/user services for dev workloads and a persistent Herdr server. Enable user lingering only where needed and approved; verify actual process/cgroup ownership. Lingering alone does not move GUI-owned processes into persistent services.
- Herdr's installed CLI describes a persistent client/server session and a headless server mode. Ghostty is only a graphical client host: closing its window must detach the client while the Herdr server, panes and Pi tasks continue. Explicitly closing a Herdr pane/session or stopping its server is a different, destructive action.
- Start/supervise the Herdr server independently of the graphical session; do not assume a server auto-started from a GUI terminal already has that lifecycle. Verify survival after Ghostty closes, after the final SSH disconnect, and after full graphical logout. Reopen Ghostty or connect over SSH and attach to the same named session, without duplicate agents. Never stop the Herdr server as part of desktop teardown.
- Do not use a broad `terminate-user`/kill-all-user-processes operation or blindly isolate a system target. Stop only the identified graphical session/display services after checking their dependencies and teardown behavior.
- Lid policy must live outside Hyprland so lid-open events can restart the login interface after Hyprland exits. Use a small, auditable event/service mechanism with debouncing and power-state handling; reconcile it with logind, desktop idle policies and inhibitors. `HandleLidSwitch=ignore` only prevents logind sleep; it does not terminate the desktop or free its RAM.
- Closing a desktop is a real logout: it can terminate Zed, browsers, unsaved buffers, desktop terminals and GUI-auth dependencies. Add a short grace/cancel path and clear warning; verify Zed recovery/autosave preferences before enabling automatic teardown. Do not claim seamless preservation of GUI applications.
- Check every required provider in headless mode. In particular, the locally authenticated Cursor IDE proxy is not proven Linux/headless-compatible; inspect whether it needs an active IDE/keyring/GUI. If it does, explicitly choose an approved independent provider-host design or revise the GUI-off requirement rather than keeping a hidden desktop or silently changing model routes.
- Primary remote workflow is SSH/Herdr/Pi. Zed remote development is optional, not required. Remote desktop/screen sharing needs a graphical session and is not available in the GUI-off state without a separate explicitly designed solution.

### Terminal and editor behavior

- Ghostty is the preferred local terminal, not an additional session manager. Reuse portable fonts/keybindings after review; do not require Ghostty or any GUI for headless work. A remote computer may use its own terminal to SSH into the same Herdr server.
- Keep Zsh/Antigen startup and mise/tool PATH correct inside Herdr panes. Desktop launchers and Ghostty config should attach to the designated persistent Herdr session rather than creating an accidental parallel workspace on every window.
- Set Zed as the default graphical text/code opener using the installed desktop entry and appropriate MIME associations. Do not set every shell's `EDITOR`/`VISUAL` unconditionally to a GUI-only command: use a headless-safe terminal editor (proposed Neovim) for SSH, Git commit messages and maintenance, with an explicit Zed command available locally. Confirm a different terminal-editor preference before changing it.
- Do not autostart Zed or keep a hidden GUI solely to satisfy an editor default. Validate explicit file opening, waiting behavior where needed, and that SSH editing does not launch or hang on an unavailable desktop.

### Network design

- The seller lists no built-in RJ45 port; plan for a Linux-supported USB-C/USB-A gigabit Ethernet adapter or compatible dock, then confirm the delivered hardware.
- Use NetworkManager for both Ethernet and Wi-Fi, with Ethernet preferred through route metrics and a tested saved Wi-Fi autoconnection fallback. Keep Wi-Fi enabled while wired if prompt fallback matters. Wi-Fi, DNS and any necessary secrets must be available before GUI login, not depend on unlocking a desktop keyring. Captive portals/new networks still need setup.
- Run Tailscale as a boot service with persistent local node state. Its `100.x.y.z` address and MagicDNS name are independent of DHCP/public addresses and normally stay the same across Ethernet/Wi-Fi/router changes. Do not re-enroll/delete the node or discard its state during a switch. No static LAN address is needed for Tailscale access.
- Coordinate firewall rules and tailnet ACLs for SSH/dev services. Do not expose SSH or dev ports through router port forwarding. Review node-key expiry for unattended use; any exception is a deliberate security decision, not an automatic default.
- A stable Tailscale address does not guarantee zero packet loss or uninterrupted SSH during handover. Test both directions while running a real agent/build; reconnect to the same durable workspace if necessary. No connectivity is possible when both links or upstream Internet are unavailable under the chosen network topology.

### Recovery and physical operation

- Encrypted cold boots still require unlocking before Linux/Tailscale starts. Initially plan local unlock after reboot/power loss; remote initramfs unlock/TPM unlock would be a separate security design. An awake closed-lid server is not automatically an unattended-reboot server.
- Use a ventilated stand with vents clear; stress-test closed-lid temperatures, fan behavior and performance. Never keep it awake in a bag. Use a supported Dell battery charge limit for sustained AC use if available, and plan safe critical-battery shutdown/hibernate behavior.
- Acceptance: measure memory before/after desktop teardown; prove an active Pi task, Herdr panes, SSH and required services survive; reopen and reauthenticate; test wired-to-Wi-Fi and back; test power loss while already closed and recovery after reconnecting AC. Do not promise automatic wake from an already suspended state without hardware testing.

## Phase 0 — before arrival

1. Prepare for the confirmed Linux-only install. Inventory anything to preserve first; retain recovery/install media as appropriate. Confirm the exact target disk immediately before erasing it.
2. Pick a reviewed dotfiles revision and a small initial project set. Preserve/review existing local changes rather than bulk-committing the whole tree.
3. Download complete: official Omarchy 4.0.6 ISO and SHA-256 manifest are in `~/Downloads`, and the checksum matches. Flashing is still pending: inspect and confirm the USB target explicitly before writing, since flashing erases it. Keep recovery media. PGP signature verification has not been performed.
4. Prepare Ghostty + portable Zsh/Antigen + Herdr/Pi as the main interface, Zed as the on-demand graphical text editor, and fleet watcher enrollment. Decide separately whether the Mac remains an always-available build host.

## Phase 1 — acceptance checks before erasing anything

- Inspect chassis, hinges throughout their travel, screen/touch, keyboard, trackpad, webcam, speakers/mic, charging and ports.
- Check BIOS/admin locks and any remaining organization/device-management enrollment. Resolve ownership/lock concerns before installing.
- Run Dell preboot diagnostics; inspect battery health/capacity, charging, SSD health and installed hardware. Check firmware updates with Dell-supported methods; use fwupd only where this unit is supported. Keep stable AC power during firmware updates.
- Boot Linux media to test Wi-Fi, Bluetooth, audio, camera, touch and external display/USB-C charging. A live test helps but does not prove installed suspend behavior.
- Record firmware and storage settings. If RAID/RST prevents disk detection, verify the appropriate AHCI setting for the Linux-only install before changing it.
- Before the wipe, finish any necessary data recovery/backups; boot/security/storage changes may affect access to an existing encrypted Windows installation.

## Phase 2 — install a boring, recoverable base

Use the current stable Omarchy installer's full-disk encrypted layout for the confirmed Linux-only setup. Full-disk mode is destructive: confirm the physical target disk and completed backups immediately before execution. No Windows partition or dual-boot work is planned.

Review Secure Boot requirements for that ISO. Do not clear the TPM or disable unrelated security controls merely as a generic Linux step. Keep a strong encryption passphrase and offline recovery information; verify encryption and lock behavior after installation.

Update using Omarchy's supported update path, reboot, then establish a baseline before dotfiles. Understand snapshot restore and test access to recovery. Snapshots are not backups; current Omarchy documentation says root snapshots do not restore `/home` or personal configuration.

Test:

- Several suspend/resume cycles on battery and AC; lid close/open; overnight battery drain.
- Wi-Fi/Bluetooth reconnection, audio, webcam and display after resume.
- External monitor/dock hotplug, charging, fractional scaling only if needed; start near native scaling.
- Lock on suspend and idle; failed unlock behavior; encrypted reboot.
- Existing power service/profile behavior. Do not stack TLP/auto-cpufreq over the installed power daemon.
- Swap/zram and out-of-memory behavior. Hibernation is optional and requires disk-backed swap and tested resume; zram alone cannot provide it. Current upstream setup reserves roughly RAM-sized disk space (32GB+) for hibernation.

## Phase 3 — read-only host preflight and approved adoption

On the Dell, repeat the repository's required preflight, not the Mac's results:

```sh
uname -srm
cat /etc/os-release 2>/dev/null || true
id
printf 'shell=%s\n' "${SHELL:-unknown}"
command -v git zsh brew apt-get mise pi claude gh antigen btop htop || true
```

Also inspect package-manager state, existing destination paths, shell startup files, Git status/reachability, and installed tool versions without reading secrets. Present a host-specific adoption list for approval before package installs, replacement links, login-shell changes or service restarts.

Candidate classification (provisional until inspected):

| Category | Candidates and action |
| --- | --- |
| Already present — leave alone | Omarchy desktop/config defaults, existing Git/CLI utilities, mise, Docker/Compose, editor/agents if supplied by that release. Check binaries and versions first. |
| Safe CLI dependency candidates | Missing Zsh, Antigen and required plugin dependencies, Herdr, the exact Pi distribution, fleet agent, build tools, Node LTS, pnpm, Bun where used, Python/uv, project-required Go/Rust, monitoring tools. Inspect existing versions, then approve the appropriate package/runtime source; no Linux Homebrew baseline. |
| Configuration to link after backup | Reviewed Git config/ignore, portable Zsh startup files and Antigen setup, Herdr config, Pi instructions/agents/skills/extensions, selected Claude config/hooks. Review each target, dependencies and host paths first. |
| Desktop-only config/app to skip | Homebrew casks, iTerm/macOS defaults, archived macOS VS Code settings, Apple SDK/toolchain paths and unnecessary desktop tweaks. Zed for Linux is explicitly selected; reuse portable Zed settings only after auditing paths, keybindings and language-server commands. |
| Missing prerequisite, credential or decision | Dell hardware evidence, final target-disk confirmation, reviewed repo revision, private Git access, per-host provider logins, bridge support, first projects, Mac build-host availability and selected optional integrations. |

Installer facts verified in the current working tree:

- Default Linux install links `.zshrc`, `.zprofile` and `.zshenv`; it does not install Linux packages.
- `--packages` requires Homebrew, including on Linux; do not use it as an Arch bootstrap.
- `--pi-only` avoids shell/Git linking but still links shared Pi settings/models/extensions/skills, shared skills, and preview-hub resources. It is not an automatically safe minimal profile.
- Existing targets are backed up under `~/.dotfiles-backups/<timestamp>/` unless `--force` is used. Never use `--force` for this rollout.
- Normal install invokes `bin/link-external-skills`; audit its source-repository expectations before using it.

Begin any approved rollout with `./install.sh --dry-run`. The Pi-only dry run can also be reviewed separately. Do not execute the full installer unmodified on the Dell merely because the dry run completes.

### Proposed dotfiles work — not yet approved

1. Add an explicit Omarchy profile/selection mechanism to `install.sh`: reviewed config groups for Ghostty, Zsh/Antigen, on-demand Zed and the Herdr/Pi baseline, plus explicit optional preview/skill integration. Preserve existing Mac behavior. Linking shell config and changing the account login shell are separate actions; switch only after validation and host approval.
2. Split portable shell helpers from Mac paths. Current `files/home/.zshrc` includes `~/Library/Android/sdk`, `/opt/homebrew`, macOS MySQL/Swift/Java paths, NVM/Bun initialization and unconditional Antigen sourcing. Guard Mac paths by OS or move them to ignored local config. Preserve the Antigen bundle list and `dst` theme; verify plugin dependencies on Linux, report obsolete/unavailable components and ask before dropping/replacing them. Bootstrap Antigen explicitly and guard missing optional tools so startup stays usable. Prefer mise for Node on the Dell and disable NVM initialization there; retain the Mac's existing runtime setup. Activate mise using its Zsh integration; do not source Omarchy's Bash configuration into Zsh. Preserve the desktop's login/session environment.
3. Audit agent config and helper scripts for `/Users/baha`, Apple utilities, launchd, BSD/GNU command differences and locally installed bridge paths. Do not import Mac auth or session data. Inspect credential-free configuration only.
4. Add a small Linux CLI manifest and optional Omarchy desktop overrides, never a wholesale copy of Omarchy defaults. GUI packages remain explicit opt-ins.
5. Validate shell syntax, interactive/login startup, no missing-source errors, plugin/completion/theme behavior, PATH order and runtime selection. Cover installer dry runs against temporary homes, backup/idempotence, Mac regression behavior and missing optional dependencies. Check files created indirectly by helper scripts. Verify Ghostty/Herdr uses the intended Zsh environment and reconnects to the persistent server. Test Zed's default graphical file associations and headless-safe terminal editor behavior; GUI-launched tools may have a different PATH.

## Phase 4 — development stack and real workload proof

Start with:

- Git + gh; Ghostty as local terminal with persistent Herdr/Pi sessions. Zed is the default graphical text/code editor on demand; Neovim is the proposed terminal editor for headless use. Review the repo's Zed settings and selectively reuse portable preferences rather than skipping all Zed config or blindly linking the existing file. Test Wayland rendering, clipboard, file associations, language servers and file watching without making Zed a background dependency.
- Portable Zsh + Antigen with the existing plugin set/theme, and the mandatory Herdr/Pi integration described below. Bring these up before expanding the project/tool inventory. Cursor IDE/proxy, if required by the chosen provider route, is a separate dependency rather than the preferred local editor.
- Node LTS through mise, pnpm, Bun only for projects that use it; Python/uv for scripts/services. Respect existing project versions before updating anything.
- Docker Engine + Compose; databases per project, bound to loopback unless deliberately shared. Inspect Omarchy's actual Docker permissions first. Docker group access is root-equivalent; choose explicitly rather than enabling it casually.
- Tailscale for stable remote access to this Dell over Ethernet or Wi-Fi, plus Mac/server access and HTTPS previews. Follow the dual-role architecture above: boot-level connectivity, persistent node identity, scoped SSH/access policy and durable sessions. No broad public dev-port exposure. Review which previews need authentication.
- Android SDK/emulator only when needed. Inspect KVM availability, then test one representative Android/Expo workflow. Linux cannot run Xcode or iOS Simulator; use the Mac or an approved remote build service for native iOS builds.

Re-clone repositories, reinstall dependencies and rebuild native artifacts for Linux/x86_64. Do not transfer Mac `node_modules`, virtualenvs, caches, databases or binaries. Migrate necessary database data with explicit exports/restores. Keep project services stopped when unused.

Proof of readiness: run one real frontend, backend+database and test/build workload; verify browser hot reload, container networking, screen sharing under Wayland and an end-to-end preview from another device. Then add remaining projects incrementally.

## Phase 5 — mandatory day-one Pi/Herdr and local authentication

This is part of the minimum viable workstation, not a later optional phase: establish it alongside Zsh and Ghostty before bulk project migration. Zed is optional during normal terminal-first work. Inspect what Omarchy already supplies before installing another Pi/Herdr or provider CLI. Confirm exact Pi distribution/package and versions rather than treating all similarly named agents as interchangeable.

Use this repo's chosen routing: Claude through claude-bridge where supported; approved implementation through Cursor IDE proxy/composer-2.5, not Cursor agent CLI. Verify Linux availability, login method, extension dependencies and proxy support independently. A model entry in config is not a working provider. Don't silently substitute a paid API or different subscription route if a bridge is unavailable.

Authenticate privately on the Dell with new host identity/keys; never copy the Mac's auth/session directories. Install/update integrations only after approval. For Herdr setup, consult its skill before control actions; install Pi integration per machine and verify integration/plugin status. One durable agent per workspace, one writer per worktree.

Acceptance gate: launch Pi inside a Herdr workspace using the intended Zsh environment; verify shared instructions, extensions, skills and agent definitions; test the approved provider routes; create one isolated worktree/task and verify its changes, status reporting and cleanup. Verify exact session resume after restarting a pane/session. Any unavailable bridge/integration is a blocker requiring an explicit decision, not a silently omitted component. Start with two active agent tasks; measure RAM/CPU/thermals and increase deliberately rather than spawning a large swarm. Keep tests one-shot and bounded.

## Phase 5b — enroll in the existing Go fleet watcher

Repository verified: `~/code/tailscale-fleet`. One `fleet` binary provides the hub and agent roles; reuse the existing hub, not a second dashboard on the Dell.

### Enrollment design

- Hub discovery reads `tailscale status --json` (including visible peers) and refreshes periodically. There is no application-level enrollment allowlist. The Dell must join the same tailnet and be visible to the hub under the actual tailnet policy.
- Choose a unique stable Tailscale DNS label (proposed `dev-dell`, subject to confirmation); this label is what the dashboard displays. Preserve the node identity across Ethernet/Wi-Fi changes.
- Deploy the reviewed Linux amd64 build through the repository's existing `deploy/install.sh` agent path, only after target-host inspection and installation approval. The template uses `/usr/local/bin/fleet agent` as `fleet-agent.service`, starts after networking/Tailscale, restarts on failure and is enabled under `multi-user.target`; it does not depend on Hyprland, Ghostty, Zed or an SSH session.
- Inspect service privileges before rollout: the current system unit has no `User=` and thus runs as root. Do not mistake `NoNewPrivileges=true` for non-root operation. Decide separately whether to adopt the existing template or approve a tested least-privilege adjustment; do not change fleet deployment behavior as incidental dotfiles work.
- Agent exposes `/healthz` and `/stats` on tailnet addresses, TCP 9477. Permit only the hub's approved identity/source through tailnet policy and the host firewall. The agent has no application-level authentication; never publish this port through the router or a public proxy.
- Metrics include CPU/model/load, RAM/swap, disk usage, uptime/platform/kernel, and temperature/battery when the Linux hardware exposes them. Lid position/GUI mode are not currently reported; don't promise those indicators without a separately scoped watcher change.

### Acceptance tests

1. Verify `fleet-agent.service` is enabled/running and starts before graphical login after an unlocked boot.
2. From the existing hub, request the Dell's tailnet `/healthz` and `/stats` with a bounded timeout; confirm valid samples and intended firewall/ACL boundaries.
3. Confirm one uniquely named Dell entry appears with updating metrics in the existing dashboard. Discovery is periodic, not instantaneous; distinguish `no-agent`/`stale`/`offline` from healthy data.
4. Close Ghostty, disconnect SSH and shut down the graphical session. Verify dashboard samples and uptime continue while an agent task runs.
5. Unplug Ethernet with saved Wi-Fi enabled, then reconnect it. Verify the same Tailscale identity/address and dashboard entry recover without duplicate enrollment. A brief stale interval is acceptable during network transition; require recovery to live samples.
6. Verify the agreed battery suspend behavior is represented honestly as unavailable/offline rather than expecting monitoring to keep a suspended laptop reachable.

No enrollment, remote configuration or watcher code changes have been performed during planning.

## Phase 6 — 360-degree hinge and tablet mode

### What Omarchy 4.0.6 already provides

Checked the downloaded ISO's matching source release, `v4.0.6`, commit `237f1b4071a0bff2296c6d740ba2b9fd695ebfa0`. This is a source/configuration review, not a hardware test of the Dell.

| Capability | Release evidence / conclusion |
| --- | --- |
| Basic touchscreen discovery and manual toggle | Present: `bin/omarchy-hw-touchscreen`, `omarchy-toggle-touchscreen`, and `omarchy-toggle-input-device`. The discovery helper includes Hyprland touch/tablet devices; that does not mean it detects a folded convertible. |
| Manual touchpad enable/disable/toggle | Present, including bindings in `default/hypr/bindings/media.lua`. |
| Automatic 360-degree fold / `SW_TABLET_MODE` handling | No Omarchy-specific implementation found in this release. Firmware/kernel/libinput behavior remains hardware-specific and may provide part of the functionality without an extra Omarchy script. |
| Automatic orientation and matching touch-coordinate rotation | No integrated IIO sensor/auto-rotation workflow found in the reviewed release source/configuration. Additional supported configuration may be possible after inspecting sensors. |
| General-purpose on-screen keyboard | None found bundled/configured in the reviewed release source/package manifests. Select one only after confirming need and compatibility. |
| Automatic keyboard/trackpad suppression when folded | No Omarchy-specific fold-triggered automation found. First test what Dell firmware and the Linux input stack already do; avoid duplicating working behavior. |
| Lid-close handling | Present, but not our custom headless behavior: `omarchy-system-lid-close` locks on a confirmed closed lid without external monitors and reconciles clamshell displays. It does not itself stop the desktop or implement our AC/battery policy. Audit its event wiring and logind/idle interactions before adding the headless rule. |

Conclusion: basic touch and manual input controls are available; a polished automatic convertible workflow is not established out of the box by the Omarchy 4.0.6 source. This does not prove that the underlying Linux/Hyprland stack or the delivered Dell lacks the necessary hardware support. Recheck the installed release after updates.

### Arrival-day discovery — do this before adding automation

1. Inspect input devices and switch capabilities, then observe only the relevant switch device while moving between laptop, tent and fully folded positions. Look for Linux `EV_SW` / `SW_TABLET_MODE` values (`0` laptop, `1` tablet). Use a bounded diagnostic session; do not collect normal keyboard typing or leave input monitors running.
2. Test `SW_LID` independently by genuinely closing the screen. A binary tablet-mode threshold is not a numeric angle, and it need not mean precisely 360 degrees. The 360-degree hinge alone guarantees neither a tablet-switch event nor readable continuous-angle data.
3. Confirm keyboard/trackpad suppression and restoration with stock firmware/input behavior. Test after resume too. Do not install a replacement sensor/input daemon just because it appears on a generic convertible guide.
4. Inspect IIO/orientation sensor availability separately. A tablet-mode switch does not establish that an accelerometer or auto-rotation exists. Test touch input and monitor mapping before changing transforms.
5. If no usable fold switch exists, record that limitation and use an explicit manual tablet-mode control if wanted; do not infer folding from a lid-close event or invent an angle reading.

### Desired behavior and safe optional additions

- **Laptop:** normal keyboard/trackpad and GUI.
- **Tablet/tent:** GUI stays alive. Disable built-in keyboard/trackpad only if necessary and reliably reversible; never indiscriminately disable external input devices. Add an approved on-screen keyboard only if needed.
- **Rotation:** add sensor-based rotation only if supported and stable. Update display orientation and touch-coordinate mapping together; provide orientation lock/manual fallback. Validate portrait, landscape, dock/external-display mapping and resume behavior.
- **Actual lid close:** use the separately tested headless/AC policy, not the tablet-mode state. Guard against transient/conflicting events while folding and ensure unfolding cannot leave the GUI off or inputs disabled.
- Implement any approved extras as small user overrides/services appropriate to the installed Hyprland release, not modifications to Omarchy-owned defaults. Avoid competing event handlers; preserve lock, clamshell, and security behavior.

Acceptance: laptop → tent → tablet → laptop, plus actual close/open, must produce distinct correct states without killing Herdr/Pi or an active build. Repeat on AC and battery, with a dock, and after sleep/resume. Test lock-screen input and encrypted-boot unlock separately; keep an external input/recovery route. Cosmetic tablet polish may remain optional, but safe separation of tablet folding from headless lid-close automation is required before enabling that automation.

## Backup, recovery and steady state

- Establish encrypted, versioned off-device backups of `/home` data and project exports; test a restore. Sync/Nextcloud is not by itself a versioned disaster-recovery strategy.
- Track configuration source, not runtime state; exclude credentials, provider auth, sessions, browser databases, histories, caches and sockets.
- Keep useful free SSD space (roughly 15–20% target); monitor Docker layers/volumes, SDKs and snapshot retention. No automatic volume deletion. Consider a larger SSD after measuring real pressure, not before the first working setup.
- Use supported full-system Omarchy updates; avoid partial Arch upgrades. Update before a convenient recovery window, not before a deadline. Keep rescue media available.
- Roll back dotfile adoption by removing only the new managed symlink and restoring its recorded backup. System snapshots do not replace those config backups. Keep Mac access until the Dell passes a normal work week.

## Definition of done

Linux-only encrypted boot and recovery understood; dependable sleep/wake and hardware; Ghostty/Herdr is the primary local development interface; Zed opens text/code files by default in graphical mode without being required headlessly; Zsh/Antigen retains the agreed plugin/theme behavior without Mac-specific startup failures; Herdr/Pi integration, provider routes, session resume and an isolated worktree workflow pass; active agents/services survive terminal closure, GUI teardown and reconnect; lid-open restores authenticated local use; wired/Wi-Fi handover preserves Tailscale identity; the fleet watcher shows the Dell and updates metrics while headless; tablet folding is distinguished from actual lid closure before headless automation is enabled; AC/battery transitions follow the agreed policy; real projects build/test; private remote access and previews work; backups restore successfully. Tablet extras may remain deferred without blocking the workstation.

## Remaining decisions

1. First three projects to validate?
2. Keep the Mac for local Apple builds, and will it be reachable when traveling?
3. Is tablet mode essential on day one, or secondary?
4. Approve a bounded dotfiles portability implementation separately from installation on the Dell?
5. Confirm proposed closed-lid battery policy: short grace then suspend, including when AC is disconnected while already closed. Keeping it remotely awake on battery is a separate explicit choice.
6. Is local unlock after encrypted reboot acceptable initially, or is unattended reboot recovery essential?
7. Confirm the unique fleet/Tailscale label (proposed `dev-dell`) and terminal-editor fallback (proposed Neovim).

## Sources

- Seller: https://www.estunt.nl/product/dell-latitude-5330-2-in-1-32gb/
- Omarchy authoritative manual source: https://github.com/basecamp/omarchy/tree/master/manual
- Tablet support review pinned to the downloaded release: https://github.com/basecamp/omarchy/tree/237f1b4071a0bff2296c6d740ba2b9fd695ebfa0
- Release touchscreen discovery: https://github.com/basecamp/omarchy/blob/237f1b4071a0bff2296c6d740ba2b9fd695ebfa0/bin/omarchy-hw-touchscreen
- Release touchscreen toggle: https://github.com/basecamp/omarchy/blob/237f1b4071a0bff2296c6d740ba2b9fd695ebfa0/bin/omarchy-toggle-touchscreen
- Release input-device toggles: https://github.com/basecamp/omarchy/blob/237f1b4071a0bff2296c6d740ba2b9fd695ebfa0/bin/omarchy-toggle-input-device
- Release manual touchpad bindings: https://github.com/basecamp/omarchy/blob/237f1b4071a0bff2296c6d740ba2b9fd695ebfa0/default/hypr/bindings/media.lua
- Release lid-close handler: https://github.com/basecamp/omarchy/blob/237f1b4071a0bff2296c6d740ba2b9fd695ebfa0/bin/omarchy-system-lid-close
- Getting started: https://github.com/basecamp/omarchy/blob/master/manual/02-getting-started.md
- Development tools: https://github.com/basecamp/omarchy/blob/master/manual/18-development-tools.md
- Dotfile ownership: https://github.com/basecamp/omarchy/blob/master/manual/31-dotfiles.md
- Sleep/hibernation: https://github.com/basecamp/omarchy/blob/master/manual/36-system-sleep.md
- Snapshots: https://github.com/basecamp/omarchy/blob/master/manual/47-system-snapshots.md
- Tailscale stable addressing: https://tailscale.com/kb/1033/ip-and-dns-addresses
- systemd lid/power/inhibitor behavior: https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html
- Local evidence: `AGENTS.md`, `install.sh`, `files/home/.zshrc`, `docs/agent-stack/README.md`, `docs/agent-stack/HERDR.md`, `docs/agent-stack/PROVIDERS.md`; installed `herdr --skill` and `herdr --help` for persistent client/server and remote-session boundaries.
- Fleet evidence: `~/code/tailscale-fleet/README.md`, `internal/hub/discovery.go`, `deploy/fleet-agent.service`; scoped read-only investigation of agent endpoints, collection and deployment behavior.

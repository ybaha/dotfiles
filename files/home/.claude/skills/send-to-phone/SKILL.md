---
name: send-to-phone
description: "Upload a file to the user's Nextcloud AI-Inbox folder so they can review it on their phone. Use when asked to 'send it to my phone', 'put it on Nextcloud', 'upload to Nextcloud', 'share to phone', or for a doc they want to read away from the desk."
---

# /send-to-phone

Run `~/.claude/skills/send-to-phone/scripts/nc-upload FILE...`, or add `-d SUBDIR` to group related files. It prints one link per file; give the user the file name and link.

- Content not in a file yet: write it to a scratch file first, named for what it is (`trip-plan.md`, not `output.md`).
- Prefer `.md` (renders in the Nextcloud app) or `.pdf`. `.html` opens as a download, not a page.
- A same-named upload overwrites; Nextcloud keeps the previous version.
- The credential belongs to Nextcloud user `agent` and reaches only AI-Inbox (owned by `baha`, shared to `agent`). A 401 is a credential problem, not a missing folder.

## New machine

Your network values (`NC_AGENT_URL`, `NC_HOME_SSH`) live in untracked `~/.config/pi-agent/local.env`; `install.sh` creates it from `local.env.example`.

The token is an app password per machine, kept in the macOS login Keychain (service `nextcloud-agent`) and never in this repo. Mint and store one:

```sh
source ~/.config/pi-agent/local.env
security add-generic-password -U -s nextcloud-agent -a agent -w "$(ssh "$NC_HOME_SSH" \
  "pct exec 101 -- /snap/bin/nextcloud.occ user:auth-tokens:add agent --name=$(hostname -s) -n" | tail -n1)"
```

`NC_AGENT_TOKEN` overrides the Keychain for a single run. To retire a machine, find its token with `occ user:auth-tokens:list agent` and remove it with `occ user:auth-tokens:delete agent <id>`.

## Where it lives (for repairs only)

- Nextcloud snap in LXC 101 (`<lxc-lan-ip>`) on the Proxmox host `home`. As root there, `occ` is `pct exec 101 -- /snap/bin/nextcloud.occ`.
- `$NC_AGENT_URL` is `tailscale serve` on `home`, proxying to `http://<lxc-lan-ip>:80`. Nextcloud trusts `<home-lan-ip>` as the proxy.

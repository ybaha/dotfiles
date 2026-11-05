---
name: send-to-phone
description: "Upload files to the user's Nextcloud AI-Inbox, organized by project and topic, for phone review. Use when asked to 'send it to my phone', 'put it on Nextcloud', 'upload to Nextcloud', 'share to phone', organize AI-Inbox, or for a doc they want to read away from the desk."
---

# /send-to-phone

Run `~/.pi/agent/skills/send-to-phone/scripts/nc-upload -d PROJECT/TOPIC[/SUBFOLDER...] FILE...`. The destination is required. It prints one link per file; give the user the destination path and link.

## Folder structure

Always organize uploads as `AI-Inbox/<project>/<topic>/[related folders]/<file>`:

```text
AI-Inbox/
  karardex/
    marketing/reels/series/final-v1/
    design/
    development/
  rooma/
    support/refund-d3387/
    testing/prompt-benchmark/
    development/
  postmixr/
    design/landing-page/
    development/recovery/
  glb/testing/2026-10-18/
  handheld/archive/2026-10-22/
  point-blank/archive/
  poshet/marketing/open-graph/
  theory-exam/study/screenshots/
  dotfiles/testing/
```

- **Project first:** reuse the canonical project/repository name, not a campaign, task, date, worktree, or filename. For example, use `karardex/marketing`, never a top-level `karardex-reels`. Infer the project from the actual work being shared, not an unrelated current directory. Ask if ownership is unclear.
- **Topic second:** use the most relevant existing folder, such as `marketing`, `design`, `development`, `testing`, `support`, `research`, `docs`, `study`, or `archive`. Do not create empty template folders for every project.
- **Related folders below:** keep campaigns, cases, versions, and dated batches together under their topic. Dates are optional subfolders, not projects or substitutes for topics. Avoid generic dumping grounds such as `latest-uploads`, `misc`, or `inbox`.
- Use lowercase kebab-case for every folder component; preserve meaningful filenames. The uploader rejects root uploads, project-only destinations, absolute paths, traversal, empty components, spaces, and uppercase folder names.
- When browsing or reorganizing existing contents, use Nextcloud WebDAV under the AI-Inbox share only. Inspect existing folders before choosing a destination. Use server-side `MOVE` with `Overwrite: F`, never overwrite during cleanup; preserve file IDs and file links, keep a local move journal, and verify the file inventory afterward. Keep self-contained bundles intact so relative links still work. Do not delete files or merge uncertain duplicates. Leave empty folders rather than using recursive WebDAV `DELETE`, which could race with another upload.

Examples:

```sh
~/.pi/agent/skills/send-to-phone/scripts/nc-upload -d karardex/marketing/reels/campaign-name caption.md preview.mp4
~/.pi/agent/skills/send-to-phone/scripts/nc-upload -d rooma/support/case-id reply.md
~/.pi/agent/skills/send-to-phone/scripts/nc-upload -d postmixr/design/landing-page desktop.png mobile.png
```

## Upload notes

- Content not in a file yet: write it to a scratch file first, named for what it is (`trip-plan.md`, not `output.md`).
- Prefer `.md` (renders in the Nextcloud app) or `.pdf`. `.html` opens as a download, not a page.
- A same-named upload overwrites; Nextcloud keeps the previous version.
- The credential belongs to Nextcloud user `agent` and reaches only AI-Inbox (owned by `baha`, shared to `agent`). A 401 is a credential problem, not a missing folder.

## New machine

Tailscale SSH must already work to `$NC_HOME_SSH` — see `docs/agent-stack/TAILSCALE-SSH.md` for the one-time ACL/host setup. Your network values (`NC_AGENT_URL`, `NC_HOME_SSH`) live in untracked `~/.config/pi-agent/local.env`; `install.sh` creates it from `local.env.example`.

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

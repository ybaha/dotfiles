# Tailscale SSH — first-time host setup

Tailscale SSH is required for portable skill scripts (for example `send-to-phone`,
which mints the Nextcloud app password over `$NC_HOME_SSH`, set in `~/.config/pi-agent/local.env`).
Without it, SSH from this Mac to `home`, `<laptop>`, and `<vps>` keeps falling back to
plain `sshd`, which has no record of `baha@<this machine>` and re-prompts every time.

Two changes are needed, both **per tailnet** (once) and **per Linux host** (once).

## 1. Tailnet ACL — once

Edit the policy at <https://login.tailscale.com/admin/acls/file>. Add or replace the
`ssh` block (everything else in the file stays):

```json
  "ssh": [
    {
      "action": "accept",
      "src": ["autogroup:members"],
      "dst": ["home", "<laptop>", "<vps>"],
      "users": ["autogroup:nonroot", "root", "baha"]
    }
  ],
```

> Note: `dst` for SSH rules accepts hostnames, `tag:*`, IPs, or `autogroup:self`.
> `autogroup:members` is only valid in `src`; using it in `dst` is a policy parse error.

Without an explicit `accept` rule, Tailscale SSH defaults to deny and every session
demands a browser approval at `https://login.tailscale.com/a/<hash>`.

A narrower alternative: tag the Linux boxes `tag:server` in the admin console, then
use `dst: ["tag:server"]` and add a second rule that allows `root` only on `home`
(needed by the `send-to-phone` Nextcloud mint). Keep this in sync as you add or
remove Linux boxes.

## 2. Linux host — once per host

Easiest path is the admin console web terminal, so the bootstrap does not depend on SSH
already working:

- `home`: `https://login.tailscale.com/admin/machines/<tailscale-ip-of-home>`
- `<laptop>`: `https://login.tailscale.com/admin/machines/<tailscale-ip-of-laptop>`
- `<vps>`: `https://login.tailscale.com/admin/machines/<tailscale-ip-of-vps>`

On each, run:

```sh
sudo install -d -m 700 -o baha -g baha /home/baha/.ssh
sudo tee -a /home/baha/.ssh/authorized_keys >/dev/null <<'EOF'
<paste the contents of ~/.ssh/id_ed25519.pub>
EOF
sudo chown baha:baha /home/baha/.ssh/authorized_keys
sudo chmod 600 /home/baha/.ssh/authorized_keys
sudo tailscale up --ssh --operator=baha
sudo tailscale set --ssh
```

- `--ssh` enables the Tailscale SSH server on the box.
- `--operator=baha` lets you run `tailscale ssh baha@<host>` without `sudo`.
- The `authorized_keys` line is belt-and-braces for plain `sshd` (fallback if
  Tailscale SSH is ever off).

A host that has been offline for a while may need `sudo tailscale up` first if its node key expired.

## 3. Verify, then run dependent skills

```sh
ssh -o StrictHostKeyChecking=accept-new baha@home.<your-tailnet>.ts.net 'whoami; uname -srm'
ssh -o StrictHostKeyChecking=accept-new baha@<laptop>.<your-tailnet>.ts.net 'whoami; uname -srm'
```

Once both succeed, skills like `send-to-phone` (which mints an app password over
`$NC_HOME_SSH`) work without further setup.

## Don't

- Don't paste passwords into commands or scripts. Passwords land in shell history
  and SSH audit logs. The setup above uses public-key auth.
- Don't share or commit the Nextcloud app password. It lives in the macOS Keychain
  (service `nextcloud-agent`, account `agent`) and is regenerated per host.
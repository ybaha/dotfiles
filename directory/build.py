#!/usr/bin/env python3
"""Generate the static agent/human directory site from registry.toml.

    python3 -I build.py OUTDIR

Stdlib only. `{tailnet}` in registry strings is replaced with TAILNET from the
environment or ~/.config/pi-agent/local.env, so the tailnet name never lands in git.
Outputs: health.tsv (input for status.sh), index.html, index.md, llms.txt, services.json, infrastructure.md, services/<id>.md
"""
import html
import json
import os
import re
import sys
import time
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent


def tailnet() -> str:
    if os.environ.get("TAILNET"):
        return os.environ["TAILNET"]
    f = Path.home() / ".config/pi-agent/local.env"
    if f.exists():
        for line in f.read_text().splitlines():
            m = re.match(r"\s*TAILNET\s*=\s*(\S+)", line)
            if m:
                return m.group(1).strip("'\"")
    sys.exit("TAILNET not set (add TAILNET=<name>.ts.net to ~/.config/pi-agent/local.env)")


def sub(o, tn):
    if isinstance(o, str):
        return o.replace("{tailnet}", tn)
    if isinstance(o, list):
        return [sub(x, tn) for x in o]
    if isinstance(o, dict):
        return {k: sub(v, tn) for k, v in o.items()}
    return o


def first_sentence(t: str, n: int = 170) -> str:
    s = re.split(r"(?<=[.!?])\s", t.strip(), maxsplit=1)[0]
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def write(p: Path, s: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s)


def service_md(d, s) -> str:
    L = [f"# {s['name']}", "", f"- id: `{s['id']}`", f"- status: **{s['status']}** (verified: {s['verified']})"]
    if s.get("url"):
        L.append(f"- url: {s['url']}")
    L.append(f"- host: {s['host']}") if s.get("host") else None
    L.append(f"- tags: {', '.join(s.get('tags', []))}") if s.get("tags") else None
    L += ["", "## What it is", s["purpose"], ""]
    if s.get("start_here"):
        L += ["## Start here", s["start_here"], ""]
    L += ["## Auth", s.get("auth", "none documented"), ""]
    if s.get("endpoints"):
        L += ["## Endpoints", *[f"- {e}" for e in s["endpoints"]], ""]
    if s.get("example"):
        L += ["## Example", "```sh", *s["example"], "```", ""]
    if s.get("gotchas"):
        L += ["## Gotchas", *[f"- {g}" for g in s["gotchas"]], ""]
    for title, path in s.get("docs", []):
        p = Path(path).expanduser()
        if p.exists():
            L += [f"## Doc: {title}", "", p.read_text().strip(), ""]
        else:
            print(f"warn: doc missing, skipped: {path}", file=sys.stderr)
    L += ["---", f"Back to [directory]({d['base_url']}/index.md)", ""]
    return "\n".join(L)


def index_md(d, S) -> str:
    L = [f"# {d['title']}", "", d["summary"], "", "## Conventions (read first)", *[f"- {c}" for c in d["conventions"]], "",
         "## Services", "", "| service | what | url | status |", "|---|---|---|---|"]
    for s in S:
        L.append(f"| [{s['name']}](services/{s['id']}.md) | {first_sentence(s['purpose'])} | {s.get('url', '-')} | {s['status']} |")
    L += ["", "## More", "- [infrastructure.md](infrastructure.md): Proxmox guests, tailnet nodes",
          "- [services.json](services.json): machine-readable registry", "- [status.json](status.json): live health checks (refreshed every ~5 min)",
          "- [llms.txt](llms.txt): same index in llms.txt format", "",
          "## Adding or changing a listing",
          "If you expose a new front end, API or other URL reachable on the tailnet (or change/remove one), update this directory in the same task:",
          "1. Edit `~/code/dotfiles/directory/registry.toml` (add a `[[service]]` with id, name, tags, purpose, status, verified, host, url, auth, start_here; add `health_url` if there is a no-auth health endpoint).",
          "2. Run `~/code/dotfiles/directory/deploy` (builds, pushes to this site, verifies).",
          "3. Never put secrets in the registry; write only where the credential lives.", ""]
    return "\n".join(L)


def infra_md(d, data) -> str:
    L = [f"# Infrastructure", "", "## Tailnet nodes", "", "| node | kind | role |", "|---|---|---|"]
    L += [f"| {n['name']} | {n['kind']} | {n['role']} |" for n in data["node"]]
    L += ["", "## Proxmox guests on `home`", "", "| id | name | status | RAM | note |", "|---|---|---|---|---|"]
    L += [f"| {g['id']} | {g['name']} | {g['status']} | {g['ram']} | {g['note']} |" for g in data["guest"]]
    L += ["", "[back](index.md)", ""]
    return "\n".join(L)


CSS = """:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--mut:#6b7380;--card:#f5f6f8;--line:#e2e5ea;--ac:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e6e9ee;--mut:#8b94a1;--card:#171b21;--line:#262c34;--ac:#6ea0ff}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:980px;margin:0 auto;padding:20px 16px 48px}h1{font-size:22px;margin:0 0 4px}p.s{color:var(--mut);margin:0 0 16px}
a{color:var(--ac);text-decoration:none}a:hover{text-decoration:underline}
#q{width:100%;padding:10px 12px;font:inherit;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 16px}.tags button{font:inherit;font-size:13px;padding:2px 10px;border:1px solid var(--line);border-radius:99px;background:none;color:var(--fg);cursor:pointer}
.tags button.on{background:var(--ac);color:#fff;border-color:var(--ac)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
.c{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.c[hidden]{display:none}
.c h2{font-size:16px;margin:0 0 4px;display:flex;align-items:center;gap:8px}.d{width:9px;height:9px;border-radius:50%;background:#9aa3af;flex:none}
.d.up{background:#22c55e}.d.down{background:#ef4444}.d.stopped{background:#9aa3af}
.c p{margin:4px 0;color:var(--mut);font-size:14px}.u{font-size:13px;word-break:break-all}
.b{font-size:11px;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--mut)}
details{margin-top:6px;font-size:13px}summary{cursor:pointer;color:var(--mut)}details div{margin-top:6px}
code,pre{font:12px ui-monospace,monospace}pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;margin:6px 0}
nav{margin-top:28px;font-size:13px;color:var(--mut)}nav a{margin-right:14px}"""

JS = """const q=document.getElementById('q'),cs=[...document.querySelectorAll('.c')],tb=[...document.querySelectorAll('.tags button')];let tag='';
function f(){const t=q.value.toLowerCase();cs.forEach(c=>c.hidden=!((!t||c.textContent.toLowerCase().includes(t))&&(!tag||c.dataset.t.split(' ').includes(tag))))}
q.oninput=f;tb.forEach(b=>b.onclick=()=>{tag=tag===b.dataset.t?'':b.dataset.t;tb.forEach(x=>x.classList.toggle('on',x.dataset.t===tag));f()});
addEventListener('keydown',e=>{if(e.key==='/'&&document.activeElement!==q){e.preventDefault();q.focus()}});
fetch('status.json').then(r=>r.json()).then(j=>{cs.forEach(c=>{const s=j.services&&j.services[c.dataset.id];if(s){const d=c.querySelector('.d');d.className='d '+(s.ok?'up':'down');d.title=(s.ok?'healthy':'unreachable')+' · '+s.code}});
const a=document.getElementById('age');if(j.checked_at&&a)a.textContent='health checked '+Math.max(0,Math.round((Date.now()-new Date(j.checked_at))/60000))+' min ago'}).catch(()=>{})"""


def e(x):
    return html.escape(str(x), quote=True)


def linkify(t: str) -> str:
    t = e(t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    return re.sub(r"(https?://[^\s<)]+)", r'<a href="\1">\1</a>', t)


def card(s) -> str:
    st = "stopped" if s["status"] != "running" else ""
    url = f'<a class="u" href="{e(s["url"])}">{e(s["url"])}</a>' if s.get("url") else '<span class="u">no tailnet URL</span>'
    det = [f"<div><b>Host</b> {linkify(s.get('host', '-'))}</div>", f"<div><b>Auth</b> {linkify(s.get('auth', '-'))}</div>"]
    if s.get("start_here"):
        det.append(f"<div><b>Start</b> {linkify(s['start_here'])}</div>")
    if s.get("example"):
        det.append("<pre>" + e("\n".join(s["example"])) + "</pre>")
    det.append(f'<div><a href="services/{e(s["id"])}.md">full agent doc →</a></div>')
    tags = " ".join(s.get("tags", []))
    return (f'<article class="c" data-id="{e(s["id"])}" data-t="{e(tags)}"><h2><span class="d {st}"></span>{e(s["name"])}</h2>'
            f'<p>{e(first_sentence(s["purpose"]))}</p><p>{url}</p>'
            f'<p><span class="b">{e(s["status"])}</span> <span class="b">{e(s["verified"])}</span></p>'
            f'<details><summary>details</summary>{"".join(det)}</details></article>')


def index_html(d, S) -> str:
    tags = sorted({t for s in S for t in s.get("tags", [])})
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(d['title'])}</title><link rel="alternate" type="text/markdown" href="index.md"><link rel="alternate" type="application/json" href="services.json">
<style>{CSS}</style></head><body><main>
<!-- AI agents: machine-readable versions live at /index.md, /llms.txt, /services.json, /infrastructure.md, /status.json -->
<h1>{e(d['title'])}</h1><p class="s">{e(d['summary'])} <span id="age"></span></p>
<input id="q" type="search" placeholder="Search services…  (press / to focus)" autocomplete="off" autofocus>
<div class="tags">{''.join(f'<button data-t="{e(t)}">{e(t)}</button>' for t in tags)}</div>
<div class="grid">{''.join(card(s) for s in S)}</div>
<nav><a href="index.md">for agents (markdown)</a><a href="llms.txt">llms.txt</a><a href="services.json">services.json</a><a href="infrastructure.md">infrastructure</a><a href="status.json">status</a></nav>
</main><script>{JS}</script></body></html>
"""


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: build.py OUTDIR")
    out = Path(sys.argv[1])
    data = sub(tomllib.loads((HERE / "registry.toml").read_text()), tailnet())
    d, S = data["directory"], data["service"]
    ids = [s["id"] for s in S]
    if len(set(ids)) != len(ids):
        sys.exit("duplicate service ids")
    for s in S:
        for k in ("id", "name", "purpose", "status", "verified"):
            if k not in s:
                sys.exit(f"service {s.get('id', '?')}: missing '{k}'")
        if re.search(r"(sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9._-]{24,})", json.dumps(s)):
            sys.exit(f"service {s['id']}: looks like it contains a credential")
    write(out / "index.html", index_html(d, S))
    write(out / "index.md", index_md(d, S))
    write(out / "infrastructure.md", infra_md(d, data))
    for s in S:
        write(out / "services" / f"{s['id']}.md", service_md(d, s))
    base = d["base_url"]
    write(out / "llms.txt", f"# {d['title']}\n\n> {d['summary']}\n\n## Services\n" + "".join(
        f"- [{s['name']}]({base}/services/{s['id']}.md): {first_sentence(s['purpose'])}\n" for s in S) +
        f"\n## Optional\n- [Infrastructure]({base}/infrastructure.md)\n- [Registry JSON]({base}/services.json)\n- [Live status]({base}/status.json)\n")
    write(out / "services.json", json.dumps({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "base_url": base, "https_url": d["https_url"],
                                             "conventions": d["conventions"], "services": S, "nodes": data["node"], "guests": data["guest"]}, indent=1) + "\n")
    write(out / "health.tsv", "".join(f"{s['id']}\t{s['health_url']}\n" for s in S if s.get("health_url") and s["status"] == "running"))
    print(f"built {len(S)} services -> {out}")


if __name__ == "__main__":
    main()

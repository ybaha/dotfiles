import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const path = new URL("../files/home/.pi/agent/extensions/usage-status.ts", import.meta.url);
const source = stripTypeScriptTypes(readFileSync(path, "utf8"))
  .replace(/^import .*;\n/gm, "")
  .replace("export default function", "function setup");

for (const stale of [false, true]) {
  const snapshots = Object.fromEntries(["codex", "claude", "minimax", "cursor"].map(name => [
    `${name}.json`, { primaryLeft: 97, weeklyLeft: 66, currentLeft: 80,
      state: "running", live: true, fetchedAt: Date.now() - (stale ? 300_000 : 0) },
  ]));
  const handlers = new Map();
  let footer;
  const theme = {
    fg(_color, text) { assert.equal(typeof text, "string"); return text; },
    bold(text) { return text; },
  };
  const sandbox = {
    existsSync: () => true,
    readFileSync: path => JSON.stringify(snapshots[path.split("/").pop()]),
    homedir: () => "/fake-home", join,
    truncateToWidth: (text, width) => text.slice(0, width),
    setInterval: () => 1, clearInterval: () => {},
  };
  runInNewContext(`${source}\nsetup`, sandbox)({
    on: (event, handler) => handlers.set(event, handler),
  });
  handlers.get("session_start")({}, {
    mode: "tui", model: { provider: "openai-codex", id: "gpt-test" }, thinkingLevel: "high",
    cwd: "/fake-home", getContextUsage: () => ({ tokens: 1000, percent: 1, contextWindow: 100000 }),
    ui: { setFooter: factory => { footer = factory({ requestRender() {} }, theme, {
      onBranchChange: () => () => {}, getGitBranch: () => undefined,
      getExtensionStatuses: () => new Map(),
    }); } },
  });
  for (const width of [80, 119, 120, 149, 150, 200]) {
    const lines = footer.render(width);
    assert.match(lines[1], /Codex .*97%.*66%/);
    for (const line of lines) assert.ok(line.length <= width);
  }
  footer.dispose();
  handlers.get("session_shutdown")();
}
console.log("usage-status: fresh/stale quota rendering passed at six widths");

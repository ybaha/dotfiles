import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function resolvePiRoot() {
	const localRequire = createRequire(import.meta.url);
	const candidates = [];
	try { candidates.push(dirname(localRequire.resolve("@earendil-works/pi-coding-agent/package.json"))); } catch {}
	try {
		const executable = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8", timeout: 10_000 }).trim();
		candidates.push(dirname(realpathSync(executable)));
		candidates.push(join(dirname(realpathSync(executable)), ".."));
	} catch {}
	try { candidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).trim(), "@earendil-works/pi-coding-agent")); } catch {}
	const miseNode = join(process.env.HOME ?? "", ".local/share/mise/installs/node");
	if (existsSync(miseNode)) {
		for (const ver of readdirSync(miseNode)) candidates.push(join(miseNode, ver, "lib/node_modules/@earendil-works/pi-coding-agent"));
	}
	for (const root of new Set(candidates)) {
		try {
			if (!existsSync(join(root, "dist/index.js"))) continue;
			createRequire(join(root, "package.json"))("jiti");
			return root;
		} catch {}
	}
	throw new Error("pi-coding-agent with jiti not found; install Pi separately (tests never install it)");
}

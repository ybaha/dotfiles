import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Chief has no hc port. Never initialize its store/tools on hc or without the old CLI. */
export function legacyHerdrAvailable(): boolean {
	if (process.env.HC_TERMINAL_ID || process.env.HERDR_ENV !== "1") return false;
	return (process.env.PATH ?? "").split(delimiter).some(dir => {
		try { accessSync(join(dir, "herdr"), constants.X_OK); return true; } catch { return false; }
	});
}

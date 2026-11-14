import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chief from "../index.ts";
import extension from "../../extensions/chief-of-staff.ts";
import { legacyHerdrAvailable } from "../legacy-runtime.ts";

test("Chief startup does nothing on hc, outside Herdr, or with herdr absent", async () => {
	const saved = Object.fromEntries(["PATH", "HERDR_ENV", "HC_TERMINAL_ID"].map(key => [key, process.env[key]]));
	const dir = mkdtempSync(join(tmpdir(), "chief-disabled-"));
	const pi: any = new Proxy({}, { get: () => assert.fail("Chief must not touch Pi when disabled") });
	try {
		process.env.PATH = dir;
		process.env.HERDR_ENV = "1";
		delete process.env.HC_TERMINAL_ID;
		assert.equal(legacyHerdrAvailable(), false, "missing executable");
		chief(pi);
		await extension(pi);
		writeFileSync(join(dir, "herdr"), "#!/bin/sh\nexit 99\n");
		chmodSync(join(dir, "herdr"), 0o700);
		delete process.env.HERDR_ENV;
		assert.equal(legacyHerdrAvailable(), false, "missing legacy environment");
		chief(pi);
		await extension(pi);
		process.env.HERDR_ENV = "1";
		process.env.HC_TERMINAL_ID = "t7";
		assert.equal(legacyHerdrAvailable(), false, "hc wins over inherited legacy environment");
		chief(pi);
		await extension(pi);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

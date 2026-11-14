import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { legacyHerdrAvailable } from "../chief-of-staff/legacy-runtime.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	if (!legacyHerdrAvailable()) return;
	const { default: chief } = await import("../chief-of-staff/index.ts");
	chief(pi);
}

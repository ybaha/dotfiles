import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Add /rename as a friendlier alias for Pi's persistent session name. */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("rename", {
		description: "Rename the current session (shown by /resume)",
		handler: async (args, ctx) => {
			let name = args.trim();

			if (!name) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /rename <session title>", "warning");
					return;
				}

				name = (await ctx.ui.input("Session title", pi.getSessionName() ?? ""))?.trim() ?? "";
			}

			if (!name) {
				ctx.ui.notify("Session title cannot be empty.", "warning");
				return;
			}

			pi.setSessionName(name);
			ctx.ui.notify(`Session renamed: ${name}`, "info");
		},
	});
}

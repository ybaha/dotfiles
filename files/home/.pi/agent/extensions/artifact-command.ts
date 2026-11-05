import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register /artifact as a convenient alias for /skill:artifact. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("artifact", {
    description: "Create the response as a polished visual HTML artifact",
    handler: async (args) => {
      const request = args.trim();
      const skillCommand = request ? `/skill:artifact ${request}` : "/skill:artifact";
      pi.sendUserMessage(skillCommand, { expandPromptTemplates: true });
    },
  });
}

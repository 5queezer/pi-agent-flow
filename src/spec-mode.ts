import type { ExtensionAPI, ExtensionCommandContext, ReplacedSessionContext } from "@mariozechner/pi-coding-agent";
import { isSpecModeActive, setSpecModeActive } from "./sliding-prompt.js";

/**
 * Setup the /spec command as a persistent toggle between spec mode
 * (investigate → discuss → plan → delegate) and implement mode
 * (lean orchestrator, investigate first then delegate).
 *
 * The sliding prompt in index.ts reads the active flag and injects
 * the appropriate prompt content each turn.
 */
export function setupSpecMode(pi: ExtensionAPI): void {
	pi.registerCommand("spec", {
		description: "Toggle spec-driven planning mode on/off, or pass a prompt to activate and start immediately.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			if (trimmed) {
				setSpecModeActive(true);
				pi.sendUserMessage(trimmed);
				ctx.ui.notify?.("Spec mode activated", "info");
			} else {
				const next = !isSpecModeActive();
				if (!next) {
					const result = await ctx.newSession({
						withSession: async (newCtx: ReplacedSessionContext) => {
							setSpecModeActive(false);
							await newCtx.sendUserMessage("Please read the spec from `.specs/` and proceed with implementation.");
							newCtx.ui.notify?.("Spec mode deactivated", "info");
						},
					});
					if (result.cancelled) {
						return;
					}
				} else {
					setSpecModeActive(true);
					ctx.ui.notify?.("Spec mode activated", "info");
				}
			}
		},
	});
}

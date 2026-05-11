import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
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
		description: "Toggle spec-driven planning mode on/off.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const next = !isSpecModeActive();
			setSpecModeActive(next);
			ctx.ui.notify?.(next ? "Spec mode activated" : "Spec mode deactivated", "info");
		},
	});
}

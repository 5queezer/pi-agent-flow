import type { ExtensionAPI, ExtensionCommandContext, ReplacedSessionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { isSpecModeActive, setSpecModeActive } from "./sliding-prompt.js";

let _waitingForSpecPlanSessionId: string | null = null;

function extractTextFromContent(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Setup the /spec command as a persistent toggle between spec mode
 * (investigate → discuss → plan → delegate) and implement mode
 * (lean orchestrator, investigate first then delegate).
 *
 * The sliding prompt in index.ts reads the active flag and injects
 * the appropriate prompt content each turn.
 */
export function setupSpecMode(pi: ExtensionAPI): void {
	pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionCommandContext) => {
		if (!_waitingForSpecPlanSessionId || event.message?.role !== "assistant") return;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId !== _waitingForSpecPlanSessionId) return;
		const text = extractTextFromContent(event.message.content);
		if (text.trim()) {
			ctx.ui.setEditorText?.(text);
		}
		_waitingForSpecPlanSessionId = null;
	});

	pi.registerCommand("spec", {
		description: "Toggle spec-driven planning mode on/off, or pass a prompt to activate and start immediately.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			if (trimmed) {
				_waitingForSpecPlanSessionId = null;
				setSpecModeActive(true);
				pi.sendUserMessage(trimmed);
				ctx.ui.notify?.("Spec mode activated", "info");
			} else {
				const next = !isSpecModeActive();
				if (!next) {
					const result = await ctx.newSession({
						withSession: async (newCtx: ReplacedSessionContext) => {
							setSpecModeActive(false);
							const sessionId = newCtx.sessionManager?.getSessionId?.();
							if (sessionId) {
								_waitingForSpecPlanSessionId = sessionId;
							}
							// Fire-and-forget: do NOT await sendUserMessage inside withSession.
							// Awaiting it blocks the session transition and freezes the CLI UI.
							void newCtx.sendUserMessage("Synthesize a full implementation plan from the conversation history. Output ONLY the complete markdown spec (no tool calls after you start writing). After you finish, the plan will be placed in the editor for review.");
							newCtx.ui.notify?.("Spec mode deactivated", "info");
						},
					});
					if (result.cancelled) {
						return;
					}
				} else {
					_waitingForSpecPlanSessionId = null;
					const result = await ctx.newSession({
						withSession: async (newCtx: ReplacedSessionContext) => {
							setSpecModeActive(true);
							newCtx.ui.notify?.("Spec mode activated", "info");
						},
					});
					if (result.cancelled) {
						return;
					}
				}
			}
		},
	});
}

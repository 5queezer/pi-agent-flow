import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Inlined spec prompt — self-contained, no file reads at runtime
// ---------------------------------------------------------------------------

const SPEC_PROMPT = `[SPEC MODE ACTIVE] You are in spec-driven planning mode.

Your goal: Investigate the codebase, discuss with the user, and produce a structured spec file.

IMPORTANT: You are the orchestrator. You have batch_read, flow, web, and ask_user.
You do NOT have bash or write. Delegate bash/write operations to flows.

## Phase 1: Investigate

### Direct (batch_read):
- Read package.json, tsconfig, existing source files
- Read test files, config files, documentation
- Identify patterns, conventions, architecture

### Delegated (flow [scout]):
- flow [scout] intent: "Check git status, current branch, recent commits, test setup, CI config. Report findings."

### Build a mental map:
- Tech stack, patterns, test coverage, constraints
- What exists vs what needs to be built

## Phase 2: Discuss (2-3 questions via ask_user)

Ask 2-3 targeted questions grounded in Phase 1 findings.

### Question styles (use ALL three):
1. **Challenge assumptions** — "You asked for X, but codebase has Y. Extend Y or build X?"
2. **Present trade-offs** — "Approach A [fast] vs B [extensible]. Which fits?"
3. **Gap-filling** — "Do you need offline support? Expected scale?"

### Rules:
- NEVER ask what you can discover with tools
- Mark recommended option with [preferred], place it first
- 2-4 options per question with clear trade-off descriptions
- Questions must be codebase-specific, not generic

## Phase 3: Write Spec (delegate to build flow)

flow [build] intent:
"Write the following spec to .specs/{slug}/spec.md. Create directory if needed.

Spec content:
{complete spec}"

### Spec template:
- Investigation Findings (current state + evidence)
- User Alignment (Q&A record with impact)
- Technical Context (stack, deps, testing)
- Design Decisions (decision/choice/rationale table)
- Implementation Plan (phased)
- Risks & Mitigations
- Assumptions

## Phase 4: Report

After build flow confirms write, tell user:
"Spec written to .specs/{slug}/spec.md"

## Anti-patterns:
- ❌ Asking without investigating first
- ❌ Skipping investigation
- ❌ Asking about discoverable facts
- ❌ Not marking [preferred]
- ❌ Writing spec without Q&A record
- ❌ Using bash/write directly (delegate to flows)`;

const SPEC_CONTEXT_TYPE = "pi-spec:context";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function setupSpecMode(pi: ExtensionAPI): void {
	let active = false;
	let userPrompt = "";

	pi.registerCommand("spec", {
		description: "Enter spec-driven mode: investigate, discuss, produce spec.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();

			// Toggle: if active, confirm exit
			if (active) {
				if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
					active = false;
					ctx.ui.notify?.("Spec mode deactivated (no UI).", "info");
					return;
				}
				const shouldExit = await ctx.ui.confirm("Escape Spec mode?", "");
				if (shouldExit) {
					active = false;
					ctx.ui.notify?.("Spec mode deactivated.", "info");
				}
				return;
			}

			// Enter
			active = true;
			userPrompt = trimmed;
			ctx.ui.notify?.("Spec mode activated", "info");
			// Auto-trigger agent turn only when user provided a description
			if (trimmed) {
				pi.sendUserMessage(trimmed);
			}
		},
	});

	// One-shot prompt injection on next agent start
	pi.on("before_agent_start", async () => {
		if (!active) return;
		const prompt = SPEC_PROMPT;
		active = false; // One-shot: inject once, then deactivate
		const content = userPrompt
			? `${prompt}\n\nUser's request: ${userPrompt}`
			: prompt;
		return {
			message: {
				content,
				customType: SPEC_CONTEXT_TYPE,
				display: false,
			},
		};
	});
}

export { SPEC_CONTEXT_TYPE };

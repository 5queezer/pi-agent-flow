/**
 * Explore Tool Extension — Autonomous research with live overlay.
 *
 * Launches a forked child agent that freely explores using batch + web tools,
 * displays a live-updating overlay while the child works, and returns only
 * curated findings selected by the child agent.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
	Container,
	Text,
	Spacer,
	truncateToWidth,
	TruncatedText,
	type Component,
	type TUI,
	type KeybindingsManager,
	matchesKey,
	Key,
} from "@mariozechner/pi-tui";
import { runFlow } from "./flow.js";
import { type FlowConfig } from "./agents.js";
import { buildForkSessionSnapshotJsonl, sanitizeForkSnapshot } from "./snapshot.js";
import { resolveFlowDepthConfig } from "./depth.js";
import { type AgentSessionMode } from "./session-mode.js";
import {
	type SingleResult,
	type FlowDetails,
	type ExploreToolDetails,
	type ExploreDetails,
	getFlowOutput,
	getLastToolCall,
	isFlowError,
} from "./types.js";
import { extractStructuredOutput } from "./structured-output.js";
import { appendStrategicHint } from "./tool-utils.js";

import { createRequire } from "node:module";

let EXPLORE_VERSION = "0.0.0";
try {
	const require = createRequire(import.meta.url);
	const pkg = require("../package.json");
	EXPLORE_VERSION = pkg.version;
} catch { /* fallback */ }

// ---------------------------------------------------------------------------
// Inline flow config — explore is a self-contained tool, not a discoverable flow
// ---------------------------------------------------------------------------

const EXPLORE_FLOW: FlowConfig = {
	name: "explore",
	description: "Autonomous research and codebase exploration with curated findings",
	tools: ["batch", "bash", "web"],
	maxDepth: 0,
	tier: "flash",
	systemPrompt: [
		"## Mission",
		"",
		"During this explore flow — your mission is to investigate a topic thoroughly using `batch` and `web` tools, then curate and report only the most valuable findings.",
		"",
		"## Workflow",
		"",
		"1. **Explore** — Use `batch` (read, bash) and `web` (search, fetch) to investigate broadly. Run as many tool calls as needed. Follow leads, search external docs, grep the codebase, read relevant files.",
		"2. **Curate** — Before outputting your final JSON, review every tool call you made. Select only the ones that produced concrete, relevant, non-redundant findings. Discard dead-ends, duplicates, and failed searches.",
		"3. **Report** — Output a structured JSON block with your curated results.",
		"",
		"## Rules",
		"",
		"- **Read-only.** Do not modify, create, or delete files. Exploration is inspection only.",
		"- **Be thorough.** Run 5–15 tool calls if the topic warrants it.",
		"- **Be selective.** Keep at most 10 findings. For each, write a one-sentence `resultSummary` and a short `resultExcerpt`.",
		"- **Include evidence.** Cite file paths, line ranges, URLs, or command outputs.",
		"- **Time budget.** If approaching timeout, stop exploring and curate what you have.",
		"",
		"## Structured Output",
		"",
		"In addition to the standard schema fields, include an `extensions.explore` object:",
		"",
		"{",
		'  "version": "1.0",',
		'  "status": "complete",',
		'  "summary": "1-3 sentence overview of what was found",',
		'  "extensions": {',
		'    "explore": {',
		'      "note": "Synthesized narrative: what patterns were found, what matters, and why.",',
		'      "kept": [',
		'        {',
		'          "phase": "search",',
		'          "tool": "web",',
		'          "action": "search",',
		'          "query": "search query or command",',
		'          "resultSummary": "One-sentence summary of what this call revealed.",',
		'          "resultExcerpt": "Short excerpt, file path, or URL."',
		"        }",
		"      ],",
		'      "discardedCount": 7,',
		'      "durationMs": 45230,',
		'      "totalToolCalls": 10',
		"    }",
		"  }",
		"}",
	].join("\n"),
	source: "bundled",
	filePath: "<inline>",
};
const BOX_BORDER_LEFT = "│";
const BOX_BORDER_RIGHT = "│";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;
const OVERLAY_WIDTH = "92%";
const OVERLAY_MIN_WIDTH = 40;

// ---------------------------------------------------------------------------
// Box border components (same pattern as ask-user.ts)
// ---------------------------------------------------------------------------

class BoxBorderTop implements Component {
	private color: (s: string) => string;
	private title?: string;
	private titleColor?: (s: string) => string;

	constructor(color: (s: string) => string, title?: string, titleColor?: (s: string) => string) {
		this.color = color;
		this.title = title;
		this.titleColor = titleColor;
	}

	invalidate(): void { }

	render(width: number): string[] {
		const inner = Math.max(0, width - 2);
		if (!this.title || inner < this.title.length + 4) {
			return [this.color(`╭${"─".repeat(inner)}╮`)];
		}
		const label = ` ${this.title} `;
		const remaining = inner - 1 - label.length;
		const titleStyle = this.titleColor ?? this.color;
		return [
			this.color("╭─") + titleStyle(label) + this.color("─".repeat(Math.max(0, remaining)) + "╮"),
		];
	}
}

class BoxBorderBottom implements Component {
	private color: (s: string) => string;
	private label?: string;
	private labelColor?: (s: string) => string;

	constructor(color: (s: string) => string, label?: string, labelColor?: (s: string) => string) {
		this.color = color;
		this.label = label;
		this.labelColor = labelColor;
	}

	invalidate(): void { }

	render(width: number): string[] {
		const inner = Math.max(0, width - 2);
		if (!this.label || inner < this.label.length + 4) {
			return [this.color(`╰${"─".repeat(inner)}╯`)];
		}
		const tag = ` ${this.label} `;
		const leftDashes = inner - tag.length - 1;
		const style = this.labelColor ?? this.color;
		return [
			this.color("╰" + "─".repeat(Math.max(0, leftDashes))) + style(tag) + this.color("─╯"),
		];
	}
}

// ---------------------------------------------------------------------------
// Shared mutable state for the overlay
// ---------------------------------------------------------------------------

interface ExploreState {
	/** The latest partial result from the child agent. */
	result: SingleResult | null;
	/** When the exploration started (epoch ms). */
	startTimeMs: number;
	/** Whether the user cancelled via the overlay. */
	cancelled: boolean;
	/** The original intent. */
	intent: string;
	/** The original aim. */
	aim: string;
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

class ExploreOverlayComponent extends Container {
	private statsText: Text;
	private activityContainer: Container;
	private statusText: Text;
	private helpText: Text;

	constructor(
		private tui: TUI,
		private state: ExploreState,
		private theme: Theme,
		private onCancel: () => void,
	) {
		super();

		// Intent line (aim)
		this.addChild(new Text(this.theme.fg("text", this.theme.bold(this.state.aim)), 0, 0));
		this.addChild(new Spacer(1));

		// Stats line (dynamic)
		this.statsText = new Text("", 0, 0);
		this.addChild(this.statsText);

		// Activity list (dynamic)
		this.activityContainer = new Container();
		this.addChild(this.activityContainer);

		// Status line (dynamic)
		this.statusText = new Text("", 0, 0);
		this.addChild(this.statusText);
		this.addChild(new Spacer(1));

		// Help
		this.helpText = new Text(this.theme.fg("dim", "Press Esc to cancel"), 0, 0);
		this.addChild(this.helpText);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onCancel();
		}
	}

	override render(width: number): string[] {
		this.updateDynamicContent();

		const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
		const rawLines = super.render(innerWidth);

		const borderColor = (s: string) => this.theme.fg("accent", s);
		const titleColor = (s: string) => this.theme.fg("dim", this.theme.bold(s));
		const labelColor = (s: string) => this.theme.fg("dim", s);

		const lines: string[] = [];
		lines.push(new BoxBorderTop(borderColor, "explore", titleColor).render(width)[0]);
		for (const line of rawLines) {
			const padded = truncateToWidth(line, innerWidth, "", true);
			lines.push(`${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`);
		}
		lines.push(new BoxBorderBottom(borderColor, `v${EXPLORE_VERSION}`, labelColor).render(width)[0]);
		return lines;
	}

	private updateDynamicContent(): void {
		const elapsed = this.state.result
			? Math.max(0, Date.now() - (this.state.result.startedAtMs || this.state.startTimeMs))
			: 0;
		const elapsedSec = Math.floor(elapsed / 1000);
		const calls = this.state.result?.usage.toolCalls ?? 0;
		const status = this.state.cancelled
			? "cancelled"
			: this.state.result && this.state.result.exitCode >= 0
				? "finishing"
				: "exploring";

		// Stats line
		this.statsText.setText(
			`${this.theme.fg("dim", `Time: ${elapsedSec}s`)}    ` +
			`${this.theme.fg("dim", `Calls: ${calls}`)}    ` +
			`${this.theme.fg("dim", `Status: ${status}`)}`,
		);

		// Activity list — last 5 tool calls
		this.activityContainer.clear();
		const messages = this.state.result?.messages ?? [];
		const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
		for (const msg of messages) {
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			for (const part of msg.content) {
				if (part.type === "toolCall") {
					const name = (part as any).name || (part as any).toolName || "";
					const args = (part as any).arguments || (part as any).input || {};
					toolCalls.push({ name, args });
				}
			}
		}

		const recent = toolCalls.slice(-5);
		if (recent.length === 0) {
			this.activityContainer.addChild(
				new Text(this.theme.fg("dim", "  Waiting for first tool call..."), 0, 0),
			);
		} else {
			for (let i = 0; i < recent.length; i++) {
				const tc = recent[i];
				const prefix = i === recent.length - 1 ? "└─" : "├─";
				const argsShort = formatArgsShort(tc.name, tc.args);
				const line = `${prefix} ${tc.name} ${argsShort}`;
				this.activityContainer.addChild(
					new TruncatedText(this.theme.fg("dim", line), 0, 0),
				);
			}
		}

		// Status / latest message
		const lastText = this.state.result?.streamingText || getLastAssistantText(messages);
		if (lastText && !this.state.cancelled) {
			this.statusText.setText(this.theme.fg("text", truncateChars(lastText, 120)));
		} else {
			this.statusText.setText("");
		}
	}
}

/** Format tool call args into a short string. */
function formatArgsShort(toolName: string, args: Record<string, unknown>): string {
	// batch tool: args.o is an array of operations
	if (toolName === "batch" && Array.isArray(args.o)) {
		const ops = args.o as Array<Record<string, unknown>>;
		const first = ops[0];
		if (!first) return "";
		const opType = first.o as string;
		if (opType === "bash") {
			const cmd = (first.c as string) || "";
			return cmd ? `"${truncateChars(cmd, 50)}"` : "";
		}
		if (opType === "read") {
			const path = (first.p as string) || "";
			return path ? `"${path}"` : "";
		}
		if (opType === "write" || opType === "edit") {
			const path = (first.p as string) || "";
			return path ? `"${path}"` : "";
		}
		// Fallback for other batch ops
		const p = (first.p as string) || (first.c as string) || "";
		return p ? `"${truncateChars(p, 50)}"` : "";
	}

	// web tool: args.op is an array of operations
	if (toolName === "web" && Array.isArray(args.op)) {
		const ops = args.op as Array<Record<string, unknown>>;
		const first = ops[0];
		if (!first) return "";
		const opType = first.o as string;
		if (opType === "search") {
			const q = (first.q as string) || "";
			return q ? `"${truncateChars(q, 50)}"` : "";
		}
		if (opType === "fetch") {
			const u = (first.u as string) || "";
			return u ? `"${truncateChars(u, 50)}"` : "";
		}
	}

	// Direct args (legacy or simple tools)
	const cmd = (args.command as string) || (args.query as string) || (args.url as string) || "";
	if (cmd) return `"${truncateChars(cmd, 50)}"`;
	return "";
}

/** Extract last assistant text from messages. */
function getLastAssistantText(messages: any[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const texts = msg.content
			.filter((c: any) => c.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text);
		const joined = texts.join("");
		if (joined.trim()) return joined.trim();
	}
	return undefined;
}

/** Extract tool call / result pairs from message history. */
function extractToolCallOutputs(messages: any[]): Array<{ name: string; args: Record<string, unknown>; output: string }> {
	if (!Array.isArray(messages)) return [];

	// Map toolCallId → result text
	const resultMap = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
		const id = msg.toolCallId || msg.tool_call_id || "";
		if (!id) continue;
		const text = msg.content
			.filter((p: any) => p.type === "text" && typeof p.text === "string")
			.map((p: any) => p.text)
			.join("");
		resultMap.set(id, text);
	}

	// Pair with tool calls
	const pairs: Array<{ name: string; args: Record<string, unknown>; output: string }> = [];
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall") continue;
			const id = part.toolCallId || part.tool_call_id || "";
			if (!id || !resultMap.has(id)) continue;
			const name = part.name || part.toolName || "unknown";
			const args = part.arguments || part.input || {};
			pairs.push({ name, args, output: resultMap.get(id)! });
		}
	}
	return pairs;
}

function truncateChars(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createExploreTool(pi: import("@mariozechner/pi-coding-agent").ExtensionAPI) {
	return {
		name: "explore",
		label: "Explore",
		description: [
			"Launch an autonomous exploration agent with a live overlay.",
			"The agent uses batch and web tools to investigate a topic, then curates the best findings.",
			"Use when you need broad research, codebase surveying, or external reference gathering before acting.",
			"Read-only: the agent will not modify files.",
		].join("\n"),
		promptSnippet: "Explore a topic autonomously and return curated findings",
		promptGuidelines: [
			"Use explore when you need broad research or don't know exactly where to look.",
			"Provide a clear intent describing what to investigate.",
			"The agent will search the web and codebase, then return only the most relevant findings.",
			"Do not use explore for targeted file reading — use batch read directly for that.",
		],
		parameters: Type.Object({
			intent: Type.String({ description: "What to investigate (detailed)" }),
			aim: Type.String({ description: "Short headline, 5-7 words" }),
			sessionMode: Type.Optional(
				Type.Union(
					[
						Type.Literal("fast"),
						Type.Literal("default"),
						Type.Literal("long"),
						Type.Literal("extreme_long"),
					],
					{ description: "Session mode: fast=300s, default=600s, long=900s, extreme_long=1200s" },
				),
			),
		}),

		async execute(
			toolCallId: string,
			params: { intent: string; aim: string; sessionMode?: AgentSessionMode },
			signal: AbortSignal | undefined,
			onUpdate: ((result: any) => void) | undefined,
			ctx: ExtensionContext,
		) {
			const { intent, aim, sessionMode } = params;

			// Resolve depth config to prevent nested explore
			const depthConfig = resolveFlowDepthConfig(pi);
			const { currentDepth, ancestorFlowStack, preventCycles } = depthConfig;

			// Prevent nested explore calls
			if (ancestorFlowStack.includes("explore")) {
				return {
					content: [{ type: "text", text: "Nested explore calls are not allowed." }],
					details: { mode: "explore", intent, aim, result: null, cancelled: false, error: "Nested explore" } as ExploreToolDetails,
					isError: true,
				};
			}

			// Build fork session snapshot
			const forkSessionSnapshotJsonl = sanitizeForkSnapshot(
				buildForkSessionSnapshotJsonl(ctx.sessionManager),
				new Map(),
			);

			// Shared state for overlay
			const state: ExploreState = {
				result: null,
				startTimeMs: Date.now(),
				cancelled: false,
				intent,
				aim,
			};

			// Internal abort controller (chains parent signal + overlay cancel)
			const internalController = new AbortController();
			const childSignal = internalController.signal;

			if (signal) {
				const onParentAbort = () => internalController.abort();
				if (signal.aborted) {
					onParentAbort();
				} else {
					signal.addEventListener("abort", onParentAbort, { once: true });
				}
			}

			// References for overlay lifecycle
			let tuiRef: TUI | undefined;
			let doneRef: ((result?: unknown) => void) | undefined;
			let overlayPromise: Promise<unknown> | undefined;
			let doneCalled = false;

			// Start child process
			const childPromise = runFlow({
				cwd: ctx.cwd,
				flows: [EXPLORE_FLOW],
				flowName: "explore",
				intent,
				aim,
				forkSessionSnapshotJsonl,
				parentDepth: currentDepth,
				parentFlowStack: ancestorFlowStack,
				maxDepth: 0,
				preventCycles,
				toolOptimize: true,
				structuredOutput: true,
				sessionMode,
				signal: childSignal,
				onUpdate: (partial: AgentToolResult<FlowDetails>) => {
					const singleResult = partial.details?.results?.[0];
					if (singleResult) {
						state.result = singleResult;
						tuiRef?.requestRender();
					}
					// Forward to parent UI for scrollback rendering
					onUpdate?.(partial);
				},
				makeDetails: (results: SingleResult[]) => ({
					mode: "flow",
					delegationMode: "fork",
					projectAgentsDir: null,
					results,
				}),
			});

			// Show overlay if UI is available
			if (ctx.hasUI) {
				overlayPromise = ctx.ui.custom(
					(tui: TUI, theme: Theme, _keybindings: KeybindingsManager, done: (result?: unknown) => void) => {
						tuiRef = tui;
						doneRef = done;
						return new ExploreOverlayComponent(tui, state, theme, () => {
							if (doneCalled) return;
							doneCalled = true;
							state.cancelled = true;
							internalController.abort();
							done(null);
						});
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: OVERLAY_WIDTH,
							minWidth: OVERLAY_MIN_WIDTH,
							maxHeight: "85%",
							margin: 1,
						},
					},
				);
			}

			// Wait for child to finish (overlay may close earlier)
			const childResult = await childPromise;

			// Ensure overlay is closed
			if (doneRef && !doneCalled) {
				doneCalled = true;
				doneRef(null);
			}

			// Parse curated findings
			const so = childResult.structuredOutput;
			const exploreData = so?.extensions?.explore as ExploreDetails | undefined;

			// Build note text
			let noteText = "";
			if (exploreData?.note) {
				noteText = exploreData.note;
			} else if (so?.summary) {
				noteText = so.summary;
			} else {
				const flowOutput = getFlowOutput(childResult.messages);
				noteText = flowOutput || "Exploration completed with no structured output.";
			}

			// Append raw tool outputs so the parent sees actual content
			const toolPairs = extractToolCallOutputs(childResult.messages);
			if (toolPairs.length > 0) {
				noteText += "\n\n---\n\n[Tool call outputs]\n";
				for (let i = 0; i < toolPairs.length; i++) {
					const p = toolPairs[i];
					const argsStr = formatArgsShort(p.name, p.args);
					noteText += `\n${i + 1}. ${p.name} ${argsStr}\n`;
					noteText += "Output:\n";
					// Truncate extremely long outputs to keep context manageable
					const maxOut = 8000;
					const out = p.output.length > maxOut
						? p.output.slice(0, maxOut) + "\n[...truncated...]"
						: p.output;
					noteText += out + "\n";
				}
			}

			const isError = isFlowError(childResult) && !exploreData;
			const details: ExploreToolDetails = {
				mode: "explore",
				intent,
				aim,
				result: exploreData || null,
				cancelled: state.cancelled,
				...(isError ? { error: childResult.errorMessage || "Explore failed" } : {}),
			};

			const result = {
				content: [{ type: "text", text: noteText }],
				details,
				isError,
			};
			appendStrategicHint(result);
			return result;
		},

		renderCall(args: any, theme: any) {
			const aim = (args.aim as string) || "";
			let text = theme.fg("accent", theme.bold("explore"));
			if (aim) {
				text += theme.fg("dim", ` — ${aim}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result: any, options: any, theme: any) {
			// During streaming we forward raw flow updates, so details may be FlowDetails
			const flowDetails = result.details?.mode === "flow" ? result.details : null;
			const exploreDetails = result.details?.mode === "explore" ? result.details : null;

			// --- Streaming state (flow-style aim/act/msg lines) ---
			if (options.isPartial && flowDetails?.results?.[0]) {
				const r = flowDetails.results[0];
				const container = new Container();

				// Header
				container.addChild(new TruncatedText(theme.fg("accent", theme.bold("explore")), 0, 0));
				container.addChild(new Spacer(1));

				// aim: line
				if (r.aim) {
					container.addChild(new TruncatedText(
						`${theme.fg("dim", "├─ aim: ")}${theme.fg("dim", r.aim)}`,
						0, 0,
					));
				}

				// act: line (last tool call + count)
				const lastTool = getLastToolCall(r.messages);
				if (lastTool) {
					const argsShort = formatArgsShort(lastTool.name, lastTool.args);
					const actPrefix = `├─ act: [${r.usage.toolCalls}] - `;
					container.addChild(new TruncatedText(
						`${theme.fg("dim", actPrefix)}${theme.fg("dim", `${lastTool.name} ${argsShort}`)}`,
						0, 0,
					));
				}

				// msg: line (streaming text or last assistant text)
				const streamingText = result.content?.[0]?.text || getLastAssistantText(r.messages) || "";
				const msgPrefix = "└─ msg: ";
				if (streamingText) {
					container.addChild(new TruncatedText(
						`${theme.fg("dim", msgPrefix)}${theme.fg("dim", streamingText)}`,
						0, 0,
					));
				} else {
					container.addChild(new TruncatedText(
						`${theme.fg("dim", msgPrefix)}${theme.fg("dim", "[n/a]")}`,
						0, 0,
					));
				}

				return container;
			}

			// --- Error state ---
			if (exploreDetails?.error) {
				return new Text(theme.fg("error", `× explore: ${exploreDetails.error}`), 0, 0);
			}

			// --- Complete state ---
			const cancelled = exploreDetails?.cancelled;
			const exploreData = exploreDetails?.result;

			let text = theme.fg("accent", theme.bold("explore"));

			if (exploreDetails?.aim) {
				text += theme.fg("dim", ` — ${exploreDetails.aim}`);
			}

			if (cancelled) {
				text += theme.fg("warning", " [cancelled]");
			} else if (exploreDetails?.error) {
				text += theme.fg("error", " [err]");
			} else {
				text += theme.fg("success", " [done]");
			}

			if (options.expanded && exploreData) {
				text += "\n" + theme.fg("dim", `${exploreData.kept.length} kept from ${exploreData.totalToolCalls} calls (${Math.round(exploreData.durationMs / 1000)}s)`);
				text += "\n" + theme.fg("dim", exploreData.note);
				if (exploreData.kept.length > 0) {
					text += "\n" + theme.fg("muted", "Findings:");
					for (const item of exploreData.kept) {
						text += `\n  ${theme.fg("muted", "-")} ${theme.fg("dim", item.resultSummary)}`;
						if (item.resultExcerpt) {
							text += `\n    ${theme.fg("dim", item.resultExcerpt)}`;
						}
					}
				}
			}

			return new Text(text, 0, 0);
		},
	};
}

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
	type Component,
	type TUI,
	type KeybindingsManager,
	matchesKey,
	Key,
} from "@mariozechner/pi-tui";
import { runFlow } from "./flow.js";
import { discoverFlows } from "./agents.js";
import { buildForkSessionSnapshotJsonl, sanitizeForkSnapshot } from "./snapshot.js";
import { resolveFlowDepthConfig } from "./depth.js";
import { type AgentSessionMode } from "./session-mode.js";
import {
	type SingleResult,
	type FlowDetails,
	type ExploreToolDetails,
	type ExploreDetails,
	getFlowOutput,
	isFlowError,
} from "./types.js";
import { extractStructuredOutput } from "./structured-output.js";
import { appendStrategicHint } from "./tool-utils.js";

const EXPLORE_VERSION = "1.0.0";
const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
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

		// Title
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold("🔍 Exploring")), 0, 0));
		this.addChild(new Spacer(1));

		// Intent line (aim)
		this.addChild(new Text(this.theme.fg("text", this.theme.bold(this.state.aim)), 0, 0));
		this.addChild(new Spacer(1));

		// Stats line (dynamic)
		this.statsText = new Text("", 0, 0);
		this.addChild(this.statsText);
		this.addChild(new Spacer(1));

		// Activity label
		this.addChild(new Text(this.theme.fg("muted", "Activity:"), 0, 0));

		// Activity list (dynamic)
		this.activityContainer = new Container();
		this.addChild(this.activityContainer);
		this.addChild(new Spacer(1));

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

		return rawLines.map((line, index) => {
			if (index === 0) {
				return new BoxBorderTop(borderColor, "explore", titleColor).render(width)[0];
			}
			if (index === rawLines.length - 1) {
				return new BoxBorderBottom(
					borderColor,
					`v${EXPLORE_VERSION}`,
					labelColor,
				).render(width)[0];
			}
			const padded = truncateToWidth(line, innerWidth, "", true);
			return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
		});
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
				const line = `${prefix} ${tc.name} ${formatArgsShort(tc.name, tc.args)}`;
				this.activityContainer.addChild(
					new Text(this.theme.fg("dim", line), 0, 0),
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
	const cmd = (args.command as string) || (args.query as string) || (args.url as string) || "";
	if (cmd) return `"${cmd.slice(0, 60)}${cmd.length > 60 ? "..." : ""}"`;
	return JSON.stringify(args).slice(0, 60);
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

			// Discover flows — explore.md must be present
			const discovery = discoverFlows(ctx.cwd, "all");
			const exploreFlow = discovery.flows.find((f) => f.name === "explore");
			if (!exploreFlow) {
				return {
					content: [{ type: "text", text: "Explore flow definition not found. Is agents/explore.md present?" }],
					details: { mode: "explore", intent, aim, result: null, cancelled: false, error: "Flow not found" } as ExploreToolDetails,
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

			// Start child process
			const childPromise = runFlow({
				cwd: ctx.cwd,
				flows: discovery.flows,
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
					projectAgentsDir: discovery.projectFlowsDir,
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
			if (doneRef) {
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
			const intent = (args.intent as string) || "";
			let text = theme.fg("toolTitle", theme.bold("explore "));
			text += theme.fg("muted", aim);
			if (intent && intent !== aim) {
				text += "\n" + theme.fg("dim", `  ${intent}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result: any, options: any, theme: any) {
			const details = result.details as ExploreToolDetails | undefined;

			if (details?.error) {
				return new Text(theme.fg("error", `✗ explore: ${details.error}`), 0, 0);
			}

			if (options.isPartial) {
				const waitingText = result.content
					?.filter((part: any) => part?.type === "text")
					.map((part: any) => part.text ?? "")
					.join("\n")
					.trim() || "Exploring...";
				return new Text(theme.fg("muted", waitingText), 0, 0);
			}

			const cancelled = details?.cancelled;
			const exploreData = details?.result;

			let text = cancelled
				? theme.fg("warning", "◐ ")
				: theme.fg("success", "✓ ");
			text += theme.fg("accent", theme.bold("explore"));

			if (exploreData) {
				text += theme.fg("dim", ` — ${exploreData.kept.length} kept from ${exploreData.totalToolCalls} calls`);
				text += theme.fg("dim", ` (${Math.round(exploreData.durationMs / 1000)}s)`);
			}

			if (options.expanded && exploreData) {
				text += "\n" + theme.fg("dim", exploreData.note);
				if (exploreData.kept.length > 0) {
					text += "\n" + theme.fg("muted", "Findings:");
					for (const item of exploreData.kept) {
						text += `\n  ${theme.fg("success", "●")} ${theme.fg("dim", item.resultSummary)}`;
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

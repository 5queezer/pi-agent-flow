/**
 * TUI rendering for flow-state tool calls and results.
 *
 * Option B: collapsed view shows structured report (Summary/Done/Not Done/Next Steps).
 * Expanded view adds raw tool call traces.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, TruncatedText } from "@mariozechner/pi-tui";
import { getFlowSummaryText } from "./runner-events.js";
import {
	type DisplayItem,
	type SingleResult,
	type FlowDetails,
	type UsageStats,
	aggregateFlowUsage,
	getFlowDisplayItems,
	getFlowOutput,
	getLastToolCall,
	getLastAssistantText,
	isFlowError,
	isFlowSuccess,
} from "./types.js";
import { formatBatchOpsSummary } from "./batch/render.js";
import { scrambleManager } from "./scramble.js";
import { formatCompactStats, formatCompactTokenPair, formatCountdown, formatFlowTypeName, italic, lowerFirstWord, truncateChars, tailText, getTruncationBudget, visibleLength, stripAnsi } from "./render-utils.js";

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

type ThemeFg = (color: string, text: string) => string;
type ThemeBg = (color: string, text: string) => string;
type FlowTheme = { fg: ThemeFg; bold: (s: string) => string; bg: ThemeBg };

function formatCollapsedFlowHeaderTypeName(type: string): string {
	return type.toLowerCase();
}

function formatFlowToolCall(toolName: string, args: Record<string, unknown>, fg: ThemeFg): string {
	const pathArg = (args.file_path || args.path || "...") as string;

	switch (toolName) {
		case "bash": {
			const cmd = ((args.command as string) || "...").replace(/[\n\r\t]+/g, " ").replace(/ +/g, " ").trim();
			return fg("muted", "$ ") + fg("toolOutput", cmd);
		}
		case "read": {
			let text = fg("accent", shortenPath(pathArg));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				text += fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const lines = ((args.content || "") as string).split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(pathArg));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit":
			return fg("muted", "edit ") + fg("accent", shortenPath(pathArg));
		case "ls":
			return fg("muted", "ls ") + fg("accent", shortenPath((args.path || ".") as string));
		case "find":
			return fg("muted", "find ") + fg("accent", (args.pattern || "*") as string) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		case "grep":
			return fg("muted", "grep ") + fg("accent", `/${(args.pattern || "") as string}/`) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		case "batch":
		case "batch_read": {
			const summary = formatBatchOpsSummary(args);
			return fg("muted", `${toolName} `) + fg("accent", summary);
		}
		default:
			return fg("accent", toolName) + fg("dim", ` ${JSON.stringify(args)}`);
	}
}

// ---------------------------------------------------------------------------
// Shared rendering building blocks
// ---------------------------------------------------------------------------

function splitOutputLines(text: string): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function renderToolTraces(
	items: DisplayItem[],
	theme: { fg: ThemeFg },
): string {
	const lines: string[] = [];
	for (const item of items) {
		if (item.type === "toolCall") {
			lines.push(theme.fg("muted", "→ ") + formatFlowToolCall(item.name, item.args, theme.fg.bind(theme)));
		}
	}
	return lines.join("\n");
}

function renderFlowReport(
	output: string,
	theme: { fg: ThemeFg },
): string {
	const lines = splitOutputLines(output);
	return lines.map((line) => theme.fg("toolOutput", line)).join("\n");
}

function flowStatusIcon(r: SingleResult, theme: { fg: ThemeFg }): string {
	if (r.exitCode === -1) return theme.fg("warning", "⏳");
	return isFlowError(r) ? theme.fg("error", "✖") : theme.fg("success", "✔");
}

/** Center a label in a fixed-width header using em-dashes. Total width = 20. */
function sectionHeader(label: string): string {
	const total = 20;
	const innerLen = label.length + 2; // account for spaces around label
	const side = (total - innerLen) / 2;
	const left = "─".repeat(Math.floor(side));
	const right = "─".repeat(Math.ceil(side));
	return `${left} ${label} ${right}`;
}

function getLiveCountdown(r: SingleResult): string | undefined {
	if (r.exitCode !== -1 || typeof r.deadlineAtMs !== "number") return undefined;
	return formatCountdown(r.deadlineAtMs - Date.now());
}



// ---------------------------------------------------------------------------
// renderFlowCall — shown while the flow is being invoked
// ---------------------------------------------------------------------------

export function renderFlowCall(args: Record<string, any>, theme: FlowTheme): Text {
	const flows = args.flow as Array<{ type: string; intent: string }> | undefined;

	// Minimal — renderFlowResult owns the full display
	return new Text("", 0, 0);
}

// ---------------------------------------------------------------------------
// renderFlowResult — shown after the flow completes
// ---------------------------------------------------------------------------

export function renderFlowResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	theme: FlowTheme,
	args?: Record<string, any>,
): Container | Text {
	const details = result.details as FlowDetails | undefined;
	const streamingText = result.content?.[0]?.type === "text" ? result.content[0].text : undefined;

	let container: Container | Text;

	if (!details || details.results.length === 0) {
		// Ghost Dashboard: render a placeholder status line during the zero state
		const flowRequest = args?.flow?.[0];
		if (flowRequest) {
			const ghostResult: SingleResult = {
				type: flowRequest.type || "unknown",
				agentSource: "user",
				intent: flowRequest.intent || "Processing...",
				aim: flowRequest.aim || flowRequest.intent || "Processing...",
				acceptance: flowRequest.acceptance,
				exitCode: -1, // In progress
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolCalls: 0 },
			};
			container = renderFlowCollapsed(ghostResult, flowStatusIcon(ghostResult, theme), false, streamingText || "", theme);
		} else {
			container = new Text(streamingText || "", 0, 0);
		}
	} else if (details.results.length === 1) {
		container = renderSingleFlowResult(details.results[0], expanded, theme, streamingText);
	} else {
		container = renderMultiFlowResult(details, expanded, theme);
	}

	// Scramble animation timer management — MUST run AFTER rendering so that
	// ripples spawned during render are detected and the timer is started.
	// Uses chained setTimeout (not setInterval) to avoid TUI ghost frames.
	if (args?.invalidate && args?.state) {
		const s = (args.state as any).__scramble = (args.state as any).__scramble || {};
		const now = Date.now();
		const hasActive = scrambleManager.hasAnyActiveAnimations(now);

		if (hasActive) {
			if (!s.animTimer) {
				s.animTimer = setTimeout(() => {
					s.animTimer = undefined;
					args.invalidate!();
				}, 50);
			}
		} else if (s.animTimer) {
			clearTimeout(s.animTimer);
			s.animTimer = undefined;
		}
	}

	return container;
}

// ---------------------------------------------------------------------------
// Single flow result
// ---------------------------------------------------------------------------

function renderSingleFlowResult(
	r: SingleResult,
	expanded: boolean,
	theme: FlowTheme,
	streamingText?: string,
	toolCallId?: string,
): Container | Text {
	const id = toolCallId || "single";
	const error = isFlowError(r);
	const icon = flowStatusIcon(r, theme);
	const displayItems = getFlowDisplayItems(r.messages);
	const flowOutput = getFlowOutput(r.messages);

	if (expanded) {
		return renderFlowExpanded(r, icon, error, displayItems, flowOutput, theme);
	}
	return renderFlowCollapsed(r, icon, error, flowOutput, theme, streamingText, id);
}

function renderFlowExpanded(
	r: SingleResult,
	icon: string,
	error: boolean,
	displayItems: DisplayItem[],
	flowOutput: string,
	theme: FlowTheme,
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();

	// Header: uppercase type name with dots, no icon, no source
	const typeName = formatFlowTypeName(r.type);
	let header = theme.fg("toolTitle", theme.bold(typeName));
	if (error && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	container.addChild(new Text(header, 0, 0));
	if (error && r.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}

	// Stats: dashboard format
	const inlineStats = formatCompactStats(r.usage, r.model);
	container.addChild(new Text(theme.fg("dim", inlineStats), 0, 0));

	// Intent
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", sectionHeader("intent")), 0, 0));
	container.addChild(new Text(theme.fg("dim", r.intent), 0, 0));

	// Acceptance
	if (r.acceptance) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", sectionHeader("acceptance")), 0, 0));
		container.addChild(new Text(theme.fg("dim", r.acceptance), 0, 0));
	}

	// Flow report (structured output)
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", sectionHeader("report")), 0, 0));

	// Structured output summary (compact badge when available)
	if (r.structuredOutput) {
		const so = r.structuredOutput;
		const statusColor = so.status === "complete" ? "success" : so.status === "partial" ? "warning" : "error";
		container.addChild(new Text(
			`${theme.fg(statusColor, `[${so.status}]`)} ${theme.fg("dim", so.summary)}`,
			0, 0,
		));
		if (so.files.length > 0) {
			container.addChild(new Text(theme.fg("dim", `Files: ${so.files.map((f) => f.path).join(", ")}`), 0, 0));
		}
		if (so.commands?.length > 0) {
			const cmdLabels = so.commands.map((c) => {
				const short = c.command.length > 30 ? c.command.slice(0, 30) + "..." : c.command;
				return `${c.tool ?? "cmd"}: ${short}`;
			});
			container.addChild(new Text(theme.fg("dim", `Commands: ${cmdLabels.join(", ")}`), 0, 0));
		}
		if (so.notDone.length > 0) {
			const notDoneText = so.notDone.map((item) => {
				const details = [
					item.reason ? `reason: ${item.reason}` : undefined,
					item.blocker ? `blocker: ${item.blocker}` : undefined,
					item.nextStep ? `next: ${item.nextStep}` : undefined,
				].filter(Boolean).join("; ");
				return details ? `${item.item} (${details})` : item.item;
			}).join("; ");
			container.addChild(new Text(theme.fg("dim", `Not Done: ${notDoneText}`), 0, 0));
		}
		if (so.nextSteps.length > 0) {
			container.addChild(new Text(theme.fg("dim", `Next: ${so.nextSteps.join("; ")}`), 0, 0));
		}
		container.addChild(new Spacer(1));
	}

	if (flowOutput) {
		container.addChild(new Markdown(flowOutput.trim(), 0, 0, mdTheme));
	} else {
		const summary = getFlowSummaryText(r);
		container.addChild(new Text(theme.fg("muted", summary), 0, 0));
	}

	// Tool traces (expanded only)
	const toolTraces = renderToolTraces(displayItems, theme);
	if (toolTraces) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", sectionHeader("tool calls")), 0, 0));
		container.addChild(new Text(toolTraces, 0, 0));
	}

	return container;
}

function renderFlowCollapsed(
	r: SingleResult,
	icon: string,
	error: boolean,
	flowOutput: string,
	theme: FlowTheme,
	streamingText?: string,
	toolCallId?: string,
): Container {
	const id = toolCallId || "collapsed";
	const now = Date.now();
	const container = new Container();
	const maxWidth = process.stdout.columns ?? 80;
	const stats = formatCompactStats(r.usage, r.model, maxWidth, { skipTokens: true, skipContext: true, hideModel: true });

	const isComplete = r.exitCode !== -1;

	// Flash TPS value when it changes
	const tpsMatch = stats.match(/tps:\s*(\S+)/);
	let displayStats = stats;
	if (tpsMatch) {
		const scrambledTps = scrambleManager.updateTps(id, tpsMatch[1], now, isComplete);
		if (scrambledTps !== tpsMatch[1]) {
			displayStats = stats.replace(tpsMatch[1], scrambledTps);
		}
	}

	const typeName = formatCollapsedFlowHeaderTypeName(r.type);
	const modelLabel = r.model ? r.model.replace(/^[^/]+\//, "").toLowerCase() : "";
	let header = `${theme.fg("accent", theme.bold(typeName))}${theme.fg("dim", modelLabel ? ` - ${modelLabel} - ` : " - ")}${theme.fg("dim", displayStats)}`;
	if (error && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	container.addChild(new TruncatedText(header, 0, 0));

	// aim: line — no animation, content stays still
	if (r.aim) {
		const countdown = getLiveCountdown(r);
		const treePrefix = "├─";
		const aimPrefix = countdown
			? `${treePrefix} aim: [${countdown}] - `
			: `${treePrefix} aim: `;
		const budget = getTruncationBudget(visibleLength(aimPrefix));
		const displayAim = truncateChars(lowerFirstWord(r.aim), budget);
		container.addChild(new TruncatedText(`${theme.fg("dim", aimPrefix)}${theme.fg("dim", italic(displayAim))}`, 0, 0));
	}

	// act: line (last tool call with count)
	const lastTool = getLastToolCall(r.messages);
	if (lastTool) {
		const actStr = formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme));
		const prefixStub = `├─ act: [${r.usage.toolCalls}] - `;
		const budget = getTruncationBudget(visibleLength(prefixStub));
		const actFullText = stripAnsi(lowerFirstWord(actStr));
		let actContent: string;
		if (scrambleManager.getMode() === 'stream') {
			actContent = scrambleManager.streamAct(id, actFullText, now, isComplete, budget);
		} else {
			const displayAct = truncateChars(actFullText, budget);
			actContent = scrambleManager.updateAct(id, displayAct, now, isComplete).content;
		}
		const actPrefix = `├─ act: [${r.usage.toolCalls}] - `;
		container.addChild(new TruncatedText(`${theme.fg("dim", actPrefix)}${italic(actContent)}`, 0, 0));
	}

	// msg: line (last assistant text or streaming)
	const msgPrefixStub = `└─ msg: [${formatCompactTokenPair(r.usage)}] - `;
	const msgBudget = getTruncationBudget(visibleLength(msgPrefixStub));

	let rawMsg: string;
	let useError = false;
	if (r.exitCode === -1 && streamingText) {
		rawMsg = stripAnsi(streamingText);
	} else if (r.structuredOutput?.summary) {
		rawMsg = stripAnsi(r.structuredOutput.summary);
	} else if (flowOutput) {
		rawMsg = stripAnsi(flowOutput);
	} else if (streamingText) {
		rawMsg = stripAnsi(streamingText);
	} else if (error && r.errorMessage) {
		rawMsg = stripAnsi(r.errorMessage);
		useError = true;
	} else {
		rawMsg = "[n/a]";
	}

	let msgContent: string;
	if (scrambleManager.getMode() === 'stream') {
		msgContent = scrambleManager.streamMsg(id, rawMsg, now, isComplete, msgBudget);
	} else {
		const needsTail = (r.exitCode === -1 && streamingText) || streamingText;
		const displayMsg = needsTail ? tailText(rawMsg, msgBudget) : truncateChars(rawMsg, msgBudget);
		msgContent = scrambleManager.updateMsg(id, displayMsg, now, isComplete).content;
	}
	const msgPrefix = `└─ msg: [${formatCompactTokenPair(r.usage)}] - `;
	container.addChild(new TruncatedText(
		`${theme.fg("dim", msgPrefix)}${theme.fg(useError ? "error" : "dim", italic(msgContent))}`,
		0, 0,
	));

	if (isComplete) {
		scrambleManager.completeFlow(id);
	}

	return container;
}

// ---------------------------------------------------------------------------
// Multi-flow result
// ---------------------------------------------------------------------------

function renderMultiFlowResult(
	details: FlowDetails,
	expanded: boolean,
	theme: FlowTheme,
	toolCallId?: string,
): Container | Text {
	const baseId = toolCallId || "multi";
	const results = details.results;
	const successCount = results.filter((r) => isFlowSuccess(r)).length;
	const failCount = results.filter((r) => isFlowError(r)).length;
	const icon = failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✔");

	if (expanded) {
		return renderMultiFlowExpanded(results, successCount, icon, theme);
	}
	return renderMultiFlowCollapsed(results, theme, baseId);
}

function renderMultiFlowExpanded(
	results: SingleResult[],
	successCount: number,
	icon: string,
	theme: FlowTheme,
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();

	// Summary: just show count, no icon
	container.addChild(new Text(
		theme.fg("accent", `${results.length} flows`),
		0, 0,
	));

	for (const r of results) {
		const displayItems = getFlowDisplayItems(r.messages);
		const flowOutput = getFlowOutput(r.messages);
		const typeName = formatFlowTypeName(r.type);

		container.addChild(new Spacer(1));
		// Per-flow header: ─── EXPLORER (no icon)
		container.addChild(new Text(theme.fg("muted", sectionHeader(typeName)), 0, 0));

		// Stats: dashboard format
		const flowStats = formatCompactStats(r.usage, r.model);
		container.addChild(new Text(theme.fg("dim", flowStats), 0, 0));

		// Intent: just show text, no prefix
		container.addChild(new Text(theme.fg("dim", r.intent), 0, 0));

		if (r.acceptance) {
			container.addChild(new Text(theme.fg("dim", `Acceptance: ${r.acceptance}`), 0, 0));
		}

		if (flowOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(flowOutput.trim(), 0, 0, mdTheme));
		}

		// Tool traces in expanded view
		const toolTraces = renderToolTraces(displayItems, theme);
		if (toolTraces) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", sectionHeader("tool calls")), 0, 0));
			container.addChild(new Text(toolTraces, 0, 0));
		}
	}

	// Total stats: dashboard format
	const totalUsage = aggregateFlowUsage(results);
	const totalModel = results[0]?.model;
	const totalStats = formatCompactStats(totalUsage, totalModel);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", totalStats), 0, 0));

	return container;
}

function renderActivityPanel(
	results: SingleResult[],
	theme: FlowTheme,
	baseId?: string,
): Container {
	const idPrefix = baseId || "panel";
	const container = new Container();
	const maxWidth = process.stdout.columns ?? 80;
	const now = Date.now();

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const isLast = i === results.length - 1;
		const flowId = `${idPrefix}#${i}`;
		const stats = formatCompactStats(r.usage, r.model, maxWidth, { skipTokens: true, skipContext: true, hideModel: true });

		// Flash TPS value when it changes
		const tpsMatch = stats.match(/tps:\s*(\S+)/);
		const flowComplete = r.exitCode !== -1;
		let displayStats = stats;
		if (tpsMatch) {
			const scrambledTps = scrambleManager.updateTps(flowId, tpsMatch[1], now, flowComplete);
			if (scrambledTps !== tpsMatch[1]) {
				displayStats = stats.replace(tpsMatch[1], scrambledTps);
			}
		}

		const error = isFlowError(r);
		const typeName = formatCollapsedFlowHeaderTypeName(r.type);

		// Header line
		const headerPrefix = isLast ? "└─" : "├─";
		const modelLabel = r.model ? r.model.replace(/^[^/]+\//, "").toLowerCase() : "";
		let headerLine = `${theme.fg("dim", headerPrefix)} ${theme.fg("accent", theme.bold(typeName))}${theme.fg("dim", modelLabel ? ` - ${modelLabel} - ` : " - ")}${theme.fg("dim", displayStats)}`;
		if (error && r.stopReason) {
			headerLine += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		}
		container.addChild(new TruncatedText(headerLine, 0, 0));

		// Continuation indent for sub-lines
		const indent = isLast ? "   " : "│  ";

		// aim: line — no animation, content stays still
		if (r.aim) {
			const countdown = getLiveCountdown(r);
			const treePrefix = indent + "├─";
			const aimPrefix = countdown
				? `${treePrefix} aim: [${countdown}] - `
				: `${treePrefix} aim: `;
			const budget = getTruncationBudget(visibleLength(aimPrefix));
			const displayAim = truncateChars(lowerFirstWord(r.aim), budget);
			container.addChild(new TruncatedText(`${theme.fg("dim", aimPrefix)}${theme.fg("dim", italic(displayAim))}`, 0, 0));
		}

		// act: line (last tool call with count)
		const lastTool = getLastToolCall(r.messages);
		if (lastTool) {
			const actStr = formatFlowToolCall(lastTool.name, lastTool.args, theme.fg.bind(theme));
			const prefixStub = `${indent}├─ act: [${r.usage.toolCalls}] - `;
			const budget = getTruncationBudget(visibleLength(prefixStub));
			const actFullText = stripAnsi(lowerFirstWord(actStr));
			let actContent: string;
			if (scrambleManager.getMode() === 'stream') {
				actContent = scrambleManager.streamAct(flowId, actFullText, now, flowComplete, budget);
			} else {
				const displayAct = truncateChars(actFullText, budget);
				actContent = scrambleManager.updateAct(flowId, displayAct, now, flowComplete).content;
			}
			const actPrefix = `${indent}├─ act: [${r.usage.toolCalls}] - `;
			container.addChild(new TruncatedText(`${theme.fg("dim", actPrefix)}${italic(actContent)}`, 0, 0));
		}

		// msg: line (live streaming text or last assistant text)
		const msgPrefixStub = `${indent}└─ msg: [${formatCompactTokenPair(r.usage)}] - `;
		const msgBudget = getTruncationBudget(visibleLength(msgPrefixStub));
		const liveText = r.exitCode === -1 ? r.streamingText : undefined;
		const lastText = liveText || getLastAssistantText(r.messages);

		let rawMsg: string;
		let useError = false;
		if (lastText) {
			rawMsg = stripAnsi(lastText);
		} else if (error && r.errorMessage) {
			rawMsg = stripAnsi(r.errorMessage);
			useError = true;
		} else {
			rawMsg = "[n/a]";
		}

		let msgContent: string;
		if (scrambleManager.getMode() === 'stream') {
			msgContent = scrambleManager.streamMsg(flowId, rawMsg, now, flowComplete, msgBudget);
		} else {
			const needsTail = Boolean(liveText || lastText);
			const displayMsg = needsTail ? tailText(rawMsg, msgBudget) : truncateChars(rawMsg, msgBudget);
			msgContent = scrambleManager.updateMsg(flowId, displayMsg, now, flowComplete).content;
		}
		const msgPrefix = `${indent}└─ msg: [${formatCompactTokenPair(r.usage)}] - `;
		container.addChild(new TruncatedText(
			`${theme.fg("dim", msgPrefix)}${theme.fg(useError ? "error" : "dim", italic(msgContent))}`,
			0, 0,
		));

		if (flowComplete) {
			scrambleManager.completeFlow(flowId);
		}

		// Add blank line separator between flows (with continuation pipe)
		if (!isLast) {
			container.addChild(new TruncatedText(theme.fg("dim", "│"), 0, 0));
		}
	}

	container.addChild(new TruncatedText(theme.fg("muted", "(Ctrl+O to expand tool traces)"), 0, 0));

	return container;
}

function renderMultiFlowCollapsed(
	results: SingleResult[],
	theme: FlowTheme,
	baseId?: string,
): Container {
	return renderActivityPanel(results, theme, baseId);
}

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ReplacedSessionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { registeredCommands } from "../tests/__mocks__/pi-coding-agent.js";
import { setupSpecMode } from "../src/spec-mode.js";
import {
	isSpecModeActive,
	setSpecModeActive,
	makeSlidingPromptMessage,
	SLIDING_PROMPT,
	IMPLEMENT_PROMPT,
} from "../src/sliding-prompt.js";

function createMockPi(): ExtensionAPI & { emitTurnEnd(event: TurnEndEvent, ctx: ExtensionCommandContext): void } {
	const handlers: Record<string, Function[]> = {};
	return {
		registerFlag: vi.fn(),
		on: vi.fn((event: string, handler: Function) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		}),
		emit: vi.fn(),
		emitTurnEnd: (event: TurnEndEvent, ctx: ExtensionCommandContext) => {
			for (const h of handlers["turn_end"] ?? []) {
				h(event, ctx);
			}
		},
		registerTool: vi.fn(),
		setActiveTools: vi.fn(),
		getActiveTools: vi.fn(() => []),
		getFlag: vi.fn(),
		registerCommand: vi.fn((name: string, config: any) => {
			registeredCommands.set(name, config);
		}),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI & { emitTurnEnd(event: TurnEndEvent, ctx: ExtensionCommandContext): void };
}

function createMockCtx(options?: { newSessionCancelled?: boolean }) {
	const notifyCalls: { msg: string; type: string }[] = [];
	const sentUserMessages: string[] = [];
	const editorTexts: string[] = [];
	const newSessionId = "new-session-456";
	const newCtx = {
		cwd: "/tmp/test",
		hasUI: true,
		ui: {
			confirm: vi.fn(async () => false),
			notify: vi.fn((msg: string, type: string) => {
				notifyCalls.push({ msg, type });
			}),
			select: vi.fn(async () => null),
			input: vi.fn(async () => null),
			custom: vi.fn(async () => undefined),
			setEditorText: vi.fn((text: string) => {
				editorTexts.push(text);
			}),
		},
		sessionManager: { getSessionDir: () => "/tmp", getHeader: () => ({}), getBranch: () => [], getSessionId: () => newSessionId },
		sendUserMessage: vi.fn(async (msg: string) => {
			sentUserMessages.push(msg);
		}),
	} as unknown as ReplacedSessionContext;
	const ctx = {
		cwd: "/tmp/test",
		hasUI: true,
		ui: {
			confirm: vi.fn(async () => false),
			notify: vi.fn((msg: string, type: string) => {
				notifyCalls.push({ msg, type });
			}),
			select: vi.fn(async () => null),
			input: vi.fn(async () => null),
			custom: vi.fn(async () => undefined),
			setEditorText: vi.fn((text: string) => {
				editorTexts.push(text);
			}),
		},
		sessionManager: { getSessionDir: () => "/tmp", getHeader: () => ({}), getBranch: () => [], getSessionId: () => "old-session-123" },
		newSession: vi.fn(async (opts?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> }) => {
			const cancelled = options?.newSessionCancelled ?? false;
			if (!cancelled && opts?.withSession) {
				await opts.withSession(newCtx);
			}
			return { cancelled };
		}),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
		waitForIdle: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	} as unknown as ExtensionCommandContext;
	return { ctx, notifyCalls, sentUserMessages, editorTexts, newCtx };
}

describe("setupSpecMode", () => {
	beforeEach(() => {
		registeredCommands.clear();
		setSpecModeActive(true); // reset to default
	});

	it("registers the spec command and turn_end listener", () => {
		const pi = createMockPi();
		setupSpecMode(pi);

		expect(registeredCommands.has("spec")).toBe(true);
		expect(registeredCommands.get("spec")!.description).toContain("Toggle");
		expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
	});

	it("toggles spec mode off and captures assistant plan into editor", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls, sentUserMessages, editorTexts, newCtx } = createMockCtx();

		expect(isSpecModeActive()).toBe(true);
		await command.handler("", ctx);
		expect(isSpecModeActive()).toBe(false);
		expect(ctx.newSession).toHaveBeenCalled();
		expect(notifyCalls.some((n) => n.msg === "Spec mode deactivated")).toBe(true);
		expect(sentUserMessages).toContain("Synthesize a full implementation plan from the conversation history. Output ONLY the complete markdown spec (no tool calls after you start writing). After you finish, the plan will be placed in the editor for review.");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();

		// Simulate assistant responding with the plan in the NEW session
		pi.emitTurnEnd(
			{ message: { role: "assistant", content: [{ type: "text", text: "# Plan\n\nImplement caching." }] } },
			newCtx as unknown as ExtensionCommandContext,
		);
		expect(editorTexts).toContain("# Plan\n\nImplement caching.");
	});

	it("does not capture non-assistant turns", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, editorTexts, newCtx } = createMockCtx();

		await command.handler("", ctx);

		// Simulate a user turn in the new session — should be ignored
		pi.emitTurnEnd(
			{ message: { role: "user", content: "some user text" } },
			newCtx as unknown as ExtensionCommandContext,
		);
		expect(editorTexts).toHaveLength(0);
	});

	it("captures only the first assistant turn then stops listening", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, editorTexts, newCtx } = createMockCtx();

		await command.handler("", ctx);

		pi.emitTurnEnd(
			{ message: { role: "assistant", content: [{ type: "text", text: "First plan" }] } },
			newCtx as unknown as ExtensionCommandContext,
		);
		expect(editorTexts).toContain("First plan");

		// Second assistant turn in the new session should be ignored
		pi.emitTurnEnd(
			{ message: { role: "assistant", content: [{ type: "text", text: "Second plan" }] } },
			newCtx as unknown as ExtensionCommandContext,
		);
		expect(editorTexts).toHaveLength(1);
		expect(editorTexts).not.toContain("Second plan");
	});

	it("stays in spec mode when newSession is cancelled", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls, sentUserMessages, editorTexts } = createMockCtx({ newSessionCancelled: true });

		expect(isSpecModeActive()).toBe(true);
		await command.handler("", ctx);
		expect(isSpecModeActive()).toBe(true);
		expect(ctx.newSession).toHaveBeenCalled();
		expect(notifyCalls.some((n) => n.msg === "Spec mode deactivated")).toBe(false);
		expect(sentUserMessages).toHaveLength(0);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(editorTexts).toHaveLength(0);
	});

	it("toggles spec mode on", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls } = createMockCtx();

		setSpecModeActive(false);
		expect(isSpecModeActive()).toBe(false);
		await command.handler("", ctx);
		expect(isSpecModeActive()).toBe(true);
		expect(notifyCalls.some((n) => n.msg === "Spec mode activated")).toBe(true);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("forwards a prompt and activates spec mode", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls } = createMockCtx();

		setSpecModeActive(false);
		expect(isSpecModeActive()).toBe(false);
		await command.handler("design a caching layer", ctx);
		expect(isSpecModeActive()).toBe(true);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("design a caching layer");
		expect(notifyCalls.some((n) => n.msg === "Spec mode activated")).toBe(true);
	});

	it("trims whitespace from the forwarded prompt", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx } = createMockCtx();

		setSpecModeActive(false);
		await command.handler("  build auth flow  ", ctx);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("build auth flow");
	});
});

describe("makeSlidingPromptMessage mode switching", () => {
	beforeEach(() => {
		setSpecModeActive(true);
	});

	it("returns spec prompt when spec mode is active", () => {
		setSpecModeActive(true);
		const msg = makeSlidingPromptMessage();
		expect(msg.content).toBe(SLIDING_PROMPT);
	});

	it("returns implement prompt when spec mode is inactive", () => {
		setSpecModeActive(false);
		const msg = makeSlidingPromptMessage();
		expect(msg.content).toBe(IMPLEMENT_PROMPT);
	});
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registeredCommands, registerCommand } from "../tests/__mocks__/pi-coding-agent.js";
import { setupSpecMode, SPEC_CONTEXT_TYPE } from "../src/spec-mode.js";

function createMockPi(): ExtensionAPI {
	const handlers: Record<string, Function[]> = {};

	return {
		registerFlag: vi.fn(),
		on: vi.fn((event: string, handler: Function) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		}),
		emit: vi.fn(),
		registerTool: vi.fn(),
		setActiveTools: vi.fn(),
		getActiveTools: vi.fn(() => []),
		getFlag: vi.fn(),
		registerCommand: vi.fn((name: string, config: any) => {
			registeredCommands.set(name, config);
		}),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;
}

function createMockCtx(overrides: Partial<{ hasUI: boolean; confirmResult: boolean; notifyCalls: { msg: string; type: string }[] }> = {}) {
	const notifyCalls: { msg: string; type: string }[] = [];
	const ctx = {
		cwd: "/tmp/test",
		hasUI: overrides.hasUI ?? true,
		ui: {
			confirm: vi.fn(async () => overrides.confirmResult ?? false),
			notify: vi.fn((msg: string, type: string) => {
				notifyCalls.push({ msg, type });
			}),
			select: vi.fn(async () => null),
			input: vi.fn(async () => null),
			custom: vi.fn(async () => undefined),
		},
	};
	return { ctx, notifyCalls };
}

describe("setupSpecMode", () => {
	beforeEach(() => {
		registeredCommands.clear();
	});

	it("registers the spec command", () => {
		const pi = createMockPi();
		setupSpecMode(pi);

		expect(registeredCommands.has("spec")).toBe(true);
		expect(registeredCommands.get("spec")!.description).toBe(
			"Enter spec-driven mode: investigate, discuss, produce spec.",
		);
	});

	it("activates spec mode and injects prompt on before_agent_start", async () => {
		const pi = createMockPi();
		const handlers: Record<string, Function[]> = {};
		(pi.on as any).mockImplementation((event: string, handler: Function) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		});

		setupSpecMode(pi);

		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls } = createMockCtx();
		await command.handler("Add JWT auth", ctx);

		expect(notifyCalls.some((n) => n.msg === "Spec mode activated")).toBe(true);

		// Verify sendUserMessage was called to auto-trigger agent turn
		expect(pi.sendUserMessage).toHaveBeenCalledWith("Add JWT auth");

		// Trigger before_agent_start
		const beforeStartHandlers = handlers["before_agent_start"];
		expect(beforeStartHandlers).toBeDefined();
		expect(beforeStartHandlers!.length).toBeGreaterThan(0);

		// Find the spec-mode handler (last registered one)
		const specHandler = beforeStartHandlers![beforeStartHandlers!.length - 1];
		const result = await specHandler({});

		expect(result).toBeDefined();
		expect(result.message.customType).toBe(SPEC_CONTEXT_TYPE);
		expect(result.message.display).toBe(false);
		expect(result.message.content).toContain("[SPEC MODE ACTIVE]");
		expect(result.message.content).toContain("User's request: Add JWT auth");
	});

	it("deactivates spec mode after one-shot injection", async () => {
		const pi = createMockPi();
		const handlers: Record<string, Function[]> = {};
		(pi.on as any).mockImplementation((event: string, handler: Function) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		});

		setupSpecMode(pi);

		const command = registeredCommands.get("spec")!;
		const { ctx } = createMockCtx();
		await command.handler("Build caching layer", ctx);

		const beforeStartHandlers = handlers["before_agent_start"]!;
		const specHandler = beforeStartHandlers[beforeStartHandlers.length - 1];

		// First trigger — should inject
		const result1 = await specHandler({});
		expect(result1).toBeDefined();

		// Second trigger — should NOT inject (one-shot)
		const result2 = await specHandler({});
		expect(result2).toBeUndefined();
	});

	it("allows exiting spec mode via confirm", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);

		const command = registeredCommands.get("spec")!;

		// Activate first
		const { ctx, notifyCalls } = createMockCtx();
		await command.handler("Some feature", ctx);

		// Simulate user confirming exit
		const exitCtx = createMockCtx({ confirmResult: true });
		await command.handler("", exitCtx.ctx);

		expect(exitCtx.notifyCalls.some((n) => n.msg === "Spec mode deactivated.")).toBe(true);
	});

it("shows usage warning when no description is provided", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);

		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls } = createMockCtx();
		await command.handler("", ctx);

		expect(notifyCalls.some((n) => n.msg.includes("Usage: /spec"))).toBe(true);
		// Should NOT trigger agent turn for empty input
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("deactivates silently when no UI is available", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);

		const command = registeredCommands.get("spec")!;

		// Activate first
		const { ctx } = createMockCtx();
		await command.handler("Some feature", ctx);

		// Exit without UI
		const noUICtx = createMockCtx({ hasUI: false });
		await command.handler("", noUICtx.ctx);

		expect(noUICtx.notifyCalls.some((n) => n.msg.includes("deactivated (no UI)"))).toBe(true);
	});
});

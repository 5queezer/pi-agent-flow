import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registeredCommands } from "../tests/__mocks__/pi-coding-agent.js";
import { setupSpecMode } from "../src/spec-mode.js";
import {
	isSpecModeActive,
	setSpecModeActive,
	makeSlidingPromptMessage,
	SLIDING_PROMPT,
	IMPLEMENT_PROMPT,
} from "../src/sliding-prompt.js";

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

function createMockCtx() {
	const notifyCalls: { msg: string; type: string }[] = [];
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
		},
	};
	return { ctx, notifyCalls };
}

describe("setupSpecMode", () => {
	beforeEach(() => {
		registeredCommands.clear();
		setSpecModeActive(true); // reset to default
	});

	it("registers the spec command", () => {
		const pi = createMockPi();
		setupSpecMode(pi);

		expect(registeredCommands.has("spec")).toBe(true);
		expect(registeredCommands.get("spec")!.description).toContain("Toggle");
	});

	it("toggles spec mode off", async () => {
		const pi = createMockPi();
		setupSpecMode(pi);
		const command = registeredCommands.get("spec")!;
		const { ctx, notifyCalls } = createMockCtx();

		expect(isSpecModeActive()).toBe(true);
		await command.handler("", ctx);
		expect(isSpecModeActive()).toBe(false);
		expect(notifyCalls.some((n) => n.msg === "Spec mode deactivated")).toBe(true);
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

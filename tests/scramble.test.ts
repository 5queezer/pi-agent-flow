/**
 * Unit tests for the Hermes radial ripple text scramble effect.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyRipples, ScrambleStateManager, type ScrambleResult } from "../src/scramble.js";
import type { SingleResult, UsageStats } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIM_ON = "\x1b[2m";
const DIM_OFF = "\x1b[0m";

/** Strip ANSI escape sequences for comparison. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Check if string contains dim ANSI codes. */
function hasDimAnsi(s: string): boolean {
	return s.includes(DIM_ON);
}

/** Create a minimal SingleResult for testing. */
function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		type: "scout",
		agentSource: "user",
		intent: "test intent",
		aim: "test aim",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1, toolCalls: 1 },
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// applyRipples tests
// ---------------------------------------------------------------------------

describe("applyRipples", () => {
	it("returns original text when no ripples", () => {
		const result = applyRipples("hello world", [], Date.now());
		expect(result).toBe("hello world");
	});

	it("returns original text when all ripples have expired", () => {
		const now = Date.now();
		const expiredRipple = { pos: 5, time: now - 1000, dur: 500, spread: 1 };
		const result = applyRipples("hello world", [expiredRipple], now);
		expect(stripAnsi(result)).toBe("hello world");
	});

	it("scrambles characters within the ripple depth band", () => {
		const now = Date.now();
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples("hello world", [ripple], now);
		// The visible text should be the same length (spaces preserved)
		expect(stripAnsi(result).length).toBe("hello world".length);
		// Some chars should be scrambled (dim ANSI present)
		expect(hasDimAnsi(result)).toBe(true);
	});

	it("preserves spaces untouched", () => {
		const now = Date.now();
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples("a b c d e", [ripple], now);
		const stripped = stripAnsi(result);
		// Spaces at positions 1, 3, 5, 7 should be preserved
		expect(stripped[1]).toBe(" ");
		expect(stripped[3]).toBe(" ");
		expect(stripped[5]).toBe(" ");
		expect(stripped[7]).toBe(" ");
	});

	it("wraps scrambled chars in dim ANSI codes", () => {
		const now = Date.now();
		const ripple = { pos: 2, time: now - 50, dur: 666, spread: 1 };
		const result = applyRipples("abcdef", [ripple], now);
		// Should contain dim-on and dim-off sequences
		expect(result).toContain(DIM_ON);
		expect(result).toContain(DIM_OFF);
		// Scrambled chars should be between DIM_ON and DIM_OFF
		const match = result.match(new RegExp(`${DIM_ON.replace("[", "\\[")}(.+?)${DIM_OFF.replace("[", "\\[")}`));
		expect(match).toBeTruthy();
	});

	it("restores characters after ripple expires", () => {
		const spawnTime = Date.now() - 700; // ripple started 700ms ago
		const ripple = { pos: 3, time: spawnTime, dur: 666, spread: 1 };
		const now = spawnTime + 700; // 700ms after spawn, past 666ms duration
		const result = applyRipples("hello world", [ripple], now);
		expect(stripAnsi(result)).toBe("hello world");
		expect(hasDimAnsi(result)).toBe(false);
	});

	it("handles empty text", () => {
		const now = Date.now();
		const ripple = { pos: 0, time: now - 50, dur: 666, spread: 1 };
		const result = applyRipples("", [ripple], now);
		expect(result).toBe("");
	});

	it("handles text shorter than ripple radius", () => {
		const now = Date.now();
		const ripple = { pos: 1, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples("ab", [ripple], now);
		// Should still produce 2 visible chars
		expect(stripAnsi(result).length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// ScrambleStateManager tests
// ---------------------------------------------------------------------------

describe("ScrambleStateManager", () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
	});

	it("updateAim spawns ripple on text change", () => {
		const r = makeResult();
		const base = 1000000;

		manager.updateAim(r, "initial text", base);
		// Change text past cooldown — spawns content + label ripples
		manager.updateAim(r, "changed text", base + 300);
		// Check 100ms into content ripple (666ms duration) — should be actively scrambling
		const result = manager.updateAim(r, "changed text", base + 400);

		expect(result.isAnimating).toBe(true);
		expect(hasDimAnsi(result.content)).toBe(true);
		// Label ripple (200ms, spread=0.5) may have already passed by 100ms
		// so we only verify content scramble
	});

	it("updateAct spawns ripple on toolCalls change", () => {
		const r = makeResult();
		const now = Date.now();

		manager.updateAct(r, "read file.ts", 1, now);
		const result = manager.updateAct(r, "read file.ts", 2, now + 300);

		// Same text but different toolCalls → KPI change triggers ripple
		expect(result.isAnimating).toBe(true);
	});

	it("updateMsg spawns ripple on token count change", () => {
		const r = makeResult();
		const now = Date.now();
		const usage1: UsageStats = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1, toolCalls: 1 };
		const usage2: UsageStats = { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1, toolCalls: 1 };

		manager.updateMsg(r, "same text", usage1, now);
		const result = manager.updateMsg(r, "same text", usage2, now + 300);

		// Same text but different token counts → KPI change triggers ripple
		expect(result.isAnimating).toBe(true);
	});

	it("does not spawn ripple within cooldown", () => {
		const r = makeResult();
		const base = 2000000;

		manager.updateAim(r, "text one", base);
		// Change text within cooldown (100ms < 200ms cooldown)
		// Cooldown blocks ripple spawning but lastText is still updated
		manager.updateAim(r, "text two", base + 100);
		// After ripple duration has expired (base + 666 + a bit), check with same text
		// No new ripple should be spawned because text hasn't changed
		const result = manager.updateAim(r, "text two", base + 800);

		// No animation since no ripples are active and text didn't change
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe("text two");
	});

	it("idle flip spawns after 5 seconds", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5); // deterministic word selection
		const r = makeResult();
		const now = Date.now();

		manager.updateAim(r, "map the directory", now);
		// Advance past idle flip interval
		const result = manager.updateAim(r, "map the directory", now + 5500);

		// Idle flip should trigger a ripple
		expect(result.isAnimating).toBe(true);
		vi.restoreAllMocks();
	});

	it("label flash spawns on content change", () => {
		const r = makeResult();
		const base = 3000000;

		manager.updateAim(r, "original", base);
		// Change content — spawns label ripple (200ms duration)
		manager.updateAim(r, "updated", base + 300);
		// Check 50ms into the label flash
		const result = manager.updateAim(r, "updated", base + 350);

		expect(hasDimAnsi(result.label)).toBe(true);
	});

	it("returns original text when no animation is active", () => {
		const r = makeResult();
		const now = Date.now();

		const result = manager.updateAim(r, "stable text", now);
		// First call initializes — no change from empty, so no ripples
		expect(stripAnsi(result.content)).toBe("stable text");
		expect(stripAnsi(result.label)).toBe("aim:");
	});

	it("same text and KPI twice does not trigger new ripple", () => {
		const r = makeResult();
		const now = Date.now();

		manager.updateAim(r, "same text", now);
		const result = manager.updateAim(r, "same text", now + 300);

		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe("same text");
	});
});

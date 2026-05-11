/**
 * Unit tests for the Hermes radial ripple text scramble effect.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyRipples, ScrambleStateManager, type ScrambleResult } from '../src/scramble.js';
import type { UsageStats } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIM_ON = '[2m';
const DIM_OFF = '[22m';

/** Strip ANSI escape sequences for comparison. */
function stripAnsi(s: string): string {
	return s.replace(/\[[0-9;]*m/g, '');
}

/** Check if string contains dim ANSI codes. */
function hasDimAnsi(s: string): boolean {
	return s.includes(DIM_ON);
}

const TEST_ID = 'test-id';

function makeUsage(overrides: Partial<UsageStats> = {}): UsageStats {
	return {
		input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1, toolCalls: 1,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// applyRipples tests
// ---------------------------------------------------------------------------

describe('applyRipples', () => {
	it('returns original text when no ripples', () => {
		const result = applyRipples('hello world', [], Date.now());
		expect(result).toBe('hello world');
	});

	it('returns original text when all ripples have expired', () => {
		const now = Date.now();
		const expiredRipple = { pos: 5, time: now - 1000, dur: 500, spread: 1 };
		const result = applyRipples('hello world', [expiredRipple], now);
		expect(stripAnsi(result)).toBe('hello world');
	});

	it('scrambles characters within the ripple depth band', () => {
		const now = Date.now();
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples('hello world', [ripple], now);
		expect(stripAnsi(result).length).toBe('hello world'.length);
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('preserves spaces untouched', () => {
		const now = Date.now();
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples('a b c d e', [ripple], now);
		const stripped = stripAnsi(result);
		expect(stripped[1]).toBe(' ');
		expect(stripped[3]).toBe(' ');
		expect(stripped[5]).toBe(' ');
		expect(stripped[7]).toBe(' ');
	});

	it('wraps scrambled chars in dim ANSI codes', () => {
		const now = Date.now();
		const ripple = { pos: 2, time: now - 50, dur: 666, spread: 1 };
		const result = applyRipples('abcdef', [ripple], now);
		expect(result).toContain(DIM_ON);
		expect(result).toContain(DIM_OFF);
		const match = result.match(new RegExp());
		expect(match).toBeTruthy();
	});

	it('restores characters after ripple expires', () => {
		const spawnTime = Date.now() - 700;
		const ripple = { pos: 3, time: spawnTime, dur: 666, spread: 1 };
		const now = spawnTime + 700;
		const result = applyRipples('hello world', [ripple], now);
		expect(stripAnsi(result)).toBe('hello world');
		expect(hasDimAnsi(result)).toBe(false);
	});

	it('handles empty text', () => {
		const now = Date.now();
		const ripple = { pos: 0, time: now - 50, dur: 666, spread: 1 };
		const result = applyRipples('', [ripple], now);
		expect(result).toBe('');
	});

	it('handles text shorter than ripple radius', () => {
		const now = Date.now();
		const ripple = { pos: 1, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples('ab', [ripple], now);
		expect(stripAnsi(result).length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// ScrambleStateManager tests
// ---------------------------------------------------------------------------

describe('ScrambleStateManager', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
	});

	it('updateAim spawns ripple on text change', () => {
		const base = 1000000;
		manager.updateAim(TEST_ID, 'initial text', base);
		manager.updateAim(TEST_ID, 'changed text', base + 300);
		const result = manager.updateAim(TEST_ID, 'changed text', base + 400);

		expect(result.isAnimating).toBe(true);
		expect(hasDimAnsi(result.content)).toBe(true);
	});

	it('updateAct spawns ripple on toolCalls change', () => {
		const now = Date.now();
		const usage = makeUsage();
		manager.updateAct(TEST_ID, 'read file.ts', 1, usage, now);
		const result = manager.updateAct(TEST_ID, 'read file.ts', 2, usage, now + 300);

		expect(result.isAnimating).toBe(true);
	});

	it('updateMsg spawns ripple on token count change', () => {
		const now = Date.now();
		const usage1 = makeUsage({ input: 100, output: 50 });
		const usage2 = makeUsage({ input: 200, output: 80 });

		manager.updateMsg(TEST_ID, 'same text', usage1, now);
		const result = manager.updateMsg(TEST_ID, 'same text', usage2, now + 300);

		expect(result.isAnimating).toBe(true);
	});

	it('does not spawn ripple within cooldown', () => {
		const base = 2000000;
		manager.updateAim(TEST_ID, 'text one', base);
		manager.updateAim(TEST_ID, 'text two', base + 100);
		const result = manager.updateAim(TEST_ID, 'text two', base + 800);

		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('text two');
	});

	it('idle flip spawns after 5 seconds', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const now = Date.now();
		manager.updateAim(TEST_ID, 'map the directory', now);
		const result = manager.updateAim(TEST_ID, 'map the directory', now + 5500);

		expect(result.isAnimating).toBe(true);
		vi.restoreAllMocks();
	});

	it('label flash spawns on content change', () => {
		const base = 3000000;
		manager.updateAim(TEST_ID, 'original', base);
		manager.updateAim(TEST_ID, 'updated', base + 300);
		const result = manager.updateAim(TEST_ID, 'updated', base + 350);

		expect(hasDimAnsi(result.label)).toBe(true);
	});

	it('returns original text when no animation is active', () => {
		const now = Date.now();
		const result = manager.updateAim(TEST_ID, 'stable text', now);
		expect(stripAnsi(result.content)).toBe('stable text');
		expect(stripAnsi(result.label)).toBe('aim:');
	});

	it('same text and KPI twice does not trigger new ripple', () => {
		const now = Date.now();
		manager.updateAim(TEST_ID, 'same text', now);
		const result = manager.updateAim(TEST_ID, 'same text', now + 300);

		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('same text');
	});

	it('hasActiveRipples returns true while ripples are alive', () => {
		const now = Date.now();
		manager.updateAim(TEST_ID, 'init', now);
		expect(manager.hasActiveRipples(TEST_ID, now)).toBe(false);

		manager.updateAim(TEST_ID, 'changed', now + 300);
		expect(manager.hasActiveRipples(TEST_ID, now + 300)).toBe(true);
		expect(manager.hasActiveRipples(TEST_ID, now + 300 + 1000)).toBe(false);
	});

	it('hasActiveRipples checks label ripples too', () => {
		const now = Date.now();
		manager.updateAim(TEST_ID, 'init', now);
		manager.updateAim(TEST_ID, 'text', now + 300);
		expect(manager.hasActiveRipples(TEST_ID, now + 300 + 100)).toBe(true);
		expect(manager.hasActiveRipples(TEST_ID, now + 300 + 700)).toBe(false);
	});

	it('hasAnyActiveRipples checks all ids', () => {
		const now = Date.now();
		manager.updateAim('id-a', 'hello', now);
		manager.updateAim('id-b', 'world', now);
		expect(manager.hasAnyActiveRipples(now)).toBe(false);

		// Change text on id-a to spawn ripple
		manager.updateAim('id-a', 'hello!', now + 300);
		expect(manager.hasAnyActiveRipples(now + 300)).toBe(true);
		expect(manager.hasAnyActiveRipples(now + 300 + 1000)).toBe(false);
	});
});

/**
 * Unit tests for the Illuminate/Arcane radial ripple text scramble effect.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyRipples, ScrambleStateManager } from '../src/scramble.js';
import type { UsageStats } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';

/** Strip ANSI escape sequences for comparison. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, '');
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

	it('uses deep glitch chars at depth 1-2 (heavy blocks)', () => {
		const now = Date.now();
		// Enough elapsed for ripple wavefront to reach chars near center
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples('hello world', [ripple], now);
		// Scrambled chars near wavefront should be from DEEP_GLITCH set
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('uses shallow glitch chars at depth 4 (greek/math)', () => {
		const now = Date.now();
		// Late in ripple: depth ~4 at the trailing edge
		const ripple = { pos: 5, time: now - 400, dur: 666, spread: 1 };
		const result = applyRipples('hello world', [ripple], now);
		expect(hasDimAnsi(result)).toBe(true);
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

	it('updateAim does NOT spawn content ripple on text change (noContentRipple)', () => {
		const base = 1000000;
		manager.updateAim(TEST_ID, 'initial text', base);
		const result = manager.updateAim(TEST_ID, 'changed text', base + 300);
		// Content should NOT have a content ripple from text change
		expect(stripAnsi(result.content)).toBe('changed text');
		expect(result.isAnimating).toBe(false);
	});

	it('updateAim still does idle word flip after 5s', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const base = 1000000;
		manager.updateAim(TEST_ID, 'map the directory', base);
		// Idle flip spawns at 5s — check 10ms into the idle ripple (dur=300, spread=2)
		manager.updateAim(TEST_ID, 'map the directory', base + 5500);
		const result = manager.updateAim(TEST_ID, 'map the directory', base + 5510);
		expect(result.isAnimating).toBe(true);
		expect(hasDimAnsi(result.content)).toBe(true);
		vi.restoreAllMocks();
	});

	it('updateAim label is always plain (no scramble)', () => {
		const base = 3000000;
		manager.updateAim(TEST_ID, 'original', base);
		const result = manager.updateAim(TEST_ID, 'updated', base + 300);
		expect(result.label).toBe('aim:');
		expect(hasDimAnsi(result.label)).toBe(false);
	});

	it('updateAct label is always plain (no scramble)', () => {
		const now = Date.now();
		const usage = makeUsage();
		manager.updateAct(TEST_ID, 'read file.ts', 1, usage, now);
		const result = manager.updateAct(TEST_ID, 'read file.ts', 2, usage, now + 300);
		expect(result.label).toBe('act:');
		expect(hasDimAnsi(result.label)).toBe(false);
	});

	it('updateMsg label is always plain (no scramble)', () => {
		const now = Date.now();
		const usage = makeUsage();
		manager.updateMsg(TEST_ID, 'text', usage, now);
		const result = manager.updateMsg(TEST_ID, 'text', usage, now);
		expect(result.label).toBe('msg:');
		expect(hasDimAnsi(result.label)).toBe(false);
	});

	it('updateAct spawns no content ripple on toolCalls change', () => {
		const now = Date.now();
		const usage = makeUsage();
		manager.updateAct(TEST_ID, 'read file.ts', 1, usage, now);
		const result = manager.updateAct(TEST_ID, 'read file.ts', 2, usage, now + 300);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('read file.ts');
	});

	it('updateMsg spawns ripple on token count change', () => {
		const now = Date.now();
		const usage1 = makeUsage({ input: 100, output: 50 });
		const usage2 = makeUsage({ input: 200, output: 80 });
		manager.updateMsg(TEST_ID, 'same text', usage1, now);
		const result = manager.updateMsg(TEST_ID, 'same text', usage2, now + 300);
		expect(result.isAnimating).toBe(true);
	});

	it('does not spawn ripple within cooldown (250ms)', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'text one', makeUsage({ input: 100 }), base);
		// Spawns a ripple (first change, cooldown from initial=0 is trivially passed)
		manager.updateMsg(TEST_ID, 'text two', makeUsage({ input: 200 }), base + 300);
		expect(manager.hasActiveRipples(TEST_ID, base + 300)).toBe(true);

		// Within cooldown — change is suppressed, no new ripple
		manager.updateMsg(TEST_ID, 'text three', makeUsage({ input: 300 }), base + 400);
		// After first ripple expires (300 + 666 = 966), check that no new ripple was spawned
		const result = manager.updateMsg(TEST_ID, 'text three', makeUsage({ input: 300 }), base + 1000);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('text three');
	});

	it('same text and KPI twice does not trigger new ripple', () => {
		const now = Date.now();
		const usage = makeUsage();
		manager.updateMsg(TEST_ID, 'same text', usage, now);
		const result = manager.updateMsg(TEST_ID, 'same text', usage, now + 300);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('same text');
	});

	it('returns original text when no animation is active', () => {
		const now = Date.now();
		const result = manager.updateAim(TEST_ID, 'stable text', now);
		expect(stripAnsi(result.content)).toBe('stable text');
		expect(result.label).toBe('aim:');
	});

	it('hasActiveRipples returns true while ripples are alive', () => {
		const now = Date.now();
		manager.updateMsg(TEST_ID, 'init', makeUsage(), now);
		expect(manager.hasActiveRipples(TEST_ID, now)).toBe(false);
		manager.updateMsg(TEST_ID, 'changed', makeUsage({ input: 999 }), now + 300);
		expect(manager.hasActiveRipples(TEST_ID, now + 300)).toBe(true);
		expect(manager.hasActiveRipples(TEST_ID, now + 300 + 1000)).toBe(false);
	});

	it('hasAnyActiveRipples checks all ids', () => {
		const now = Date.now();
		manager.updateMsg('id-a', 'hello', makeUsage(), now);
		manager.updateMsg('id-b', 'world', makeUsage(), now);
		expect(manager.hasAnyActiveRipples(now)).toBe(false);
		manager.updateMsg('id-a', 'hello!', makeUsage({ input: 999 }), now + 300);
		expect(manager.hasAnyActiveRipples(now + 300)).toBe(true);
		expect(manager.hasAnyActiveRipples(now + 300 + 1000)).toBe(false);
	});

	// ---------------------------------------------------------------------------
	// Countdown flash tests
	// ---------------------------------------------------------------------------

	describe('updateCountdown', () => {
		it('returns unchanged countdown on first call', () => {
			const now = Date.now();
			const result = manager.updateCountdown(TEST_ID, '02:30', now);
			expect(result).toBe('02:30');
		});

		it('flashes countdown when value changes', () => {
			const base = 5000000;
			manager.updateCountdown(TEST_ID, '02:30', base);
			// Spawn the flash
			manager.updateCountdown(TEST_ID, '02:29', base + 100);
			// Check 5ms into the 150ms flash — the ripple should be in progress
			const result = manager.updateCountdown(TEST_ID, '02:29', base + 105);
			expect(hasDimAnsi(result)).toBe(true);
		});

		it('restores countdown after flash expires', () => {
			const base = 5000000;
			manager.updateCountdown(TEST_ID, '02:30', base);
			manager.updateCountdown(TEST_ID, '02:29', base + 100);
			// After flash duration (150ms) + some buffer
			const result = manager.updateCountdown(TEST_ID, '02:29', base + 400);
			expect(result).toBe('02:29');
			expect(hasDimAnsi(result)).toBe(false);
		});

		it('returns empty string for empty countdown', () => {
			const now = Date.now();
			const result = manager.updateCountdown(TEST_ID, '', now);
			expect(result).toBe('');
		});

		it('same countdown twice does not re-trigger flash', () => {
			const base = 5000000;
			manager.updateCountdown(TEST_ID, '05:00', base);
			const result = manager.updateCountdown(TEST_ID, '05:00', base + 300);
			expect(result).toBe('05:00');
			expect(hasDimAnsi(result)).toBe(false);
		});
	});

	// ---------------------------------------------------------------------------
	// TPS flash tests
	// ---------------------------------------------------------------------------

	describe('updateTps', () => {
		it('returns unchanged TPS on first call', () => {
			const now = Date.now();
			const result = manager.updateTps(TEST_ID, '42.3', now);
			expect(result).toBe('42.3');
		});

		it('flashes TPS when value changes', () => {
			const base = 6000000;
			manager.updateTps(TEST_ID, '42.3', base);
			// Spawn the flash
			manager.updateTps(TEST_ID, '51.7', base + 100);
			// Check 5ms into the 150ms flash
			const result = manager.updateTps(TEST_ID, '51.7', base + 105);
			expect(hasDimAnsi(result)).toBe(true);
		});

		it('restores TPS after flash expires', () => {
			const base = 6000000;
			manager.updateTps(TEST_ID, '42.3', base);
			manager.updateTps(TEST_ID, '51.7', base + 100);
			const result = manager.updateTps(TEST_ID, '51.7', base + 400);
			expect(result).toBe('51.7');
			expect(hasDimAnsi(result)).toBe(false);
		});

		it('skips flash for dash placeholder', () => {
			const now = Date.now();
			const result = manager.updateTps(TEST_ID, '-', now);
			expect(result).toBe('-');
		});

		it('skips flash for empty string', () => {
			const now = Date.now();
			const result = manager.updateTps(TEST_ID, '', now);
			expect(result).toBe('');
		});

		it('same TPS twice does not re-trigger flash', () => {
			const base = 6000000;
			manager.updateTps(TEST_ID, '33.0', base);
			const result = manager.updateTps(TEST_ID, '33.0', base + 300);
			expect(result).toBe('33.0');
			expect(hasDimAnsi(result)).toBe(false);
		});
	});

	it('hasAnyActiveRipples includes countdown and TPS ripples', () => {
		const base = 7000000;
		manager.updateCountdown(TEST_ID, '02:30', base);
		manager.updateTps(TEST_ID, '42.3', base);
		// No ripples yet (first call)
		expect(manager.hasAnyActiveRipples(base)).toBe(false);

		// Trigger countdown flash
		manager.updateCountdown(TEST_ID, '02:29', base + 100);
		expect(manager.hasAnyActiveRipples(base + 100)).toBe(true);

		// After countdown flash expires
		expect(manager.hasAnyActiveRipples(base + 400)).toBe(false);

		// Trigger TPS flash
		manager.updateTps(TEST_ID, '51.7', base + 500);
		expect(manager.hasAnyActiveRipples(base + 500)).toBe(true);
	});

	it('clear resets all state including countdown and TPS', () => {
		const now = Date.now();
		manager.updateCountdown(TEST_ID, '02:30', now);
		manager.updateTps(TEST_ID, '42.3', now);
		manager.clear();
		// After clear, first call should not flash
		const result = manager.updateCountdown(TEST_ID, '02:29', now + 100);
		expect(result).toBe('02:29'); // no flash (treated as first call)
	});
});

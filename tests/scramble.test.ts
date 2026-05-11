/**
 * Unit tests for dual-mode text scramble effect (cascade + ripple).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	applyRipples,
	buildQueue,
	computeCascadeFrame,
	ScrambleStateManager,
	DEFAULT_MODE,
} from '../src/scramble.js';
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
// Cascade algorithm tests
// ---------------------------------------------------------------------------

describe('buildQueue', () => {
	it('creates queue with correct length for same-length texts', () => {
		const queue = buildQueue('hello', 'world');
		expect(queue.length).toBe(5);
	});

	it('creates queue with max length when texts differ in length', () => {
		const queue = buildQueue('hi', 'hello');
		expect(queue.length).toBe(5);
	});

	it('sets from/to chars correctly', () => {
		const queue = buildQueue('abc', 'xyz');
		expect(queue[0].from).toBe('a');
		expect(queue[0].to).toBe('x');
		expect(queue[2].from).toBe('c');
		expect(queue[2].to).toBe('z');
	});

	it('uses empty string for from when old text is shorter', () => {
		const queue = buildQueue('ab', 'abcd');
		expect(queue[2].from).toBe('');
		expect(queue[2].to).toBe('c');
	});

	it('assigns random but valid start/end frames', () => {
		const queue = buildQueue('test', 'test');
		for (const item of queue) {
			expect(item.start).toBeGreaterThanOrEqual(0);
			expect(item.end).toBeGreaterThanOrEqual(item.start);
		}
	});
});

describe('computeCascadeFrame', () => {
	it('resolves all chars at max end frame', () => {
		const queue = buildQueue('hello', 'world');
		const maxEnd = Math.max(...queue.map(q => q.end));
		const result = computeCascadeFrame(queue, maxEnd + 1);
		expect(stripAnsi(result)).toBe('world');
	});

	it('shows scramble chars during animation with dim ANSI', () => {
		const queue = buildQueue('hello', 'world');
		// Frame 20 — some chars should be scrambling
		const result = computeCascadeFrame(queue, 20);
		// At least some dim codes should be present (random, but likely)
		expect(result.length).toBeGreaterThan(0);
	});

	it('preserves spaces (target char is space)', () => {
		const queue = buildQueue('a b', 'x y');
		// At max frame, spaces should be spaces
		const maxEnd = Math.max(...queue.map(q => q.end));
		const result = computeCascadeFrame(queue, maxEnd + 1);
		expect(stripAnsi(result)).toBe('x y');
		expect(result.includes(' ')).toBe(true);
	});

	it('completes animation eventually', () => {
		const queue = buildQueue('short', 'longer text here');
		const maxEnd = Math.max(...queue.map(q => q.end));
		const result = computeCascadeFrame(queue, maxEnd + 100);
		expect(stripAnsi(result)).toBe('longer text here');
		expect(hasDimAnsi(result)).toBe(false);
	});

	it('handles empty from chars (new text longer)', () => {
		const queue = buildQueue('', 'abc');
		// Frame 0 — before any start, should show scramble chars for empty from
		const result = computeCascadeFrame(queue, 0);
		expect(result.length).toBeGreaterThan(0);
		// At max end, should resolve
		const maxEnd = Math.max(...queue.map(q => q.end));
		const final = computeCascadeFrame(queue, maxEnd + 1);
		expect(stripAnsi(final)).toBe('abc');
	});
});

// ---------------------------------------------------------------------------
// Ripple algorithm tests
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
});

// ---------------------------------------------------------------------------
// ScrambleStateManager — CASCADE mode tests
// ---------------------------------------------------------------------------

describe('ScrambleStateManager (cascade mode)', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		expect(manager.getMode()).toBe('cascade');
	});

	it('defaults to cascade mode', () => {
		expect(DEFAULT_MODE).toBe('cascade');
	});

	it('updateAim does NOT spawn content animation on text change', () => {
		const base = 1000000;
		manager.updateAim(TEST_ID, 'initial text', base);
		const result = manager.updateAim(TEST_ID, 'changed text', base + 300);
		expect(stripAnsi(result.content)).toBe('changed text');
		expect(result.isAnimating).toBe(false);
	});

	it('updateAim does idle word flip after 5s', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const base = 1000000;
		manager.updateAim(TEST_ID, 'map the directory', base);
		// 5s later, idle flip should spawn
		const result = manager.updateAim(TEST_ID, 'map the directory', base + 5500);
		expect(result.isAnimating).toBe(true);
		vi.restoreAllMocks();
	});

	it('updateMsg spawns cascade on text change', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'initial', makeUsage(), base);
		const result = manager.updateMsg(TEST_ID, 'changed text', makeUsage({ input: 999 }), base + 300);
		expect(result.isAnimating).toBe(true);
		expect(hasDimAnsi(result.content)).toBe(true);
	});

	it('updateMsg cascade self-terminates', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'initial', makeUsage(), base);
		manager.updateMsg(TEST_ID, 'changed text', makeUsage({ input: 999 }), base + 300);
		// After max cascade duration (80 frames * 16ms = 1280ms), should be done
		const result = manager.updateMsg(TEST_ID, 'changed text', makeUsage({ input: 999 }), base + 300 + 1500);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('changed text');
	});

	it('updateAct does NOT spawn content animation', () => {
		const now = Date.now();
		const usage = makeUsage();
		manager.updateAct(TEST_ID, 'read file.ts', 1, usage, now);
		const result = manager.updateAct(TEST_ID, 'read file.ts', 2, usage, now + 300);
		expect(result.isAnimating).toBe(false);
	});

	it('label is always plain text', () => {
		const now = Date.now();
		manager.updateAim(TEST_ID, 'test', now);
		manager.updateAct(TEST_ID, 'test', 1, makeUsage(), now);
		manager.updateMsg(TEST_ID, 'test', makeUsage(), now);
		const aimResult = manager.updateAim(TEST_ID, 'changed', now + 300);
		const actResult = manager.updateAct(TEST_ID, 'test', 2, makeUsage(), now + 300);
		const msgResult = manager.updateMsg(TEST_ID, 'changed', makeUsage({ input: 999 }), now + 300);
		expect(aimResult.label).toBe('aim:');
		expect(actResult.label).toBe('act:');
		expect(msgResult.label).toBe('msg:');
	});

	it('cooldown prevents rapid-fire cascades', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'text one', makeUsage({ input: 100 }), base);
		// First change — spawns cascade
		manager.updateMsg(TEST_ID, 'text two', makeUsage({ input: 200 }), base + 300);
		// Within cooldown — change suppressed
		manager.updateMsg(TEST_ID, 'text three', makeUsage({ input: 300 }), base + 400);
		// After cooldown + cascade duration — no pending animation
		const result = manager.updateMsg(TEST_ID, 'text three', makeUsage({ input: 300 }), base + 2000);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('text three');
	});

	// Countdown flash in cascade mode
	describe('updateCountdown (cascade)', () => {
		it('returns unchanged countdown on first call', () => {
			const now = Date.now();
			expect(manager.updateCountdown(TEST_ID, '02:30', now)).toBe('02:30');
		});

		it('flashes countdown when value changes', () => {
			const base = 5000000;
			manager.updateCountdown(TEST_ID, '02:30', base);
			manager.updateCountdown(TEST_ID, '02:29', base + 100);
			// Check during flash
			const result = manager.updateCountdown(TEST_ID, '02:29', base + 120);
			expect(hasDimAnsi(result)).toBe(true);
		});

		it('restores countdown after flash completes', () => {
			const base = 5000000;
			manager.updateCountdown(TEST_ID, '02:30', base);
			manager.updateCountdown(TEST_ID, '02:29', base + 100);
			// After max flash duration (13 frames * 16ms ≈ 208ms)
			const result = manager.updateCountdown(TEST_ID, '02:29', base + 500);
			expect(result).toBe('02:29');
			expect(hasDimAnsi(result)).toBe(false);
		});
	});

	// TPS flash in cascade mode
	describe('updateTps (cascade)', () => {
		it('returns unchanged TPS on first call', () => {
			const now = Date.now();
			expect(manager.updateTps(TEST_ID, '42.3', now)).toBe('42.3');
		});

		it('flashes TPS when value changes', () => {
			const base = 6000000;
			manager.updateTps(TEST_ID, '42.3', base);
			manager.updateTps(TEST_ID, '51.7', base + 100);
			const result = manager.updateTps(TEST_ID, '51.7', base + 120);
			expect(hasDimAnsi(result)).toBe(true);
		});

		it('skips flash for dash placeholder', () => {
			expect(manager.updateTps(TEST_ID, '-', Date.now())).toBe('-');
		});
	});

	it('hasAnyActiveAnimations works for cascade', () => {
		const base = 7000000;
		manager.updateMsg(TEST_ID, 'init', makeUsage(), base);
		expect(manager.hasAnyActiveAnimations(base)).toBe(false);
		manager.updateMsg(TEST_ID, 'changed', makeUsage({ input: 999 }), base + 300);
		expect(manager.hasAnyActiveAnimations(base + 300)).toBe(true);
		expect(manager.hasAnyActiveAnimations(base + 300 + 1500)).toBe(false);
	});

	it('clear resets all state', () => {
		const now = Date.now();
		manager.updateCountdown(TEST_ID, '02:30', now);
		manager.updateTps(TEST_ID, '42.3', now);
		manager.clear();
		const result = manager.updateCountdown(TEST_ID, '02:29', now + 100);
		expect(result).toBe('02:29');
	});
});

// ---------------------------------------------------------------------------
// ScrambleStateManager — RIPPLE mode tests
// ---------------------------------------------------------------------------

describe('ScrambleStateManager (ripple mode)', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('ripple');
		expect(manager.getMode()).toBe('ripple');
	});

	it('updateMsg spawns ripple on text change', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'initial', makeUsage(), base);
		// Spawn the ripple
		manager.updateMsg(TEST_ID, 'changed', makeUsage({ input: 999 }), base + 300);
		// Check a few ms into the ripple (it needs elapsed time to scramble)
		const result = manager.updateMsg(TEST_ID, 'changed', makeUsage({ input: 999 }), base + 310);
		expect(result.isAnimating).toBe(true);
		expect(hasDimAnsi(result.content)).toBe(true);
	});

	it('updateAim does NOT spawn content ripple on text change', () => {
		const base = 1000000;
		manager.updateAim(TEST_ID, 'initial text', base);
		const result = manager.updateAim(TEST_ID, 'changed text', base + 300);
		expect(stripAnsi(result.content)).toBe('changed text');
		expect(result.isAnimating).toBe(false);
	});

	it('updateAim idle word flip works in ripple mode', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const base = 1000000;
		manager.updateAim(TEST_ID, 'map the directory', base);
		const result = manager.updateAim(TEST_ID, 'map the directory', base + 5500);
		expect(result.isAnimating).toBe(true);
		vi.restoreAllMocks();
	});

	it('updateAct does NOT spawn content ripple', () => {
		const now = Date.now();
		const usage = makeUsage();
		manager.updateAct(TEST_ID, 'read file.ts', 1, usage, now);
		const result = manager.updateAct(TEST_ID, 'read file.ts', 2, usage, now + 300);
		expect(result.isAnimating).toBe(false);
	});

	it('same text and KPI twice does not trigger new ripple', () => {
		const now = Date.now();
		const usage = makeUsage();
		manager.updateMsg(TEST_ID, 'same text', usage, now);
		const result = manager.updateMsg(TEST_ID, 'same text', usage, now + 300);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('same text');
	});

	it('countdown flash works in ripple mode', () => {
		const base = 5000000;
		manager.updateCountdown(TEST_ID, '02:30', base);
		manager.updateCountdown(TEST_ID, '02:29', base + 100);
		const result = manager.updateCountdown(TEST_ID, '02:29', base + 105);
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('TPS flash works in ripple mode', () => {
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		manager.updateTps(TEST_ID, '51.7', base + 100);
		const result = manager.updateTps(TEST_ID, '51.7', base + 105);
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('hasAnyActiveAnimations works for ripple', () => {
		const base = 7000000;
		manager.updateMsg(TEST_ID, 'init', makeUsage(), base);
		expect(manager.hasAnyActiveAnimations(base)).toBe(false);
		manager.updateMsg(TEST_ID, 'changed', makeUsage({ input: 999 }), base + 300);
		expect(manager.hasAnyActiveAnimations(base + 300)).toBe(true);
		expect(manager.hasAnyActiveAnimations(base + 300 + 1000)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Mode switching tests
// ---------------------------------------------------------------------------

describe('ScrambleStateManager mode switching', () => {
	it('setMode clears all state', () => {
		const manager = new ScrambleStateManager();
		const base = 1000000;
		manager.updateMsg(TEST_ID, 'initial', makeUsage(), base);
		manager.updateMsg(TEST_ID, 'changed', makeUsage({ input: 999 }), base + 300);
		// Switch mode — should clear everything
		manager.setMode('ripple');
		expect(manager.getMode()).toBe('ripple');
		// First call after switch should not animate
		const result = manager.updateMsg(TEST_ID, 'new text', makeUsage(), base + 500);
		expect(result.isAnimating).toBe(false);
	});

	it('can switch back and forth', () => {
		const manager = new ScrambleStateManager();
		expect(manager.getMode()).toBe('cascade');
		manager.setMode('ripple');
		expect(manager.getMode()).toBe('ripple');
		manager.setMode('cascade');
		expect(manager.getMode()).toBe('cascade');
	});
});

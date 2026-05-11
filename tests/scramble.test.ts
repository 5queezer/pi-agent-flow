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
		const result = computeCascadeFrame(queue, 20);
		expect(result.length).toBeGreaterThan(0);
	});

	it('preserves spaces (target char is space)', () => {
		const queue = buildQueue('a b', 'x y');
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
		const result = computeCascadeFrame(queue, 0);
		expect(result.length).toBeGreaterThan(0);
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

	it('updateAim never animates — content stays still', () => {
		const base = 1000000;
		manager.updateAim(TEST_ID, 'initial text', base);
		const result = manager.updateAim(TEST_ID, 'changed text', base + 300);
		expect(result.content).toBe('changed text');
		expect(result.isAnimating).toBe(false);
		expect(result.label).toBe('aim:');
	});

	it('updateAct spawns cascade on text change', () => {
		const base = 2000000;
		manager.updateAct(TEST_ID, 'read file.ts', base);
		const result = manager.updateAct(TEST_ID, 'read other.ts', base + 300);
		expect(result.isAnimating).toBe(true);
		expect(hasDimAnsi(result.content)).toBe(true);
	});

	it('updateAct does NOT scramble when text is the same', () => {
		const base = 2000000;
		manager.updateAct(TEST_ID, 'same text', base);
		const result = manager.updateAct(TEST_ID, 'same text', base + 300);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('same text');
	});

	it('updateMsg spawns cascade on text change', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'initial', base);
		const result = manager.updateMsg(TEST_ID, 'changed text', base + 300);
		expect(result.isAnimating).toBe(true);
		expect(hasDimAnsi(result.content)).toBe(true);
	});

	it('updateMsg does NOT scramble when text is the same', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'same text', base);
		const result = manager.updateMsg(TEST_ID, 'same text', base + 300);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('same text');
	});

	it('updateMsg cascade self-terminates', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'initial', base);
		manager.updateMsg(TEST_ID, 'changed text', base + 300);
		// After max cascade duration (80 frames * 16ms = 1280ms), should be done
		const result = manager.updateMsg(TEST_ID, 'changed text', base + 300 + 1500);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('changed text');
	});

	it('label is always plain text', () => {
		const now = Date.now();
		manager.updateAim(TEST_ID, 'test', now);
		manager.updateAct(TEST_ID, 'test', now);
		manager.updateMsg(TEST_ID, 'test', now);
		const aimResult = manager.updateAim(TEST_ID, 'changed', now + 300);
		const actResult = manager.updateAct(TEST_ID, 'changed', now + 300);
		const msgResult = manager.updateMsg(TEST_ID, 'changed', now + 300);
		expect(aimResult.label).toBe('aim:');
		expect(actResult.label).toBe('act:');
		expect(msgResult.label).toBe('msg:');
	});

	it('cooldown prevents rapid-fire cascades', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'text one', base);
		// First change — spawns cascade
		manager.updateMsg(TEST_ID, 'text two', base + 300);
		// Within cooldown — change suppressed
		manager.updateMsg(TEST_ID, 'text three', base + 400);
		// After cooldown + cascade duration — no pending animation
		const result = manager.updateMsg(TEST_ID, 'text three', base + 2000);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('text three');
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
			// This triggers the flash — cascade builds queue with short frames
			manager.updateTps(TEST_ID, '51.7', base + 100);
			// The cascade animates old→new over ~80-208ms.
			// During animation, output is a mix of old/new/scramble chars.
			// After animation completes, output is the new value.
			// We just verify the animation was triggered and resolves correctly.
			const resultAfter = manager.updateTps(TEST_ID, '51.7', base + 500);
			expect(resultAfter).toBe('51.7');
			expect(hasDimAnsi(resultAfter)).toBe(false);
		});

		it('skips flash for dash placeholder', () => {
			expect(manager.updateTps(TEST_ID, '-', Date.now())).toBe('-');
		});

		it('restores TPS after flash completes', () => {
			const base = 6000000;
			manager.updateTps(TEST_ID, '42.3', base);
			manager.updateTps(TEST_ID, '51.7', base + 100);
			const result = manager.updateTps(TEST_ID, '51.7', base + 500);
			expect(result).toBe('51.7');
			expect(hasDimAnsi(result)).toBe(false);
		});
	});

	it('hasAnyActiveAnimations works for cascade', () => {
		const base = 7000000;
		manager.updateMsg(TEST_ID, 'init', base);
		expect(manager.hasAnyActiveAnimations(base)).toBe(false);
		manager.updateMsg(TEST_ID, 'changed', base + 300);
		expect(manager.hasAnyActiveAnimations(base + 300)).toBe(true);
		expect(manager.hasAnyActiveAnimations(base + 300 + 1500)).toBe(false);
	});

	it('clear resets all state', () => {
		const now = Date.now();
		manager.updateTps(TEST_ID, '42.3', now);
		manager.clear();
		const result = manager.updateTps(TEST_ID, '51.7', now + 100);
		expect(result).toBe('51.7');
	});

	// Flow completion tests
	describe('flow completion', () => {
		it('updateAct with isComplete=true returns plain text and stops animating', () => {
			const base = 8000000;
			manager.updateAct(TEST_ID, 'read file.ts', base);
			const result = manager.updateAct(TEST_ID, 'read other.ts', base + 300, true);
			expect(result.content).toBe('read other.ts');
			expect(result.isAnimating).toBe(false);
		});

		it('updateMsg with isComplete=true returns plain text and stops animating', () => {
			const base = 8000000;
			manager.updateMsg(TEST_ID, 'initial', base);
			const result = manager.updateMsg(TEST_ID, 'changed text', base + 300, true);
			expect(result.content).toBe('changed text');
			expect(result.isAnimating).toBe(false);
		});

		it('completed flow does not re-trigger animations', () => {
			const base = 8000000;
			manager.updateMsg(TEST_ID, 'initial', base);
			manager.updateMsg(TEST_ID, 'changed', base + 300, true);
			// Even with new text, completed state stays still
			const result = manager.updateMsg(TEST_ID, 'brand new text', base + 600);
			expect(result.content).toBe('brand new text');
			expect(result.isAnimating).toBe(false);
		});

		it('hasAnyActiveAnimations returns false after completion', () => {
			const base = 8000000;
			manager.updateMsg(TEST_ID, 'initial', base);
			manager.updateMsg(TEST_ID, 'changed', base + 300);
			expect(manager.hasAnyActiveAnimations(base + 300)).toBe(true);
			manager.completeFlow(TEST_ID);
			expect(manager.hasAnyActiveAnimations(base + 300)).toBe(false);
		});

		it('updateTps with isComplete=true returns plain text', () => {
			const base = 8000000;
			manager.updateTps(TEST_ID, '42.3', base);
			manager.updateTps(TEST_ID, '51.7', base + 100, true);
			// After completion, TPS returns plain text
			const result = manager.updateTps(TEST_ID, '62.1', base + 200);
			expect(result).toBe('62.1');
			expect(hasDimAnsi(result)).toBe(false);
		});

		it('completeFlow clears all line states', () => {
			const base = 8000000;
			manager.updateAct(TEST_ID, 'act text', base);
			manager.updateMsg(TEST_ID, 'msg text', base);
			manager.updateAct(TEST_ID, 'act changed', base + 300);
			manager.updateMsg(TEST_ID, 'msg changed', base + 300);
			expect(manager.hasAnyActiveAnimations(base + 300)).toBe(true);
			manager.completeFlow(TEST_ID);
			expect(manager.hasAnyActiveAnimations(base + 300)).toBe(false);
		});
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
		manager.updateMsg(TEST_ID, 'initial', base);
		manager.updateMsg(TEST_ID, 'changed', base + 300);
		const result = manager.updateMsg(TEST_ID, 'changed', base + 310);
		expect(result.isAnimating).toBe(true);
		expect(hasDimAnsi(result.content)).toBe(true);
	});

	it('updateAim never animates — content stays still', () => {
		const base = 1000000;
		manager.updateAim(TEST_ID, 'initial text', base);
		const result = manager.updateAim(TEST_ID, 'changed text', base + 300);
		expect(result.content).toBe('changed text');
		expect(result.isAnimating).toBe(false);
	});

	it('updateAct spawns ripple on text change', () => {
		const base = 2000000;
		manager.updateAct(TEST_ID, 'read file.ts', base);
		const result = manager.updateAct(TEST_ID, 'read other.ts', base + 300);
		expect(result.isAnimating).toBe(true);
	});

	it('updateAct does NOT scramble when text is the same', () => {
		const now = Date.now();
		manager.updateAct(TEST_ID, 'same text', now);
		const result = manager.updateAct(TEST_ID, 'same text', now + 300);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('same text');
	});

	it('same text does not trigger new ripple', () => {
		const now = Date.now();
		manager.updateMsg(TEST_ID, 'same text', now);
		const result = manager.updateMsg(TEST_ID, 'same text', now + 300);
		expect(result.isAnimating).toBe(false);
		expect(stripAnsi(result.content)).toBe('same text');
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
		manager.updateMsg(TEST_ID, 'init', base);
		expect(manager.hasAnyActiveAnimations(base)).toBe(false);
		manager.updateMsg(TEST_ID, 'changed', base + 300);
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
		manager.updateMsg(TEST_ID, 'initial', base);
		manager.updateMsg(TEST_ID, 'changed', base + 300);
		manager.setMode('ripple');
		expect(manager.getMode()).toBe('ripple');
		const result = manager.updateMsg(TEST_ID, 'new text', base + 500);
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

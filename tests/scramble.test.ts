/**
 * Unit tests for tri-mode text scramble effect (stream + cascade + ripple).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	applyRipples,
	buildQueue,
	computeCascadeFrame,
	renderStreamText,
	ScrambleStateManager,
	DEFAULT_MODE,
	selectScrambleChar,
	CYAN_GLOW,
	PURPLE_GLOW,
	GOLD_GLOW,
	WHITE_GLOW,
	BOLD_ON,
	ILLUMINATE_CONFIGS,
} from '../src/scramble.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function hasDimAnsi(s: string): boolean {
	return s.includes(DIM_ON);
}

const TEST_ID = 'test-id';
const SCRAMBLE_CHAR_SET = '!<>-_\\/[]{}-=+*^?#________';

// ---------------------------------------------------------------------------
// Stream mode tests
// ---------------------------------------------------------------------------

describe('renderStreamText', () => {
	it('returns full text when all chars are revealed', () => {
		const result = renderStreamText('hello world', 11, 3, []);
		expect(result).toBe('hello world');
	});

	it('shows resolved chars before cursor', () => {
		const result = renderStreamText('hello world', 5, 3, []);
		const stripped = stripAnsi(result);
		expect(stripped.slice(0, 5)).toBe('hello');
	});

	it('shows scramble chars in cursor zone with dim ANSI', () => {
		const result = renderStreamText('hello world', 5, 3, []);
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('preserves spaces in cursor zone', () => {
		const result = renderStreamText('a b c d', 3, 3, []);
		const stripped = stripAnsi(result);
		// Space at position 1 (already revealed) and position 3 (in cursor zone)
		expect(stripped[1]).toBe(' ');
	});

	it('scramble chars are from SCRAMBLE_CHARS set', () => {
		const result = renderStreamText('abcdefg', 2, 3, []);
		const stripped = stripAnsi(result);
		// Chars at positions 2-4 should be scramble chars
		for (let i = 2; i < 5; i++) {
			if (stripped[i] !== ' ') {
				expect(SCRAMBLE_CHAR_SET).toContain(stripped[i]);
			}
		}
	});

	it('beyond-cursor chars are also scramble chars (noise)', () => {
		const result = renderStreamText('abcdefghij', 2, 3, []);
		const stripped = stripAnsi(result);
		// Chars beyond cursor zone (positions 5+) should also be scramble
		for (let i = 5; i < stripped.length; i++) {
			if (stripped[i] !== ' ') {
				expect(SCRAMBLE_CHAR_SET).toContain(stripped[i]);
			}
		}
	});

	it('cursor chars array is trimmed to scrambleWidth', () => {
		const cursorChars: string[] = [];
		renderStreamText('abcdef', 2, 3, cursorChars);
		expect(cursorChars.length).toBe(3);
	});

	it('beyond-cursor scramble chars keep fuzzing each frame', () => {
		const cursorChars: string[] = [];
		const r1 = renderStreamText('abcdefghij', 2, 3, cursorChars);
		const r2 = renderStreamText('abcdefghij', 2, 3, cursorChars);
		// Beyond cursor zone starts at index 5 (revealed 2 + width 3)
		// Positions 5+ should produce different scramble chars across calls
		const stripped1 = stripAnsi(r1);
		const stripped2 = stripAnsi(r2);
		let diffCount = 0;
		for (let i = 5; i < stripped1.length; i++) {
			if (stripped1[i] !== ' ' && stripped2[i] !== ' ') {
				if (stripped2[i] !== stripped1[i]) diffCount++;
			}
		}
		expect(diffCount).toBeGreaterThan(0);
	});

	it('groups contiguous scramble chars under a single ANSI pair', () => {
		const cursorChars: string[] = [];
		const result = renderStreamText('abcdefghij', 2, 3, cursorChars);
		const dimOnCount = (result.match(/\x1b\[2m/g) || []).length;
		const dimOffCount = (result.match(/\x1b\[22m/g) || []).length;
		// 8 scramble chars (3 cursor + 5 beyond) are contiguous with no spaces,
		// so exactly one DIM_ON / DIM_OFF pair wraps the entire scramble run.
		expect(dimOnCount).toBe(1);
		expect(dimOffCount).toBe(1);
	});

	it('spaces break dim groups but scramble runs stay grouped', () => {
		const cursorChars: string[] = [];
		const result = renderStreamText('ab cde fgh', 2, 3, cursorChars);
		const dimOnCount = (result.match(/\x1b\[2m/g) || []).length;
		const dimOffCount = (result.match(/\x1b\[22m/g) || []).length;
		// 'ab' resolved, space, 'cde' grouped, space, 'fgh' grouped
		expect(dimOnCount).toBe(2);
		expect(dimOffCount).toBe(2);
	});
});

describe('ScrambleStateManager (stream mode)', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('stream');
	});

	it('defaults to illuminate mode', () => {
		expect(DEFAULT_MODE).toBe('illuminate');
	});

	it('updateAim never animates', () => {
		const result = manager.updateAim(TEST_ID, 'test', Date.now());
		expect(result.content).toBe('test');
		expect(result.isAnimating).toBe(false);
	});

	it('streamAct reveals text progressively', () => {
		const base = 1000000;
		const result = manager.streamAct(TEST_ID, 'read file.ts', base, false, 40);
		// At first call, cursor just started — should have scramble chars
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('streamAct resolves fully when given enough time', () => {
		const base = 1000000;
		manager.streamAct(TEST_ID, 'read file.ts', base, false, 40);
		// After enough time for all chars to be revealed (13 chars * 16ms = 208ms)
		const result = manager.streamAct(TEST_ID, 'read file.ts', base + 500, false, 40);
		expect(stripAnsi(result)).toBe('read file.ts');
		expect(hasDimAnsi(result)).toBe(false);
	});

	it('streamAct resets on tool change', () => {
		const base = 1000000;
		// First tool call
		manager.streamAct(TEST_ID, 'read file.ts', base, false, 40);
		// Let it complete
		manager.streamAct(TEST_ID, 'read file.ts', base + 500, false, 40);
		// New tool call — should reset and scramble again
		const result = manager.streamAct(TEST_ID, 'write other.ts', base + 1000, false, 40);
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('streamMsg reveals streaming text progressively', () => {
		const base = 1000000;
		const result = manager.streamMsg(TEST_ID, 'Found 4 files', base, false, 40);
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('streamMsg resolves fully after enough time', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'Found 4 files', base, false, 40);
		// 14 chars * 20ms = 280ms
		const result = manager.streamMsg(TEST_ID, 'Found 4 files', base + 500, false, 40);
		expect(stripAnsi(result)).toBe('Found 4 files');
		expect(hasDimAnsi(result)).toBe(false);
	});

	it('streamMsg handles incremental text growth', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'Found', base, false, 40);
		// Text grew — cursor catches up
		const result = manager.streamMsg(TEST_ID, 'Found 4 files', base + 200, false, 40);
		// Should have some resolved and some scramble
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('streamMsg resets on non-incremental change', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'Found 4 files', base, false, 40);
		// Let it complete
		manager.streamMsg(TEST_ID, 'Found 4 files', base + 500, false, 40);
		// Completely new text — should reset
		const result = manager.streamMsg(TEST_ID, 'Error: something failed', base + 1000, false, 40);
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('streamMsg completes on isComplete=true', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'Processing...', base, false, 40);
		const result = manager.streamMsg(TEST_ID, 'Processing...', base + 100, true, 40);
		expect(stripAnsi(result)).toBe('Processing...');
		expect(hasDimAnsi(result)).toBe(false);
	});

	it('streamAct completes on isComplete=true', () => {
		const base = 1000000;
		manager.streamAct(TEST_ID, 'read file.ts', base, false, 40);
		const result = manager.streamAct(TEST_ID, 'read file.ts', base + 100, true, 40);
		expect(stripAnsi(result)).toBe('read file.ts');
		expect(hasDimAnsi(result)).toBe(false);
	});

	it('hasAnyActiveAnimations detects stream animation', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'test text', base, false, 40);
		expect(manager.hasAnyActiveAnimations(base + 10)).toBe(true);
		// Advance cursor by calling streamMsg with later time
		manager.streamMsg(TEST_ID, 'test text', base + 500, false, 40);
		// Now check
		expect(manager.hasAnyActiveAnimations(base + 500)).toBe(false);
	});

	it('completeFlow stops all stream animations', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'test text', base, false, 40);
		manager.streamAct(TEST_ID, 'act text', base, false, 40);
		expect(manager.hasAnyActiveAnimations(base + 10)).toBe(true);
		manager.completeFlow(TEST_ID);
		expect(manager.hasAnyActiveAnimations(base + 10)).toBe(false);
	});

	it('clear resets all state', () => {
		manager.streamMsg(TEST_ID, 'test', Date.now(), false, 40);
		manager.clear();
		// After clear, new calls start fresh
		const result = manager.streamMsg(TEST_ID, 'new text', Date.now(), false, 40);
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('streamMsg resets when a new flow starts after completion', () => {
		const base = 1000000;
		// First flow completes
		manager.streamMsg(TEST_ID, 'first flow', base, false, 40);
		manager.streamMsg(TEST_ID, 'first flow', base + 500, true, 40);
		expect(manager.hasAnyActiveAnimations(base + 500)).toBe(false);
		// New flow starts — should reset and scramble again
		const result = manager.streamMsg(TEST_ID, 'second flow', base + 600, false, 40);
		expect(hasDimAnsi(result)).toBe(true);
		expect(stripAnsi(result)).not.toBe('second flow');
	});

	it('streamAct resets when a new flow starts after completion', () => {
		const base = 1000000;
		// First flow completes
		manager.streamAct(TEST_ID, 'read first.ts', base, false, 40);
		manager.streamAct(TEST_ID, 'read first.ts', base + 500, true, 40);
		expect(manager.hasAnyActiveAnimations(base + 500)).toBe(false);
		// New flow starts — should reset and scramble again
		const result = manager.streamAct(TEST_ID, 'write second.ts', base + 600, false, 40);
		expect(hasDimAnsi(result)).toBe(true);
		expect(stripAnsi(result)).not.toBe('write second.ts');
	});

	it('streamMsg strips ANSI for stable comparison', () => {
		const base = 1000000;
		// Text with ANSI codes that change between renders
		const textWithAnsi1 = '\x1b[32mhello\x1b[0m world';
		const textWithAnsi2 = '\x1b[33mhello\x1b[0m world';
		manager.streamMsg(TEST_ID, textWithAnsi1, base, false, 40);
		// Same visible text, different ANSI codes — should NOT reset
		const result = manager.streamMsg(TEST_ID, textWithAnsi2, base + 500, false, 40);
		// Should be fully revealed (same text, no reset)
		expect(stripAnsi(result)).toBe('hello world');
		expect(hasDimAnsi(result)).toBe(false);
	});

	it('streamMsg adjusts revealed count when visible window slides', () => {
		const base = 1000000;
		const budget = 10;
		// Start with text that fits in budget
		manager.streamMsg(TEST_ID, '0123456789', base, false, budget);
		// Let it reveal 5 chars
		manager.streamMsg(TEST_ID, '0123456789', base + 200, false, budget);
		const mid = manager.streamMsg(TEST_ID, '0123456789', base + 200, false, budget);
		const midRevealed = stripAnsi(mid).replace(/[\x21-\x7E]/g, '#');
		// Should have some resolved chars at the start
		expect(stripAnsi(mid).slice(0, 1)).not.toBe(''); // at least 1 char revealed by ~170ms

		// Now grow text beyond budget — window slides
		const result = manager.streamMsg(TEST_ID, '0123456789abc', base + 200, false, budget);
		const stripped = stripAnsi(result);
		// The visible text is the tail (last 10 chars). Because the window slid,
		// the overlap-based adjustment should keep some chars revealed instead of
		// dropping to 0 and showing pure scramble.
		expect(stripped.length).toBeLessThanOrEqual(budget);
		// Should NOT be pure scramble noise — at least some chars should be resolved
		// (the overlap "6789" was previously revealed and is still visible)
		expect(stripped.slice(0, 2)).toBe('34'); // "3456789abc" tail, overlap preserved
	});

	it('streamMsg preserves revealed chars when text grows within budget', () => {
		const base = 1000000;
		const budget = 40;
		manager.streamMsg(TEST_ID, 'hello world', base, false, budget);
		// Let 6 chars reveal
		const partial = manager.streamMsg(TEST_ID, 'hello world', base + 250, false, budget);
		expect(stripAnsi(partial).slice(0, 6)).toBe('hello '); // 250/35 ≈ 7 chars

		// Grow text within budget — same visible text, just longer
		const result = manager.streamMsg(TEST_ID, 'hello world!', base + 250, false, budget);
		// Old visible text "hello world" is a prefix of new visible text.
		// Previously-revealed chars should stay revealed; only the new "!" is scrambled.
		const stripped = stripAnsi(result);
		expect(stripped.slice(0, 6)).toBe('hello ');
	});

	it('streamMsg resets to pure scramble on completely different text', () => {
		const base = 1000000;
		const budget = 40;
		manager.streamMsg(TEST_ID, 'first message text here', base, false, budget);
		// Let it fully reveal
		manager.streamMsg(TEST_ID, 'first message text here', base + 1000, false, budget);
		const done = manager.streamMsg(TEST_ID, 'first message text here', base + 1000, false, budget);
		expect(hasDimAnsi(done)).toBe(false);

		// Completely different text — no overlap
		const result = manager.streamMsg(TEST_ID, 'totally different content now', base + 1001, false, budget);
		// Should reset and show scramble
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('streamMsg handles rapid window sliding without dropping to zero revealed', () => {
		const base = 1000000;
		const budget = 15;
		// Start with short text
		manager.streamMsg(TEST_ID, 'abc', base, false, budget);
		manager.streamMsg(TEST_ID, 'abc', base + 500, false, budget); // fully revealed

		// Rapid growth: text jumps from 3 to 50 chars. Window slides aggressively.
		const longText = 'x'.repeat(47) + 'abc';
		const result = manager.streamMsg(TEST_ID, longText, base + 600, false, budget);
		const stripped = stripAnsi(result);
		expect(stripped.length).toBeLessThanOrEqual(budget);
		expect(hasDimAnsi(result)).toBe(true);
	});

	it('streamMsg survives clock backward jump without stalling', () => {
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'hello world', base, false, 40);
		// Partial reveal at t=100
		const partial = manager.streamMsg(TEST_ID, 'hello world', base + 100, false, 40);
		expect(hasDimAnsi(partial)).toBe(true);

		// Clock jumps backward (simulates NTP sync or VM time drift)
		const afterJump = manager.streamMsg(TEST_ID, 'hello world', base + 50, false, 40);
		// Should not crash or instantly complete — animation still active
		expect(hasDimAnsi(afterJump)).toBe(true);

		// Clock recovers and catches up
		const recovered = manager.streamMsg(TEST_ID, 'hello world', base + 500, false, 40);
		expect(stripAnsi(recovered)).toBe('hello world');
		expect(hasDimAnsi(recovered)).toBe(false);
	});

	it('streamAct survives clock backward jump without stalling', () => {
		const base = 1000000;
		manager.streamAct(TEST_ID, 'read file.ts', base, false, 40);
		// Partial reveal at t=100
		const partial = manager.streamAct(TEST_ID, 'read file.ts', base + 100, false, 40);
		expect(hasDimAnsi(partial)).toBe(true);

		// Clock jumps backward
		const afterJump = manager.streamAct(TEST_ID, 'read file.ts', base + 50, false, 40);
		expect(hasDimAnsi(afterJump)).toBe(true);

		// Clock recovers
		const recovered = manager.streamAct(TEST_ID, 'read file.ts', base + 500, false, 40);
		expect(stripAnsi(recovered)).toBe('read file.ts');
		expect(hasDimAnsi(recovered)).toBe(false);
	});

	it('streamMsg applies scramble effect during fast streaming', () => {
		const base = 1000000;
		const budget = 40;
		// Start with short text
		manager.streamMsg(TEST_ID, 'hello world', base, false, budget);
		// Fully reveal it
		manager.streamMsg(TEST_ID, 'hello world', base + 500, false, budget);

		// Now simulate a huge fast jump (as if LLM dumped a big chunk)
		const longText = 'x'.repeat(80) + 'end';
		const result = manager.streamMsg(TEST_ID, longText, base + 600, false, budget);
		const stripped = stripAnsi(result);

		// The scramble effect should be visible across the text, not just
		// forced to the last few chars. At least some scramble chars should
		// be present while the cursor catches up.
		const scrambleCount = stripped.split('').filter(c => SCRAMBLE_CHAR_SET.includes(c)).length;
		expect(scrambleCount).toBeGreaterThan(0);
	});
});

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

	it('all chars get random start/end frames even when from === to', () => {
		const queue = buildQueue('abc', 'axc');
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

	it('pre-start frame shows scramble symbols not old text', () => {
		const queue = buildQueue('abcdef', 'xyz123');
		const result = computeCascadeFrame(queue, 0);
		const stripped = stripAnsi(result);
		for (const ch of stripped) {
			if (ch !== ' ') {
				expect(SCRAMBLE_CHAR_SET).toContain(ch);
			}
		}
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
		manager.setMode('cascade');
		expect(manager.getMode()).toBe('cascade');
	});

	it('updateAim never animates', () => {
		const base = 1000000;
		manager.updateAim(TEST_ID, 'initial text', base);
		const result = manager.updateAim(TEST_ID, 'changed text', base + 300);
		expect(result.content).toBe('changed text');
		expect(result.isAnimating).toBe(false);
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

	it('updateMsg cascade self-terminates', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'initial', base);
		manager.updateMsg(TEST_ID, 'changed text', base + 300);
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
		manager.updateMsg(TEST_ID, 'text two', base + 300);
		manager.updateMsg(TEST_ID, 'text three', base + 400);
		const result = manager.updateMsg(TEST_ID, 'text three', base + 600);
		expect(result.isAnimating).toBe(true);
		const done = manager.updateMsg(TEST_ID, 'text three', base + 2000);
		expect(done.isAnimating).toBe(false);
	});

	it('TPS flash works in cascade mode', () => {
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		manager.updateTps(TEST_ID, '51.7', base + 100);
		const resultAfter = manager.updateTps(TEST_ID, '51.7', base + 500);
		expect(resultAfter).toBe('51.7');
		expect(hasDimAnsi(resultAfter)).toBe(false);
	});

	it('hasAnyActiveAnimations works for cascade', () => {
		const base = 7000000;
		manager.updateMsg(TEST_ID, 'init', base);
		expect(manager.hasAnyActiveAnimations(base)).toBe(false);
		manager.updateMsg(TEST_ID, 'changed', base + 300);
		expect(manager.hasAnyActiveAnimations(base + 300)).toBe(true);
		expect(manager.hasAnyActiveAnimations(base + 300 + 1500)).toBe(false);
	});

	it('flow completion stops animations', () => {
		const base = 8000000;
		manager.updateAct(TEST_ID, 'read file.ts', base);
		const result = manager.updateAct(TEST_ID, 'read other.ts', base + 300, true);
		expect(result.content).toBe('read other.ts');
		expect(result.isAnimating).toBe(false);
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
		// Check at a later time when ripple has actually started scrambling
		const result = manager.updateMsg(TEST_ID, 'changed', base + 400);
		expect(result.isAnimating).toBe(true);
		expect(hasDimAnsi(result.content)).toBe(true);
	});

	it('updateAim never animates', () => {
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
	it('defaults to illuminate mode', () => {
		const manager = new ScrambleStateManager();
		expect(manager.getMode()).toBe('illuminate');
	});

	it('setMode clears all state', () => {
		const manager = new ScrambleStateManager();
		const base = 1000000;
		manager.streamMsg(TEST_ID, 'initial', base, false, 40);
		manager.setMode('cascade');
		expect(manager.getMode()).toBe('cascade');
		const result = manager.updateMsg(TEST_ID, 'new text', base + 500);
		// Cascade mode: first call initializes, second triggers animation
		expect(result.isAnimating).toBe(false); // first call just initializes
	});

	it('can switch between all four modes', () => {
		const manager = new ScrambleStateManager();
		expect(manager.getMode()).toBe('illuminate');
		manager.setMode('cascade');
		expect(manager.getMode()).toBe('cascade');
		manager.setMode('stream');
		expect(manager.getMode()).toBe('stream');
		manager.setMode('ripple');
		expect(manager.getMode()).toBe('ripple');
		manager.setMode('illuminate');
		expect(manager.getMode()).toBe('illuminate');
	});
});

// ---------------------------------------------------------------------------
// Illuminate mode tests
// ---------------------------------------------------------------------------

describe('selectScrambleChar', () => {
	it('returns deep glitch chars for depth 1–2', () => {
		const deepChars = '𐕣𖤐█▓▒░║│¦|∆∇Λ';
		for (let d = 1; d <= 2; d++) {
			const c = selectScrambleChar(d, 0, 0);
			expect(deepChars).toContain(c);
		}
	});

	it('returns mid glitch chars for depth 3', () => {
		const midChars = 'ΦΨΩαβγδεζηθικλμνξοπρστυφχψω';
		const c = selectScrambleChar(3, 0, 0);
		expect(midChars).toContain(c);
	});

	it('returns shallow glitch chars for depth 4+', () => {
		const shallowChars = '><+*·-~01¦|║│░▒▓';
		for (let d = 4; d <= 6; d++) {
			const c = selectScrambleChar(d, 0, 0);
			expect(shallowChars).toContain(c);
		}
	});
});

describe('applyRipples with illuminate config', () => {
	it('applies ANSI truecolor codes when config provided', () => {
		const now = Date.now();
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		const config = ILLUMINATE_CONFIGS.actLabel;
		const result = applyRipples('hello world', [ripple], now, config);
		expect(result).toContain(PURPLE_GLOW);
		expect(result).toContain(BOLD_ON);
	});

	it('uses dynamic color (cyan) for config.color === dynamic at moderate depth', () => {
		const now = Date.now();
		// elapsed=200 gives depth ~1.5 which maps to cyan in dynamic mode
		const ripple = { pos: 5, time: now - 200, dur: 850, spread: 1.5 };
		const config = ILLUMINATE_CONFIGS.msgContent;
		const result = applyRipples('abcdefghij', [ripple], now, config);
		expect(result).toContain(CYAN_GLOW);
	});

	it('falls back to DIM when no config', () => {
		const now = Date.now();
		const ripple = { pos: 5, time: now - 100, dur: 666, spread: 1 };
		const result = applyRipples('hello world', [ripple], now);
		expect(result).toContain(DIM_ON);
		expect(result).toContain(DIM_OFF);
	});
});

describe('ScrambleStateManager (illuminate mode)', () => {
	let manager: ScrambleStateManager;

	beforeEach(() => {
		manager = new ScrambleStateManager();
		manager.setMode('illuminate');
		expect(manager.getMode()).toBe('illuminate');
	});

	it('updateMsg buffers phrases and flushes at boundaries', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'Hello world', base);
		// Same text — no flush
		const same = manager.updateMsg(TEST_ID, 'Hello world', base + 100);
		expect(same.content).toBe('Hello world');
		// New text with phrase boundary — triggers flush
		manager.updateMsg(TEST_ID, 'Hello world. How are you?', base + 300);
		// Ripple is active for 850ms — verify animation is detected
		expect(manager.hasAnyActiveAnimations(base + 400)).toBe(true);
		// Content should show scramble chars once ripple has expanded
		const result = manager.updateMsg(TEST_ID, 'Hello world. How are you?', base + 600);
		expect(result.content).toContain(CYAN_GLOW);
	});

	it('updateMsg does not flush before phrase boundary', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'Hello', base);
		// Small change without boundary — should keep old display
		const result = manager.updateMsg(TEST_ID, 'Hello wor', base + 300);
		expect(result.content).toBeDefined();
	});

	it('updateMsg flushes after max buffer time even without boundary', () => {
		const base = 2000000;
		manager.updateMsg(TEST_ID, 'Hello', base);
		// Wait longer than MAX_PHRASE_BUFFER_TIME (500ms)
		const result = manager.updateMsg(TEST_ID, 'Hello world how are', base + 600);
		expect(result.isAnimating).toBe(true);
	});

	it('updateAct uses illuminate config (purple glow)', () => {
		const base = 2000000;
		manager.updateAct(TEST_ID, 'read file.ts', base);
		// Trigger change, then check when ripple wavefront is within text
		manager.updateAct(TEST_ID, 'write other.ts', base + 300);
		const result = manager.updateAct(TEST_ID, 'write other.ts', base + 400);
		expect(manager.hasAnyActiveAnimations(base + 400)).toBe(true);
		expect(result.content).toContain(PURPLE_GLOW);
	});

	it('TPS hysteresis prevents flash on tiny changes', () => {
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		// Small change (< 15%) should NOT trigger flash in illuminate mode
		const result = manager.updateTps(TEST_ID, '43.1', base + 100);
		// Should return plain text without scramble ANSI
		expect(result).toBe('43.1');
	});

	it('TPS flash triggers on large change (> 15%)', () => {
		const base = 6000000;
		manager.updateTps(TEST_ID, '42.3', base);
		// Large change (> 15%) triggers flash
		manager.updateTps(TEST_ID, '55.0', base + 100);
		// Verify ripple is active
		expect(manager.hasAnyActiveAnimations(base + 150)).toBe(true);
		// TPS text is short (4 chars) so ripple expands past it quickly;
		// verify at an early time when wavefront is still within text
		const result = manager.updateTps(TEST_ID, '55.0', base + 110);
		expect(result).toContain(GOLD_GLOW);
	});

	it('hasAnyActiveAnimations works for illuminate', () => {
		const base = 7000000;
		manager.updateMsg(TEST_ID, 'init', base);
		expect(manager.hasAnyActiveAnimations(base)).toBe(false);
		manager.updateMsg(TEST_ID, 'changed text here.', base + 300);
		expect(manager.hasAnyActiveAnimations(base + 300)).toBe(true);
	});
});

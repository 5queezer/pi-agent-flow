/**
 * Dual-mode text scramble effect for terminal TUI.
 *
 * Mode 1 — CASCADE (default): Classic TextScramble algorithm (Justin Windle).
 *   Per-character queue with staggered start/end frames. Characters decode
 *   one-by-one in a left-to-right cascade. Self-terminating after ~640ms.
 *
 * Mode 2 — RIPPLE: Hermes radial wave propagation.
 *   Wave expands from a center point. Characters resolve behind the wavefront.
 *   Requires continuous re-renders while the wave is active.
 *
 * Both modes use the classic ASCII-safe character set for maximum terminal
 * compatibility. Ripples/cascades spawn on text/KPI changes, with a 5s idle
 * word flip for aim: lines.
 */

import type { UsageStats } from './types.js';

// ---------------------------------------------------------------------------
// Character set — classic ASCII-safe scramble symbols
// ---------------------------------------------------------------------------

/** Scramble character pool — all ASCII-safe for maximum terminal compatibility */
const SCRAMBLE_CHARS = '!<>-_\\/[]{}-=+*^?#________';

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

const RIPPLE_DUR_DEFAULT = 666;   // ms — full content ripple duration (ripple mode)
const RIPPLE_SPREAD_DEFAULT = 1;  // Hermes default spread (ripple mode)
const IDLE_FLIP_DUR = 300;       // ms — quick idle word flip (ripple mode)
const IDLE_FLIP_DUR_CASCADE = 16 * 25; // ms — idle flip in cascade mode (~25 frames)
const IDLE_FLIP_SPREAD = 2;      // localized ripple spread (ripple mode)
const IDLE_FLIP_INTERVAL = 5000; // ms — time between idle flips
const MIN_RIPPLE_INTERVAL = 250; // ms — cooldown between animations
const DEPTH_BAND_MAX = 3;        // Ripple: 0-3 depth band
const COUNTDOWN_FLASH_DUR = 150;  // ms — countdown flash (ripple mode)
const COUNTDOWN_FLASH_SPREAD = 0.5;
const TPS_FLASH_DUR = 150;       // ms — TPS flash (ripple mode)
const TPS_FLASH_SPREAD = 0.5;
const CASCADE_FRAME_MS = 16;     // ms per cascade frame (~60fps)
const CASCADE_MAX_START = 40;    // max random start frame for cascade queue
const CASCADE_MAX_LENGTH = 40;  // max random length (end - start) for cascade queue
const CASCADE_IDLE_MAX_START = 8;   // shorter range for idle flip
const CASCADE_IDLE_MAX_LENGTH = 12;  // shorter range for idle flip
const CASCADE_FLASH_MAX_START = 5;  // very short for countdown/TPS flash
const CASCADE_FLASH_MAX_LENGTH = 8;  // very short for countdown/TPS flash

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';

// ---------------------------------------------------------------------------
// Mode type
// ---------------------------------------------------------------------------

export type ScrambleMode = 'cascade' | 'ripple';

export const DEFAULT_MODE: ScrambleMode = 'cascade';

// ---------------------------------------------------------------------------
// Types — shared
// ---------------------------------------------------------------------------

/** Ripple state (ripple mode only) */
interface Ripple {
	/** Center character index of the ripple. */
	pos: number;
	/** Date.now() when the ripple was spawned. */
	time: number;
	/** Ripple lifetime in ms. */
	dur: number;
	/** Spread divisor — higher = tighter ripple. */
	spread: number;
}

/** Per-character queue entry (cascade mode only) */
interface QueueItem {
	/** Character from the old text (or '' if new text is longer). */
	from: string;
	/** Character from the new text (or '' if old text is longer). */
	to: string;
	/** Frame at which scrambling starts for this character. */
	start: number;
	/** Frame at which this character resolves to `to`. */
	end: number;
	/** Cached scramble char (re-randomized with 28% probability each frame). */
	char?: string;
}

/** Per-line animation state (supports both modes) */
interface LineState {
	/** Previous display text for change detection. */
	lastText: string;
	/** Fingerprint of KPI values for change detection. */
	lastKpiHash: string;
	/** Cascade mode: active queue of character transitions. */
	queue: QueueItem[];
	/** Cascade mode: Date.now() when the queue was built (frame 0). */
	startTime: number;
	/** Ripple mode: active content ripples. */
	ripples: Ripple[];
	/** Timestamp of last animation spawn (for cooldown). */
	lastAnimTime: number;
	/** Timestamp when next idle flip is due. */
	idleFlipDueAt: number;
	/** Whether the first call has initialized the state (to avoid false change on first set). */
	initialized: boolean;
}

type LineKey = 'aim' | 'act' | 'msg';

export interface ScrambleResult {
	/** Label text (e.g. 'aim:') — always plain, never scrambled. */
	label: string;
	/** Content text — may be scrambled if animation is active. */
	content: string;
	/** Whether any animation is currently in progress. */
	isAnimating: boolean;
}

/** Single-value flash state for countdown/TPS — tracks previous value and one active animation. */
interface ValueFlashState {
	prev: string;
	// Ripple mode flash
	ripple: Ripple | null;
	// Cascade mode flash
	queue: QueueItem[];
	startTime: number;
}

// ---------------------------------------------------------------------------
// Pure algorithm: CASCADE (TextScramble by Justin Windle, terminal port)
// ---------------------------------------------------------------------------

/**
 * Build a cascade queue comparing old text to new text.
 * Each character gets a random start and end frame, creating the
 * staggered left-to-right decode effect.
 */
export function buildQueue(
	oldText: string,
	newText: string,
	maxStart: number = CASCADE_MAX_START,
	maxLength: number = CASCADE_MAX_LENGTH,
): QueueItem[] {
	const queue: QueueItem[] = [];
	const length = Math.max(oldText.length, newText.length);
	for (let i = 0; i < length; i++) {
		const from = oldText[i] || '';
		const to = newText[i] || '';
		const start = Math.floor(Math.random() * maxStart);
		const end = start + Math.floor(Math.random() * maxLength);
		queue.push({ from, to, start, end });
	}
	return queue;
}

/**
 * Build a cascade queue for an idle word flip.
 * Only the characters in [wordStart, wordEnd] get start/end frames;
 * all other characters are pre-resolved (start=0, end=0).
 */
function buildIdleFlipQueue(
	fullText: string,
	wordStart: number,
	wordEnd: number,
): QueueItem[] {
	const queue: QueueItem[] = [];
	for (let i = 0; i < fullText.length; i++) {
		if (i >= wordStart && i <= wordEnd) {
			const start = Math.floor(Math.random() * CASCADE_IDLE_MAX_START);
			const end = start + Math.floor(Math.random() * CASCADE_IDLE_MAX_LENGTH);
			queue.push({ from: fullText[i], to: fullText[i], start, end });
		} else {
			// Pre-resolved — these chars are already at their final state
			queue.push({ from: fullText[i], to: fullText[i], start: 0, end: 0 });
		}
	}
	return queue;
}

/**
 * Compute the display string for a cascade queue at a given frame.
 * Returns a string with scramble chars wrapped in dim ANSI codes.
 * Spaces are preserved (never scrambled). Characters whose `to` is a space
 * are shown as spaces immediately (they don't scramble).
 */
export function computeCascadeFrame(queue: QueueItem[], frame: number): string {
	let output = '';
	for (const item of queue) {
		// If the target char is a space, just show it (no scrambling spaces)
		if (item.to === ' ') {
			output += ' ';
			continue;
		}
		// If the source char is a space but target isn't, still scramble
		if (frame >= item.end) {
			output += item.to;
		} else if (frame >= item.start) {
			if (!item.char || Math.random() < 0.28) {
				item.char = SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
			}
			output += `${DIM_ON}${item.char}${DIM_OFF}`;
		} else {
			// Before start frame: show old char (or empty = scramble placeholder)
			if (item.from === '') {
				const ch = SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
				output += `${DIM_ON}${ch}${DIM_OFF}`;
			} else if (item.from === ' ') {
				output += ' ';
			} else {
				output += item.from;
			}
		}
	}
	return output;
}

/**
 * Check if a cascade queue has finished animating at the given frame.
 */
function isCascadeComplete(queue: QueueItem[], frame: number): boolean {
	for (const item of queue) {
		if (frame < item.end) return false;
	}
	return true;
}

/**
 * Get the maximum end frame in a queue (used to determine animation duration).
 */
function maxEndFrame(queue: QueueItem[]): number {
	let max = 0;
	for (const item of queue) {
		if (item.end > max) max = item.end;
	}
	return max;
}

// ---------------------------------------------------------------------------
// Pure algorithm: RIPPLE (Hermes radial wave)
// ---------------------------------------------------------------------------

/**
 * Apply all active ripples to text at time `now`.
 * Returns a string where scramble chars are wrapped in dim ANSI codes.
 * Spaces are preserved untouched (Hermes behavior).
 *
 * Algorithm (from Hermes site module 448378):
 *   For each active ripple:
 *     elapsed = now - ripple.time
 *     radius  = min(elapsed/dur, 1) * (max(pos, len-pos-1) + 5) / spread
 *     dist    = abs(idx - pos)
 *     depth   = radius - dist
 *     if (dist <= radius && depth > 0 && depth <= DEPTH_BAND_MAX):
 *       char = SCRAMBLE_CHARS[(3*dist + floor(elapsed/40)) % len]
 */
export function applyRipples(text: string, ripples: Ripple[], now: number): string {
	if (!ripples.length) return text;

	const len = text.length;
	if (len === 0) return text;

	// Filter to active ripples only
	const active = ripples.filter((r) => now - r.time < r.dur);
	if (!active.length) return text;

	let result = '';
	for (let idx = 0; idx < len; idx++) {
		const origChar = text[idx];

		// Spaces are preserved untouched (Hermes behavior)
		if (origChar === ' ') {
			result += origChar;
			continue;
		}

		let scrambled = false;
		for (const ripple of active) {
			const elapsed = now - ripple.time;
			if (elapsed < 0) continue;

			const maxDist = Math.max(ripple.pos, len - ripple.pos - 1) + 5;
			const radius = Math.min(elapsed / ripple.dur, 1) * maxDist / ripple.spread;
			const dist = Math.abs(idx - ripple.pos);
			const depth = radius - dist;

			if (dist <= radius && depth > 0 && depth <= DEPTH_BAND_MAX) {
				const charIdx = (3 * dist + Math.floor(elapsed / 40)) % SCRAMBLE_CHARS.length;
				const char = SCRAMBLE_CHARS[charIdx < 0 ? charIdx + SCRAMBLE_CHARS.length : charIdx];
				result += `${DIM_ON}${char}${DIM_OFF}`;
				scrambled = true;
				break;
			}
		}

		if (!scrambled) {
			result += origChar;
		}
	}
	return result;
}

/** Spawn a ripple at a given position. */
function spawnRipple(pos: number, now: number, dur: number = RIPPLE_DUR_DEFAULT, spread: number = RIPPLE_SPREAD_DEFAULT): Ripple {
	return { pos, time: now, dur, spread };
}

// ---------------------------------------------------------------------------
// Shared utility functions
// ---------------------------------------------------------------------------

/**
 * Find the center character index of a random complete word in text.
 * Returns undefined if no words found.
 */
function randomWordCenter(text: string): number | undefined {
	const words: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < text.length) {
		while (i < text.length && text[i] === ' ') i++;
		if (i >= text.length) break;
		const start = i;
		while (i < text.length && text[i] !== ' ') i++;
		words.push({ start, end: i - 1 });
	}
	if (!words.length) return undefined;
	const word = words[Math.floor(Math.random() * words.length)];
	return Math.floor((word.start + word.end) / 2);
}

/**
 * Find a random word's start and end positions in text.
 * Returns undefined if no words found.
 */
function randomWordRange(text: string): { start: number; end: number } | undefined {
	const words: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < text.length) {
		while (i < text.length && text[i] === ' ') i++;
		if (i >= text.length) break;
		const start = i;
		while (i < text.length && text[i] !== ' ') i++;
		words.push({ start, end: i - 1 });
	}
	if (!words.length) return undefined;
	return words[Math.floor(Math.random() * words.length)];
}

/** Hash KPI values for change detection. Produces a stable string. */
function hashKpi(usage: UsageStats, extra?: number): string {
	return usage.input + ':' + usage.output + ':' + usage.toolCalls + (extra !== undefined ? ':' + extra : '');
}

// ---------------------------------------------------------------------------
// Unified apply function (dispatches by mode)
// ---------------------------------------------------------------------------

/**
 * Apply the current animation to text, dispatching by mode.
 * In cascade mode: computes frame from (now - startTime) / CASCADE_FRAME_MS.
 * In ripple mode: applies ripple wave propagation.
 */
function applyScramble(text: string, state: LineState, now: number, mode: ScrambleMode): string {
	if (mode === 'cascade') {
		if (!state.queue.length) return text;
		const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
		if (isCascadeComplete(state.queue, frame)) {
			state.queue = []; // animation complete, free the queue
			return text;
		}
		return computeCascadeFrame(state.queue, frame);
	} else {
		return applyRipples(text, state.ripples, now);
	}
}

// ---------------------------------------------------------------------------
// processLine — unified change detection for both modes
// ---------------------------------------------------------------------------

/**
 * Process a single line's state: detect changes, spawn animations, expire old ones.
 * Mutates `state` in place.
 */
function processLine(
	state: LineState,
	newText: string,
	newKpiHash: string,
	now: number,
	opts: { isAim: boolean; noContentAnim?: boolean; mode: ScrambleMode },
): void {
	const textChanged = state.lastText !== newText;
	const kpiChanged = state.lastKpiHash !== newKpiHash;
	const cooledDown = now - state.lastAnimTime > MIN_RIPPLE_INTERVAL;

	if (!state.initialized) {
		// First call: just store the initial values, no animation
		state.lastText = newText;
		state.lastKpiHash = newKpiHash;
		state.initialized = true;
	} else if (textChanged || kpiChanged) {
		// Capture the old text BEFORE updating, so cascade can compare old vs new
		const oldText = state.lastText;

		// Always track the latest text/KPI so we don't re-trigger after cooldown expires
		state.lastText = newText;
		state.lastKpiHash = newKpiHash;

		if (cooledDown) {
			// Only spawn content animation if not suppressed (aim/act skip content anim)
			if (!opts.noContentAnim) {
				if (opts.mode === 'cascade') {
					state.queue = buildQueue(oldText, newText);
					state.startTime = now;
				} else {
					const center = Math.floor(newText.length / 2);
					state.ripples.push(spawnRipple(center, now, RIPPLE_DUR_DEFAULT, RIPPLE_SPREAD_DEFAULT));
				}
			}
			state.lastAnimTime = now;
			state.idleFlipDueAt = now + IDLE_FLIP_INTERVAL;
		}
	}

	// Idle flip (aim only)
	if (opts.isAim && now >= state.idleFlipDueAt && cooledDown) {
		if (opts.mode === 'cascade') {
			const wordRange = randomWordRange(newText);
			if (wordRange !== undefined) {
				state.queue = buildIdleFlipQueue(newText, wordRange.start, wordRange.end);
				state.startTime = now;
				state.lastAnimTime = now;
			}
		} else {
			const wordCenter = randomWordCenter(newText);
			if (wordCenter !== undefined) {
				state.ripples.push(spawnRipple(wordCenter, now, IDLE_FLIP_DUR, IDLE_FLIP_SPREAD));
				state.lastAnimTime = now;
			}
		}
		state.idleFlipDueAt = now + IDLE_FLIP_INTERVAL;
	}

	// Expire old ripples (ripple mode only — cascade self-terminates)
	if (opts.mode === 'ripple') {
		state.ripples = state.ripples.filter((r) => now - r.time < r.dur);
	}
}

// ---------------------------------------------------------------------------
// ScrambleStateManager
// ---------------------------------------------------------------------------

function createLineState(now: number): LineState {
	return {
		lastText: '',
		lastKpiHash: '',
		queue: [],
		startTime: 0,
		ripples: [],
		lastAnimTime: 0,
		idleFlipDueAt: now + IDLE_FLIP_INTERVAL,
		initialized: false,
	};
}

function createValueFlashState(): ValueFlashState {
	return { prev: '', ripple: null, queue: [], startTime: 0 };
}

export class ScrambleStateManager {
	private mode: ScrambleMode = DEFAULT_MODE;
	private cache = new Map<string, Record<LineKey, LineState>>();
	private countdownState = new Map<string, ValueFlashState>();
	private tpsState = new Map<string, ValueFlashState>();

	/** Switch between cascade and ripple modes. Clears all state. */
	setMode(mode: ScrambleMode): void {
		this.mode = mode;
		this.clear();
	}

	/** Get the current scramble mode. */
	getMode(): ScrambleMode {
		return this.mode;
	}

	/** Get or create LineState for a given result + key. */
	private getState(id: string, key: LineKey, now: number): LineState {
		let record = this.cache.get(id);
		if (!record) {
			record = {
				aim: createLineState(now),
				act: createLineState(now),
				msg: createLineState(now),
			};
			this.cache.set(id, record);
		}
		return record[key];
	}

	/**
	 * Update aim line.
	 * NO content animation on text change — only idle word flip.
	 */
	updateAim(id: string, text: string, now: number): ScrambleResult {
		const state = this.getState(id, 'aim', now);
		processLine(state, text, '', now, { isAim: true, noContentAnim: true, mode: this.mode });

		const label = 'aim:';
		const content = applyScramble(text, state, now, this.mode);
		const isAnimating = this.isLineAnimating(state, now);

		return { label, content, isAnimating };
	}

	/**
	 * Update act line. Detects content changes AND toolCalls changes.
	 * NO content animation — act only tracks changes.
	 */
	updateAct(id: string, text: string, toolCalls: number, usage: UsageStats, now: number): ScrambleResult {
		const state = this.getState(id, 'act', now);
		const kpiHash = hashKpi(usage, toolCalls);
		processLine(state, text, kpiHash, now, { isAim: false, noContentAnim: true, mode: this.mode });

		const label = 'act:';
		const content = applyScramble(text, state, now, this.mode);
		const isAnimating = this.isLineAnimating(state, now);

		return { label, content, isAnimating };
	}

	/**
	 * Update msg line. Detects content changes AND token usage changes.
	 * Content animation IS active for msg.
	 */
	updateMsg(id: string, text: string, usage: UsageStats, now: number): ScrambleResult {
		const state = this.getState(id, 'msg', now);
		const kpiHash = hashKpi(usage);
		processLine(state, text, kpiHash, now, { isAim: false, mode: this.mode });

		const label = 'msg:';
		const content = applyScramble(text, state, now, this.mode);
		const isAnimating = this.isLineAnimating(state, now);

		return { label, content, isAnimating };
	}

	/**
	 * Flash the countdown value when it changes.
	 * Returns the (possibly scrambled) countdown string.
	 */
	updateCountdown(id: string, countdown: string, now: number): string {
		if (!countdown) return countdown;
		let state = this.countdownState.get(id);
		if (!state) {
			state = createValueFlashState();
			state.prev = countdown;
			this.countdownState.set(id, state);
			return countdown;
		}
		if (state.prev !== countdown) {
			if (this.mode === 'cascade') {
				state.queue = buildQueue(state.prev, countdown, CASCADE_FLASH_MAX_START, CASCADE_FLASH_MAX_LENGTH);
				state.startTime = now;
			} else {
				state.ripple = spawnRipple(Math.floor(countdown.length / 2), now, COUNTDOWN_FLASH_DUR, COUNTDOWN_FLASH_SPREAD);
			}
			state.prev = countdown;
		}
		if (this.mode === 'cascade') {
			if (state.queue.length) {
				const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
				if (isCascadeComplete(state.queue, frame)) {
					state.queue = [];
					return countdown;
				}
				return computeCascadeFrame(state.queue, frame);
			}
			return countdown;
		} else {
			if (state.ripple && now - state.ripple.time < state.ripple.dur) {
				return applyRipples(countdown, [state.ripple], now);
			}
			state.ripple = null;
			return countdown;
		}
	}

	/**
	 * Flash the TPS value when it changes.
	 * Returns the (possibly scrambled) TPS string.
	 */
	updateTps(id: string, tpsText: string, now: number): string {
		if (!tpsText || tpsText.trim() === '-') return tpsText;
		let state = this.tpsState.get(id);
		if (!state) {
			state = createValueFlashState();
			state.prev = tpsText;
			this.tpsState.set(id, state);
			return tpsText;
		}
		if (state.prev !== tpsText) {
			if (this.mode === 'cascade') {
				state.queue = buildQueue(state.prev, tpsText, CASCADE_FLASH_MAX_START, CASCADE_FLASH_MAX_LENGTH);
				state.startTime = now;
			} else {
				state.ripple = spawnRipple(Math.floor(tpsText.length / 2), now, TPS_FLASH_DUR, TPS_FLASH_SPREAD);
			}
			state.prev = tpsText;
		}
		if (this.mode === 'cascade') {
			if (state.queue.length) {
				const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
				if (isCascadeComplete(state.queue, frame)) {
					state.queue = [];
					return tpsText;
				}
				return computeCascadeFrame(state.queue, frame);
			}
			return tpsText;
		} else {
			if (state.ripple && now - state.ripple.time < state.ripple.dur) {
				return applyRipples(tpsText, [state.ripple], now);
			}
			state.ripple = null;
			return tpsText;
		}
	}

	/**
	 * Check whether a given line has any active animations at `now`.
	 */
	private isLineAnimating(state: LineState, now: number): boolean {
		if (this.mode === 'cascade') {
			if (!state.queue.length) return false;
			const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
			return !isCascadeComplete(state.queue, frame);
		} else {
			return state.ripples.some((rp) => rp.time + rp.dur > now);
		}
	}

	/**
	 * Check whether a given result has any active animations at `now`.
	 */
	hasActiveAnimations(id: string, now: number): boolean {
		const record = this.cache.get(id);
		if (!record) return false;
		for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
			if (this.isLineAnimating(record[key], now)) return true;
		}
		return false;
	}

	/** Reset all animation state. */
	clear(): void {
		this.cache.clear();
		this.countdownState.clear();
		this.tpsState.clear();
	}

	/** Check if ANY flow result has active animations (for timer management). */
	hasAnyActiveAnimations(now: number): boolean {
		for (const record of this.cache.values()) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				if (this.isLineAnimating(record[key], now)) return true;
			}
		}
		// Check countdown/TPS flash states
		for (const state of this.countdownState.values()) {
			if (this.mode === 'cascade') {
				if (state.queue.length) {
					const frame = Math.floor((Date.now() - state.startTime) / CASCADE_FRAME_MS);
					if (!isCascadeComplete(state.queue, frame)) return true;
				}
			} else {
				if (state.ripple && state.ripple.time + state.ripple.dur > now) return true;
			}
		}
		for (const state of this.tpsState.values()) {
			if (this.mode === 'cascade') {
				if (state.queue.length) {
					const frame = Math.floor((Date.now() - state.startTime) / CASCADE_FRAME_MS);
					if (!isCascadeComplete(state.queue, frame)) return true;
				}
			} else {
				if (state.ripple && state.ripple.time + state.ripple.dur > now) return true;
			}
		}
		return false;
	}

	/** Legacy alias — maps old API to new. */
	hasActiveRipples(id: string, now: number): boolean {
		return this.hasActiveAnimations(id, now);
	}

	/** Legacy alias — maps old API to new. */
	hasAnyActiveRipples(now: number): boolean {
		return this.hasAnyActiveAnimations(now);
	}
}

/** Module-level singleton for use across render calls. */
export const scrambleManager = new ScrambleStateManager();

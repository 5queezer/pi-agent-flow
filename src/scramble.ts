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
 * compatibility. Animations spawn ONLY on displayed text changes — no KPI
 * triggering, no countdown flash, no aim idle flip.
 *
 * Line behavior:
 *   aim: — content stays still, no animation ever
 *   act: — scramble on text change only
 *   msg: — scramble on text change only
 *   tps: — flash on value change
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
const MIN_RIPPLE_INTERVAL = 250; // ms — cooldown between animations
const DEPTH_BAND_MAX = 3;        // Ripple: 0-3 depth band
const TPS_FLASH_DUR = 150;       // ms — TPS flash (ripple mode)
const TPS_FLASH_SPREAD = 0.5;
const CASCADE_FRAME_MS = 16;     // ms per cascade frame (~60fps)
const CASCADE_MAX_START = 40;    // max random start frame for cascade queue
const CASCADE_MAX_LENGTH = 40;  // max random length (end - start) for cascade queue
const CASCADE_FLASH_MAX_START = 5;  // very short for TPS flash
const CASCADE_FLASH_MAX_LENGTH = 8;  // very short for TPS flash

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
	/** Cascade mode: active queue of character transitions. */
	queue: QueueItem[];
	/** Cascade mode: Date.now() when the queue was built (frame 0). */
	startTime: number;
	/** Ripple mode: active content ripples. */
	ripples: Ripple[];
	/** Timestamp of last animation spawn (for cooldown). */
	lastAnimTime: number;
	/** Whether the first call has initialized the state (to avoid false change on first set). */
	initialized: boolean;
	/** Flow has completed — no further animations will spawn. */
	completed: boolean;
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

/** Single-value flash state for TPS — tracks previous value and one active animation. */
interface ValueFlashState {
	prev: string;
	/** Ripple mode flash */
	ripple: Ripple | null;
	/** Cascade mode flash */
	queue: QueueItem[];
	startTime: number;
	/** Flow has completed — no further animations will spawn. */
	completed: boolean;
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

// ---------------------------------------------------------------------------
// Pure algorithm: RIPPLE (Hermes radial wave)
// ---------------------------------------------------------------------------

/**
 * Apply all active ripples to text at time `now`.
 * Returns a string where scramble chars are wrapped in dim ANSI codes.
 * Spaces are preserved untouched (Hermes behavior).
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
 * Triggers ONLY on displayed text change — no KPI-based triggering.
 * Mutates `state` in place.
 */
function processLine(
	state: LineState,
	newText: string,
	now: number,
	mode: ScrambleMode,
): void {
	// If the flow is done, stop all animations
	if (state.completed) return;

	const textChanged = state.lastText !== newText;

	if (!state.initialized) {
		// First call: just store the initial values, no animation
		state.lastText = newText;
		state.initialized = true;
		return;
	}

	if (!textChanged) return;

	// Track the old text BEFORE updating, so cascade can compare old vs new
	const oldText = state.lastText;

	// Always track the latest text so we don't re-trigger later
	state.lastText = newText;

	const cooledDown = now - state.lastAnimTime > MIN_RIPPLE_INTERVAL;
	if (!cooledDown) return;

	// Spawn animation
	if (mode === 'cascade') {
		state.queue = buildQueue(oldText, newText);
		state.startTime = now;
	} else {
		const center = Math.floor(newText.length / 2);
		state.ripples.push(spawnRipple(center, now, RIPPLE_DUR_DEFAULT, RIPPLE_SPREAD_DEFAULT));
	}
	state.lastAnimTime = now;

	// Expire old ripples (ripple mode only — cascade self-terminates)
	if (mode === 'ripple') {
		state.ripples = state.ripples.filter((r) => now - r.time < r.dur);
	}
}

// ---------------------------------------------------------------------------
// ScrambleStateManager
// ---------------------------------------------------------------------------

function createLineState(): LineState {
	return {
		lastText: '',
		queue: [],
		startTime: 0,
		ripples: [],
		lastAnimTime: 0,
		initialized: false,
		completed: false,
	};
}

function createValueFlashState(): ValueFlashState {
	return { prev: '', ripple: null, queue: [], startTime: 0, completed: false };
}

export class ScrambleStateManager {
	private mode: ScrambleMode = DEFAULT_MODE;
	private cache = new Map<string, Record<LineKey, LineState>>();
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
				aim: createLineState(),
				act: createLineState(),
				msg: createLineState(),
			};
			this.cache.set(id, record);
		}
		return record[key];
	}

	/**
	 * Update aim line.
	 * Content stays completely still — no animation ever.
	 */
	updateAim(id: string, text: string, now: number): ScrambleResult {
		return { label: 'aim:', content: text, isAnimating: false };
	}

	/**
	 * Update act line. Scramble on text change only.
	 * When isComplete is true, marks the flow as done — no further animations.
	 */
	updateAct(id: string, text: string, now: number, isComplete: boolean = false): ScrambleResult {
		const state = this.getState(id, 'act', now);
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) {
			return { label: 'act:', content: text, isAnimating: false };
		}
		processLine(state, text, now, this.mode);

		const label = 'act:';
		const content = applyScramble(text, state, now, this.mode);
		const isAnimating = this.isLineAnimating(state, now);

		return { label, content, isAnimating };
	}

	/**
	 * Update msg line. Scramble on text change only.
	 * When isComplete is true, marks the flow as done — no further animations.
	 */
	updateMsg(id: string, text: string, now: number, isComplete: boolean = false): ScrambleResult {
		const state = this.getState(id, 'msg', now);
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) {
			return { label: 'msg:', content: text, isAnimating: false };
		}
		processLine(state, text, now, this.mode);

		const label = 'msg:';
		const content = applyScramble(text, state, now, this.mode);
		const isAnimating = this.isLineAnimating(state, now);

		return { label, content, isAnimating };
	}

	/**
	 * Flash the TPS value when it changes.
	 * Returns the (possibly scrambled) TPS string.
	 * When isComplete is true, marks the TPS flash as done.
	 */
	updateTps(id: string, tpsText: string, now: number, isComplete: boolean = false): string {
		if (!tpsText || tpsText.trim() === '-') return tpsText;
		let state = this.tpsState.get(id);
		if (!state) {
			state = createValueFlashState();
			state.prev = tpsText;
			this.tpsState.set(id, state);
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripple = null;
		}
		if (state.completed) return tpsText;
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
		if (state.completed) return false;
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
		this.tpsState.clear();
	}

	/** Mark a flow as complete — no further animations will spawn. */
	completeFlow(id: string): void {
		const record = this.cache.get(id);
		if (record) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				record[key].completed = true;
				record[key].queue = [];
				record[key].ripples = [];
			}
		}
		const tpsState = this.tpsState.get(id);
		if (tpsState) {
			tpsState.completed = true;
			tpsState.queue = [];
			tpsState.ripple = null;
		}
	}

	/** Check if ANY flow result has active animations (for timer management). */
	hasAnyActiveAnimations(now: number): boolean {
		for (const record of this.cache.values()) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				if (this.isLineAnimating(record[key], now)) return true;
			}
		}
		// Check TPS flash states (skip completed)
		for (const state of this.tpsState.values()) {
			if (state.completed) continue;
			if (this.mode === 'cascade') {
				if (state.queue.length) {
					const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
					if (!isCascadeComplete(state.queue, frame)) return true;
				}
			} else {
				if (state.ripple && state.ripple.time + state.ripple.dur > now) return true;
			}
		}
		return false;
	}

	/** Legacy aliases */
	hasActiveRipples(id: string, now: number): boolean {
		return this.hasActiveAnimations(id, now);
	}

	hasAnyActiveRipples(now: number): boolean {
		return this.hasAnyActiveAnimations(now);
	}
}

/** Module-level singleton for use across render calls. */
export const scrambleManager = new ScrambleStateManager();

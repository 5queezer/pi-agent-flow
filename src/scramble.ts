/**
 * Tri-mode text scramble effect for terminal TUI.
 *
 * Mode 1 — STREAM (default): Typewriter-style progressive reveal.
 *   Buffer the full text, reveal character-by-character with a scramble
 *   cursor at the writing position. Works naturally with streaming text —
 *   the cursor follows the stream, creating a "typing" effect.
 *
 * Mode 2 — CASCADE: Classic TextScramble algorithm (Justin Windle).
 *   Per-character queue with staggered start/end frames. Characters decode
 *   one-by-one in a left-to-right cascade. Self-terminating after ~640ms.
 *
 * Mode 3 — RIPPLE: Hermes radial wave propagation.
 *   Wave expands from a center point. Characters resolve behind the wavefront.
 *
 * Line behavior (all modes):
 *   aim: — content stays still, no animation ever
 *   act: — stream/cascade/scramble on text change
 *   msg: — stream/cascade/scramble on text change
 *   tps: — flash on value change (cascade/ripple only)
 */

import type { UsageStats } from './types.js';
import { stripAnsi, tailText, truncateChars } from './render-utils.js';

// ---------------------------------------------------------------------------
// Character set — classic ASCII-safe scramble symbols
// ---------------------------------------------------------------------------

/** Scramble character pool — all ASCII-safe for maximum terminal compatibility */
const SCRAMBLE_CHARS = '!<>-_\\/[]{}-=+*^?#________';

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

const RIPPLE_DUR_DEFAULT = 666;
const RIPPLE_SPREAD_DEFAULT = 1;
const MIN_RIPPLE_INTERVAL = 250;
const DEPTH_BAND_MAX = 3;
const TPS_FLASH_DUR = 150;
const TPS_FLASH_SPREAD = 0.5;
const CASCADE_FRAME_MS = 16;
const CASCADE_MAX_START = 40;
const CASCADE_MAX_LENGTH = 40;
const CASCADE_FLASH_MAX_START = 5;
const CASCADE_FLASH_MAX_LENGTH = 8;

// Stream mode constants
const STREAM_SPEED_MSG = 35;       // ms per char for msg: (~29 chars/sec)
const STREAM_SPEED_ACT = 25;       // ms per char for act: (~40 chars/sec)
const STREAM_SCRAMBLE_WIDTH = 5;   // scramble chars at cursor position
const STREAM_RERANDOMIZE_RATE = 0.28; // 28% chance to re-randomize (CodePen style)

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';

// ---------------------------------------------------------------------------
// Mode type
// ---------------------------------------------------------------------------

export type ScrambleMode = 'stream' | 'cascade' | 'ripple';

export const DEFAULT_MODE: ScrambleMode = 'ripple';

// ---------------------------------------------------------------------------
// Types — shared
// ---------------------------------------------------------------------------

interface Ripple {
	pos: number;
	time: number;
	dur: number;
	spread: number;
}

interface QueueItem {
	from: string;
	to: string;
	start: number;
	end: number;
	char?: string;
}

interface LineState {
	lastText: string;
	queue: QueueItem[];
	startTime: number;
	ripples: Ripple[];
	lastAnimTime: number;
	initialized: boolean;
	completed: boolean;
}

type LineKey = 'aim' | 'act' | 'msg';

export interface ScrambleResult {
	label: string;
	content: string;
	isAnimating: boolean;
}

interface ValueFlashState {
	prev: string;
	ripple: Ripple | null;
	queue: QueueItem[];
	startTime: number;
	completed: boolean;
}

// ---------------------------------------------------------------------------
// Types — stream mode
// ---------------------------------------------------------------------------

interface TypewriterState {
	/** Complete buffered text. */
	fullText: string;
	/** Number of chars fully resolved (shown normally). */
	revealedCount: number;
	/** Date.now() of last cursor advance. */
	lastRevealTime: number;
	/** ms per character reveal speed. */
	speed: number;
	/** Number of scramble chars at cursor position. */
	scrambleWidth: number;
	/** Flow has completed — no further animation. */
	completed: boolean;
	/** Cached scramble chars for cursor zone (28% re-randomize). */
	cursorChars: string[];
	/** Last rendered visible text (tail view only, for overlap tracking). */
	lastVisibleText?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function randomChar(): string {
	return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
}

// ---------------------------------------------------------------------------
// Pure algorithm: STREAM (typewriter progressive reveal)
// ---------------------------------------------------------------------------

/**
 * Render visible text with typewriter stream effect.
 *
 * - Characters before `visibleRevealed` are shown normally (resolved).
 * - Characters in the cursor zone (visibleRevealed to visibleRevealed+scrambleWidth)
 *   show scramble chars with 28% re-randomize rate (CodePen feel).
 * - Characters beyond the cursor show pure noise scramble chars.
 * - Spaces are always preserved.
 */
export function renderStreamText(
	visibleText: string,
	visibleRevealed: number,
	scrambleWidth: number,
	cursorChars: string[],
): string {
	if (visibleRevealed >= visibleText.length) return visibleText;

	let result = '';
	let inDim = false;

	for (let i = 0; i < visibleText.length; i++) {
		const isResolved = i < visibleRevealed;
		const isCursorZone = !isResolved && i < visibleRevealed + scrambleWidth;
		const ch = visibleText[i];

		if (isResolved || ch === ' ') {
			if (inDim) {
				result += DIM_OFF;
				inDim = false;
			}
			result += ch;
		} else if (isCursorZone) {
			if (!inDim) {
				result += DIM_ON;
				inDim = true;
			}
			const cursorIdx = i - visibleRevealed;
			while (cursorChars.length <= cursorIdx) cursorChars.push(randomChar());
			if (Math.random() < STREAM_RERANDOMIZE_RATE || !cursorChars[cursorIdx]) {
				cursorChars[cursorIdx] = randomChar();
			}
			result += cursorChars[cursorIdx];
		} else {
			// Beyond cursor — live scramble (keeps fuzzing each frame)
			if (!inDim) {
				result += DIM_ON;
				inDim = true;
			}
			result += randomChar();
		}
	}
	if (inDim) {
		result += DIM_OFF;
	}

	// Trim cursor chars array to actual size used
	cursorChars.length = Math.min(scrambleWidth, Math.max(0, visibleText.length - visibleRevealed));
	return result;
}

// ---------------------------------------------------------------------------
// Pure algorithm: CASCADE (TextScramble by Justin Windle, terminal port)
// ---------------------------------------------------------------------------

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

export function computeCascadeFrame(queue: QueueItem[], frame: number): string {
	let output = '';
	for (const item of queue) {
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
			if (item.from === ' ') {
				output += ' ';
			} else {
				output += `${DIM_ON}${randomChar()}${DIM_OFF}`;
			}
		}
	}
	return output;
}

function isCascadeComplete(queue: QueueItem[], frame: number): boolean {
	for (const item of queue) {
		if (frame < item.end) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Pure algorithm: RIPPLE (Hermes radial wave)
// ---------------------------------------------------------------------------

export function applyRipples(text: string, ripples: Ripple[], now: number): string {
	if (!ripples.length) return text;
	const len = text.length;
	if (len === 0) return text;
	const active = ripples.filter((r) => now - r.time < r.dur);
	if (!active.length) return text;
	let result = '';
	for (let idx = 0; idx < len; idx++) {
		const origChar = text[idx];
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
		if (!scrambled) result += origChar;
	}
	return result;
}

function spawnRipple(pos: number, now: number, dur: number = RIPPLE_DUR_DEFAULT, spread: number = RIPPLE_SPREAD_DEFAULT): Ripple {
	return { pos, time: now, dur, spread };
}

// ---------------------------------------------------------------------------
// Unified apply function (cascade/ripple)
// ---------------------------------------------------------------------------

function applyScramble(text: string, state: LineState, now: number, mode: ScrambleMode): string {
	if (mode === 'cascade') {
		if (!state.queue.length) return text;
		const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
		if (isCascadeComplete(state.queue, frame)) {
			state.queue = [];
			return text;
		}
		return computeCascadeFrame(state.queue, frame);
	} else {
		return applyRipples(text, state.ripples, now);
	}
}

// ---------------------------------------------------------------------------
// processLine — unified change detection (cascade/ripple)
// ---------------------------------------------------------------------------

function processLine(
	state: LineState,
	newText: string,
	now: number,
	mode: ScrambleMode,
): void {
	if (state.completed) return;
	const textChanged = state.lastText !== newText;
	if (!state.initialized) {
		state.lastText = newText;
		state.initialized = true;
		return;
	}
	if (!textChanged) return;
	const oldText = state.lastText;
	const cooledDown = now - state.lastAnimTime > MIN_RIPPLE_INTERVAL;
	if (cooledDown) {
		state.lastText = newText;
		state.lastAnimTime = now;
		if (mode === 'cascade') {
			state.queue = buildQueue(oldText, newText);
			state.startTime = now;
		} else {
			const center = Math.floor(newText.length / 2);
			state.ripples.push(spawnRipple(center, now));
		}
	}
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

function createTypewriterState(speed: number): TypewriterState {
	return {
		fullText: '',
		revealedCount: 0,
		lastRevealTime: 0,
		speed,
		scrambleWidth: STREAM_SCRAMBLE_WIDTH,
		completed: false,
		cursorChars: [],
		lastVisibleText: '',
	};
}

/**
 * Compute the longest suffix of `oldStr` that matches a prefix of `newStr`.
 * Used for tail-view window sliding: when the visible text shifts, we want
 * to know how many chars from the old view are still present at the start
 * of the new view so revealedCount can be adjusted smoothly.
 */
function computeOverlapLen(oldStr: string, newStr: string): number {
	const maxOverlap = Math.min(oldStr.length, newStr.length);
	for (let i = maxOverlap; i > 0; i--) {
		if (oldStr.endsWith(newStr.slice(0, i))) return i;
	}
	return 0;
}

export class ScrambleStateManager {
	private mode: ScrambleMode = DEFAULT_MODE;
	private cache = new Map<string, Record<LineKey, LineState>>();
	private tpsState = new Map<string, ValueFlashState>();
	private streamState = new Map<string, { msg: TypewriterState; act: TypewriterState }>();

	setMode(mode: ScrambleMode): void {
		this.mode = mode;
		this.clear();
	}

	getMode(): ScrambleMode {
		return this.mode;
	}

	private getState(id: string, key: LineKey): LineState {
		let record = this.cache.get(id);
		if (!record) {
			record = { aim: createLineState(), act: createLineState(), msg: createLineState() };
			this.cache.set(id, record);
		}
		return record[key];
	}

	private getStreamState(id: string, key: 'msg' | 'act'): TypewriterState {
		let record = this.streamState.get(id);
		if (!record) {
			record = { msg: createTypewriterState(STREAM_SPEED_MSG), act: createTypewriterState(STREAM_SPEED_ACT) };
			this.streamState.set(id, record);
		}
		return record[key];
	}

	// -----------------------------------------------------------------------
	// aim: — never animates
	// -----------------------------------------------------------------------

	updateAim(id: string, text: string, now: number): ScrambleResult {
		return { label: 'aim:', content: text, isAnimating: false };
	}

	// -----------------------------------------------------------------------
	// act: — stream/cascade/ripple on text change
	// -----------------------------------------------------------------------

	updateAct(id: string, text: string, now: number, isComplete: boolean = false): ScrambleResult {
		const state = this.getState(id, 'act');
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) return { label: 'act:', content: text, isAnimating: false };
		processLine(state, text, now, this.mode);
		const content = applyScramble(text, state, now, this.mode);
		const isAnimating = this.isLineAnimating(state, now);
		return { label: 'act:', content, isAnimating };
	}

	// -----------------------------------------------------------------------
	// msg: — stream/cascade/ripple on text change
	// -----------------------------------------------------------------------

	updateMsg(id: string, text: string, now: number, isComplete: boolean = false): ScrambleResult {
		const state = this.getState(id, 'msg');
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) return { label: 'msg:', content: text, isAnimating: false };
		processLine(state, text, now, this.mode);
		const content = applyScramble(text, state, now, this.mode);
		const isAnimating = this.isLineAnimating(state, now);
		return { label: 'msg:', content, isAnimating };
	}

	// -----------------------------------------------------------------------
	// STREAM mode: typewriter progressive reveal
	// -----------------------------------------------------------------------

	/**
	 * Stream msg: text with typewriter reveal.
	 *
	 * Tail-view semantics: only the last `budget` chars are visible. As text
	 * grows the window slides. We track `revealedCount` relative to the
	 * CURRENT visible text so that previously-visible resolved chars stay
	 * resolved and only newly-entered chars are scrambled.
	 */
	streamMsg(id: string, fullText: string, now: number, isComplete: boolean, budget: number): string {
		const state = this.getStreamState(id, 'msg');

		if (isComplete && !state.completed) {
			state.completed = true;
		}

		// Reset if a previously-completed flow is now running again (new flow started)
		if (!isComplete && state.completed) {
			state.completed = false;
			state.revealedCount = 0;
			state.lastRevealTime = 0;
			state.cursorChars = [];
			state.fullText = '';
			state.lastVisibleText = '';
		}

		// Strip ANSI for stable comparison
		const cleanText = stripAnsi(fullText);

		// Compute old and new visible windows (tail text)
		const oldVisibleText = state.lastVisibleText || '';
		const newVisibleText = tailText(cleanText, budget);

		if (oldVisibleText) {
			// Find how much of the old visible text is still at the start of
			// the new visible text. Chars that slid out of view reduce the
			// revealed count so the visible window doesn't flash to pure noise.
			const overlapLen = computeOverlapLen(oldVisibleText, newVisibleText);
			const charsSlidOut = oldVisibleText.length - overlapLen;
			state.revealedCount = Math.max(0, state.revealedCount - charsSlidOut);
			if (charsSlidOut > 0) {
				// Reset scramble cursor when the visible window shifts so stale
				// scramble chars don't linger at wrong positions.
				state.cursorChars = [];
			}
		}

		state.fullText = cleanText;
		state.lastVisibleText = newVisibleText;

		// Advance cursor
		if (state.completed) {
			state.revealedCount = newVisibleText.length;
		} else if (state.lastRevealTime > 0) {
			const elapsed = Math.max(0, now - state.lastRevealTime);
			const charsToReveal = Math.floor(elapsed / state.speed);
			if (charsToReveal > 0) {
				state.revealedCount = Math.min(state.revealedCount + charsToReveal, newVisibleText.length);
				state.lastRevealTime += charsToReveal * state.speed;
			}
		} else {
			// First frame — start the clock
			state.lastRevealTime = now;
		}

		// All revealed
		if (state.revealedCount >= newVisibleText.length) {
			return newVisibleText;
		}

		return renderStreamText(newVisibleText, state.revealedCount, state.scrambleWidth, state.cursorChars);
	}

	/**
	 * Stream act: text with typewriter reveal.
	 * When tool call text changes, reset the buffer and reveal new text.
	 * Budget controls truncation (truncateChars, shows beginning).
	 */
	streamAct(id: string, fullText: string, now: number, isComplete: boolean, budget: number): string {
		const state = this.getStreamState(id, 'act');

		if (isComplete && !state.completed) {
			state.completed = true;
		}

		// Reset if a previously-completed flow is now running again (new flow started)
		if (!isComplete && state.completed) {
			state.completed = false;
			state.revealedCount = 0;
			state.lastRevealTime = 0;
			state.cursorChars = [];
			state.fullText = '';
		}

		// Strip ANSI for stable comparison (formatFlowToolCall adds color codes)
		const cleanText = stripAnsi(fullText);

		// Detect tool call change — reset if text differs
		if (state.fullText && cleanText !== state.fullText) {
			// Only reset if significantly different (different tool name)
			const prefixChanged = cleanText.slice(0, 10) !== state.fullText.slice(0, 10);
			if (prefixChanged) {
				state.fullText = cleanText;
				state.revealedCount = 0;
				state.lastRevealTime = now;
				state.cursorChars = [];
			} else {
				// Same tool, just params changed — update text, keep cursor
				state.fullText = cleanText;
			}
		} else if (!state.fullText) {
			state.fullText = cleanText;
		}

		// Advance cursor
		if (state.completed) {
			state.revealedCount = state.fullText.length;
		} else if (state.lastRevealTime > 0) {
			const elapsed = Math.max(0, now - state.lastRevealTime);
			const charsToReveal = Math.floor(elapsed / state.speed);
			if (charsToReveal > 0) {
				state.revealedCount = Math.min(state.revealedCount + charsToReveal, state.fullText.length);
				state.lastRevealTime += charsToReveal * state.speed;
			}
		} else {
			state.lastRevealTime = now;
		}

		// All revealed
		if (state.revealedCount >= state.fullText.length) {
			return state.fullText.length > budget ? state.fullText.slice(0, budget) : state.fullText;
		}

		// Compute visible window (truncated, shows beginning for tool calls)
		const visibleText = state.fullText.length > budget ? state.fullText.slice(0, budget) : state.fullText;
		const visibleRevealed = Math.min(state.revealedCount, visibleText.length);

		if (visibleRevealed >= visibleText.length) {
			return visibleText;
		}

		return renderStreamText(visibleText, visibleRevealed, state.scrambleWidth, state.cursorChars);
	}

	// -----------------------------------------------------------------------
	// TPS flash (cascade/ripple modes only)
	// -----------------------------------------------------------------------

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

	// -----------------------------------------------------------------------
	// Animation status helpers
	// -----------------------------------------------------------------------

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

	private isStreamAnimating(state: TypewriterState): boolean {
		if (state.completed) return false;
		const visibleText = state.lastVisibleText || state.fullText;
		return state.revealedCount < visibleText.length;
	}

	hasActiveAnimations(id: string, now: number): boolean {
		// Stream mode
		if (this.mode === 'stream') {
			const streamRecord = this.streamState.get(id);
			if (streamRecord) {
				if (this.isStreamAnimating(streamRecord.msg)) return true;
				if (this.isStreamAnimating(streamRecord.act)) return true;
			}
			return false;
		}
		// Cascade/ripple
		const record = this.cache.get(id);
		if (!record) return false;
		for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
			if (this.isLineAnimating(record[key], now)) return true;
		}
		return false;
	}

	hasAnyActiveAnimations(now: number): boolean {
		// Stream mode
		if (this.mode === 'stream') {
			for (const record of this.streamState.values()) {
				if (this.isStreamAnimating(record.msg)) return true;
				if (this.isStreamAnimating(record.act)) return true;
			}
			return false;
		}
		// Cascade/ripple
		for (const record of this.cache.values()) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				if (this.isLineAnimating(record[key], now)) return true;
			}
		}
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

	clear(): void {
		this.cache.clear();
		this.tpsState.clear();
		this.streamState.clear();
	}

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
		const streamRecord = this.streamState.get(id);
		if (streamRecord) {
			streamRecord.msg.completed = true;
			streamRecord.msg.revealedCount = streamRecord.msg.lastVisibleText?.length ?? streamRecord.msg.fullText.length;
			streamRecord.act.completed = true;
			streamRecord.act.revealedCount = streamRecord.act.fullText.length;
		}
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

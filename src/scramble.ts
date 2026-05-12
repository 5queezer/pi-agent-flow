/**
 * Quad-mode text scramble effect for terminal TUI.
 *
 * Mode 1 — STREAM: Typewriter-style progressive reveal.
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
 * Mode 4 — ILLUMINATE: Neon glow ripple with depth-based esoteric char sets,
 *   ANSI truecolor, phrase-chunked msg streaming, and TPS hysteresis.
 *   Per-target color configs (cyan aim, purple act, gold TPS, etc.).
 *
 * Line behavior (all modes):
 *   aim: — content stays still, no animation ever
 *   act: — stream/cascade/ripple/illuminate on text change
 *   msg: — stream/cascade/ripple/illuminate on text change
 *   tps: — flash on value change (cascade/ripple/illuminate only)
 */

import type { UsageStats } from './types.js';
import { stripAnsi, tailText, truncateChars } from './render-utils.js';

// ---------------------------------------------------------------------------
// Character sets — depth-based esoteric scramble symbols (illuminate mode)
// ---------------------------------------------------------------------------

/** Deep glitch: ASCII-safe dense symbols for inner ripple depths (1–2) */
const DEEP_GLITCH = '><+*·-~!#$%^&=@?';
/** Mid glitch: lowercase alphabet for mid ripple depth (3) */
const MID_GLITCH = 'abcdefghijklmnopqrstuvwxyz';
/** Shallow glitch: numbers and brackets for outer ripple depths (4+) */
const SHALLOW_GLITCH = '0123456789\\/[]{}|';
/** Classic ASCII-safe set for stream/cascade/ripple fallback */
const SCRAMBLE_CHARS = '!<>-_\\/[]{}-=+*^?#________';

function selectScrambleChar(depth: number, dist: number, elapsed: number, entropy: number = 0): string {
	const tick = Math.floor(elapsed / 40);
	const jitter = entropy % 3;
	if (depth <= 2) {
		const idx = (3 * dist + tick + jitter) % DEEP_GLITCH.length;
		return DEEP_GLITCH[idx < 0 ? idx + DEEP_GLITCH.length : idx];
	} else if (depth === 3) {
		const idx = (5 * dist + tick + jitter) % MID_GLITCH.length;
		return MID_GLITCH[idx < 0 ? idx + MID_GLITCH.length : idx];
	} else {
		const idx = (7 * dist + tick + jitter) % SHALLOW_GLITCH.length;
		return SHALLOW_GLITCH[idx < 0 ? idx + SHALLOW_GLITCH.length : idx];
	}
}

// ---------------------------------------------------------------------------
// ANSI truecolor neon glow constants (illuminate mode)
// ---------------------------------------------------------------------------

const CYAN_GLOW = '\x1b[38;2;0;255;204m';
const PURPLE_GLOW = '\x1b[38;2;191;0;255m';
const PINK_GLOW = '\x1b[38;2;255;0;85m';
const GOLD_GLOW = '\x1b[38;2;255;204;0m';
const WHITE_GLOW = '\x1b[38;2;255;255;255m';
const RESET_COLOR = '\x1b[39m';
const BOLD_ON = '\x1b[1m';
const BOLD_OFF = '\x1b[22m';

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';

/** Illuminate close: turns off bold (SGR 22 also kills dim), then re-applies
 *  dim (SGR 2) so enclosing dim context survives scramble transitions. */
const ILLUMINATE_CLOSE = '\x1b[22m\x1b[2m\x1b[39m';

// ---------------------------------------------------------------------------
// Illuminate per-target effect configs
// ---------------------------------------------------------------------------

interface IlluminateConfig {
	color: string;
	duration: number;
	spread: number;
	glowIntensity: 'high' | 'medium' | 'low' | 'variable';
}

const ILLUMINATE_CONFIGS: Record<string, IlluminateConfig> = {
	aimLabel: { color: CYAN_GLOW, duration: 250, spread: 0.8, glowIntensity: 'high' },
	actLabel: { color: PURPLE_GLOW, duration: 250, spread: 0.8, glowIntensity: 'high' },
	msgLabel: { color: CYAN_GLOW, duration: 250, spread: 0.8, glowIntensity: 'high' },
	msgContent: { color: 'dynamic', duration: 850, spread: 1.5, glowIntensity: 'variable' },
	tps: { color: GOLD_GLOW, duration: 120, spread: 0.5, glowIntensity: 'medium' },
};

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

const RIPPLE_DUR_DEFAULT = 666;
const RIPPLE_SPREAD_DEFAULT = 1;
const MIN_RIPPLE_INTERVAL = 250;
const DEPTH_BAND_MAX = 4;
const TPS_FLASH_DUR = 150;
const TPS_FLASH_SPREAD = 0.5;
const CASCADE_FRAME_MS = 16;
const CASCADE_MAX_START = 40;
const CASCADE_MAX_LENGTH = 40;
const CASCADE_FLASH_MAX_START = 5;
const CASCADE_FLASH_MAX_LENGTH = 8;

// Illuminate phrase buffering
const MAX_PHRASE_BUFFER_TIME = 500;
const MIN_PHRASE_LENGTH = 15;

// TPS hysteresis
const TPS_HYSTERESIS_PCT = 0.15;
const TPS_HYSTERESIS_MS = 2000;

// Stream mode constants
const STREAM_SPEED_MSG = 35;       // ms per char for msg: (~29 chars/sec)
const STREAM_SPEED_ACT = 25;       // ms per char for act: (~40 chars/sec)
const STREAM_SCRAMBLE_WIDTH = 5;   // scramble chars at cursor position
const STREAM_RERANDOMIZE_RATE = 0.28; // 28% chance to re-randomize (CodePen style)

// ---------------------------------------------------------------------------
// Easing and interpolation helpers
// ---------------------------------------------------------------------------

/** Ease-out cubic: organic deceleration for ripple expansion.
 *  Blended 80% linear + 20% ease-out to keep scramble band intact on short texts. */
function easeOutCubic(t: number): number {
	const e = 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
	return 0.8 * t + 0.2 * e;
}

/** Smoothstep interpolation for smooth color band transitions */
function smoothstep(min: number, max: number, value: number): number {
	const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
	return x * x * (3 - 2 * x);
}

/** Linear interpolation between a and b by factor t (0..1) */
function lerp(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

/** Ease-in quadratic: gentle start, accelerating into the main wave */
function easeInQuad(t: number): number {
	return t * t;
}

// ---------------------------------------------------------------------------
// Mode type
// ---------------------------------------------------------------------------

export type ScrambleMode = 'stream' | 'cascade' | 'ripple' | 'illuminate';

export { selectScrambleChar };
export { ILLUMINATE_CONFIGS };
export type { IlluminateConfig };
export { CYAN_GLOW, PURPLE_GLOW, PINK_GLOW, GOLD_GLOW, WHITE_GLOW, BOLD_ON, BOLD_OFF, RESET_COLOR };

export const DEFAULT_MODE: ScrambleMode = 'illuminate';

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
	// Illuminate phrase buffering (msg: only)
	phraseBuffer: string;
	displayedText: string;
	lastFlushTime: number;
}

/** Phrase boundary detection for illuminate msg: streaming */
function findPhraseBoundary(text: string, minLen: number = MIN_PHRASE_LENGTH): number {
	// Sentence boundaries — flush regardless of length
	const sentenceBoundaries = ['. ', '! ', '? ', '\n'];
	for (const b of sentenceBoundaries) {
		const idx = text.lastIndexOf(b);
		if (idx >= 0) return idx + b.length;
	}
	// Other boundaries require min length
	if (text.length < minLen) return -1;
	const otherBoundaries = ['— ', '– '];
	for (const b of otherBoundaries) {
		const idx = text.lastIndexOf(b);
		if (idx >= 0) return idx + b.length;
	}
	// Fallback: word boundary (space)
	const spaceIdx = text.indexOf(' ', minLen);
	if (spaceIdx >= 0) return spaceIdx + 1;
	return -1;
}

function shouldFlushPhrase(text: string, displayed: string, lastFlushTime: number, now: number): boolean {
	if (text === displayed) return false;
	// If text is completely different (not incremental), check if it's just a slide
	if (!text.startsWith(displayed) && !displayed.startsWith(text)) {
		// Tail-view windows slide: old suffix overlaps new prefix.
		// If overlap is significant (>50%), treat as a slide, not a rewrite.
		const overlap = computeOverlapLen(displayed, text);
		const minLen = Math.min(displayed.length, text.length);
		if (overlap > 0 && overlap >= minLen * 0.5) {
			return now - lastFlushTime > MAX_PHRASE_BUFFER_TIME;
		}
		return true;
	}
	// Check buffer timeout
	if (now - lastFlushTime > MAX_PHRASE_BUFFER_TIME) return true;
	// Find new content added since displayed
	let newContent = '';
	if (text.startsWith(displayed)) {
		newContent = text.slice(displayed.length);
	} else {
		newContent = text;
	}
	const boundaryPos = findPhraseBoundary(newContent);
	return boundaryPos >= 0;
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
// Fast random char pool — pre-filled to reduce Math.random() calls ~80%
// ---------------------------------------------------------------------------

const RANDOM_POOL_SIZE = 512;
let randomPool: string[] = [];
let randomPoolIndex = 0;

function fillRandomPool(): void {
	randomPool = new Array(RANDOM_POOL_SIZE);
	for (let i = 0; i < RANDOM_POOL_SIZE; i++) {
		randomPool[i] = SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
	}
	randomPoolIndex = 0;
}

function poolRandomChar(): string {
	if (randomPoolIndex >= randomPool.length) {
		fillRandomPool();
	}
	return randomPool[randomPoolIndex++];
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
			while (cursorChars.length <= cursorIdx) cursorChars.push(poolRandomChar());
			if (Math.random() < STREAM_RERANDOMIZE_RATE || !cursorChars[cursorIdx]) {
				cursorChars[cursorIdx] = poolRandomChar();
			}
			result += cursorChars[cursorIdx];
		} else {
			// Beyond cursor — live scramble (keeps fuzzing each frame)
			if (!inDim) {
				result += DIM_ON;
				inDim = true;
			}
			result += poolRandomChar();
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
		const start = Math.floor(easeInQuad(Math.random()) * maxStart);
		const end = start + Math.floor(Math.random() * maxLength);
		queue.push({ from, to, start, end });
	}
	return queue;
}

export function computeCascadeFrame(queue: QueueItem[], frame: number): string {
	const clampedFrame = Math.max(0, frame);
	const output: string[] = new Array(queue.length);
	let outIdx = 0;
	for (const item of queue) {
		if (item.to === ' ') {
			output[outIdx++] = ' ';
			continue;
		}
		if (clampedFrame >= item.end) {
			output[outIdx++] = item.to;
		} else if (clampedFrame >= item.start) {
			output[outIdx++] = `${DIM_ON}${poolRandomChar()}${DIM_OFF}`;
		} else {
			if (item.from === ' ') {
				output[outIdx++] = ' ';
			} else {
				output[outIdx++] = `${DIM_ON}${poolRandomChar()}${DIM_OFF}`;
			}
		}
	}
	output.length = outIdx;
	return output.join('');
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

/** Build the ANSI prefix for a scramble char based on illuminate config */
function illuminatePrefix(depth: number, elapsed: number, dur: number, config: IlluminateConfig): string {
	if (config.color === 'dynamic') {
		const progress = Math.min(1, Math.max(0, elapsed / dur));
		// heat = how deep in the ripple (0..1), life = how early in animation (1..0)
		const heat = Math.min(1, depth / DEPTH_BAND_MAX);
		const life = 1 - progress;
		const intensity = heat * life;

		// Smooth truecolor gradient across full 0..1 intensity using smoothstep
		let r: number, g: number, b: number;
		let prefix = '';
		if (intensity < 0.3) {
			const t = smoothstep(0, 0.3, intensity);
			r = lerp(0, 0, t);
			g = lerp(160, 255, t);
			b = lerp(128, 204, t);
			prefix = DIM_ON;
		} else if (intensity < 0.7) {
			const t = smoothstep(0.3, 0.7, intensity);
			r = lerp(0, 180, t);
			g = 255;
			b = lerp(204, 245, t);
		} else {
			const t = smoothstep(0.7, 1.0, intensity);
			r = lerp(180, 255, t);
			g = 255;
			b = lerp(245, 255, t);
			prefix = BOLD_ON;
		}
		return `${prefix}\x1b[38;2;${r};${g};${b}m`;
	}
	const base = config.color;
	if (config.glowIntensity === 'high') return BOLD_ON + base;
	if (config.glowIntensity === 'medium') return base;
	return DIM_ON + base;
}

export function applyRipples(
	text: string,
	ripples: Ripple[],
	now: number,
	config?: IlluminateConfig,
): string {
	if (!ripples.length) return text;
	const len = text.length;
	if (len === 0) return text;

	// In-place swap-and-pop to filter expired / future ripples
	let activeCount = 0;
	for (let i = 0; i < ripples.length; i++) {
		const r = ripples[i];
		if (r.time <= now && now - r.time < r.dur) {
			ripples[activeCount++] = r;
		}
	}
	ripples.length = activeCount;
	if (!activeCount) return text;

	// Pre-compute radius per ripple to avoid O(n·m) recomputation inside char loop
	const radii = new Float64Array(activeCount);
	for (let i = 0; i < activeCount; i++) {
		const r = ripples[i];
		const elapsed = Math.min(1, (now - r.time) / r.dur);
		const maxDist = Math.max(r.pos, len - r.pos - 1);
		radii[i] = easeOutCubic(elapsed) * maxDist * r.spread;
	}

	const segments: string[] = new Array(len * 3);
	let segCount = 0;
	let inColor = false;
	let currentPrefix = '';

	for (let idx = 0; idx < len; idx++) {
		const origChar = text[idx];
		if (origChar === ' ') {
			segments[segCount++] = origChar;
			continue;
		}

		let maxDepth = 0;
		let bestElapsed = 0;
		let bestDist = 0;
		let bestDur = ripples[0].dur;

		for (let i = 0; i < activeCount; i++) {
			const dist = Math.abs(idx - ripples[i].pos);
			const depth = radii[i] - dist;
			if (depth > 0) {
				const fade = 1 - smoothstep(DEPTH_BAND_MAX - 0.5, DEPTH_BAND_MAX + 2, depth);
				if (fade > 0 && depth > maxDepth) {
					maxDepth = Math.min(depth, DEPTH_BAND_MAX);
					bestElapsed = now - ripples[i].time;
					bestDist = dist;
					bestDur = ripples[i].dur;
				}
			}
		}

		if (maxDepth > 0) {
			const entropy = Math.floor(bestElapsed + bestDist) % 7;
			const char = selectScrambleChar(maxDepth, bestDist, bestElapsed, entropy);
			if (config) {
				const prefix = illuminatePrefix(maxDepth, bestElapsed, bestDur, config);
				if (!inColor || currentPrefix !== prefix) {
					if (inColor) segments[segCount++] = ILLUMINATE_CLOSE;
					segments[segCount++] = prefix;
					inColor = true;
					currentPrefix = prefix;
				}
				segments[segCount++] = char;
			} else {
				if (!inColor) {
					segments[segCount++] = DIM_ON;
					inColor = true;
					currentPrefix = DIM_ON;
				}
				segments[segCount++] = char;
			}
		} else {
			if (inColor) {
				segments[segCount++] = config ? ILLUMINATE_CLOSE : BOLD_OFF + RESET_COLOR + DIM_OFF;
				inColor = false;
				currentPrefix = '';
			}
			segments[segCount++] = origChar;
		}
	}

	if (inColor) {
		segments[segCount++] = config ? ILLUMINATE_CLOSE : BOLD_OFF + RESET_COLOR + DIM_OFF;
	}

	segments.length = segCount;
	return segments.join('');
}

function spawnRipple(
	pos: number,
	now: number,
	dur: number = RIPPLE_DUR_DEFAULT,
	spread: number = RIPPLE_SPREAD_DEFAULT,
): Ripple {
	return { pos, time: now, dur, spread };
}

function spawnIlluminateRipple(pos: number, now: number, config: IlluminateConfig): Ripple {
	return { pos, time: now, dur: config.duration, spread: config.spread };
}

/**
 * Compute a ripple spawn center with random jitter.
 * The position is anchored at the text center but randomized by up to
 * `jitterRatio` of the text length (default ±20%), clamped to [0, len-1].
 */
function randomizedCenter(length: number, jitterRatio = 0.2): number {
	const base = Math.floor(length / 2);
	if (length <= 1) return base;
	// Cap jitter so center never lands at the very edge for short texts,
	// preserving wavefront symmetry.
	const rawJitter = Math.floor(length * jitterRatio);
	const maxJitter = Math.max(0, Math.min(rawJitter, base - 1, length - base - 2));
	if (maxJitter <= 0) return base;
	const offset = Math.floor(Math.random() * (maxJitter * 2 + 1)) - maxJitter;
	return base + offset;
}

// ---------------------------------------------------------------------------
// Unified apply function (cascade/ripple/illuminate)
// ---------------------------------------------------------------------------

function applyScramble(text: string, state: LineState, now: number, mode: ScrambleMode, lineKey?: LineKey): string {
	if (mode === 'cascade') {
		if (!state.queue.length) return text;
		const frame = Math.floor((now - state.startTime) / CASCADE_FRAME_MS);
		if (isCascadeComplete(state.queue, frame)) {
			state.queue = [];
			return text;
		}
		return computeCascadeFrame(state.queue, frame);
	} else if (mode === 'illuminate') {
		const displayText = state.displayedText || text;
		const config = lineKey === 'msg'
			? ILLUMINATE_CONFIGS.msgContent
			: lineKey === 'act'
				? ILLUMINATE_CONFIGS.actLabel
				: undefined;
		return applyRipples(displayText, state.ripples, now, config);
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
	lineKey?: LineKey,
): void {
	if (state.completed) return;

	// Illuminate mode: phrase buffering for msg:
	if (mode === 'illuminate') {
		if (!state.initialized) {
			state.lastText = newText;
			state.displayedText = newText;
			state.lastFlushTime = now;
			state.initialized = true;
			return;
		}
		if (state.lastText === newText) {
			return;
		}
		const cooledDown = now - state.lastAnimTime > MIN_RIPPLE_INTERVAL;
		if (!cooledDown) {
			state.lastText = newText;
			return;
		}
		// Phrase buffering: only flush at boundaries or timeout
		if (lineKey === 'msg') {
			if (shouldFlushPhrase(newText, state.displayedText, state.lastFlushTime, now)) {
				state.displayedText = newText;
				state.lastText = newText;
				state.lastFlushTime = now;
				state.lastAnimTime = now;
				state.ripples.push(spawnIlluminateRipple(randomizedCenter(newText.length), now, ILLUMINATE_CONFIGS.msgContent));
			} else {
				// Text changed but no flush yet — update lastText for tracking.
				// For tail-view slides (non-extension), also update displayedText
				// so the rendered text tracks the sliding window instead of
				// showing stale buffered content mixed with scramble ripples.
				const isExtension = state.displayedText &&
					newText.startsWith(state.displayedText) &&
					newText.length > state.displayedText.length;
				if (!isExtension) {
					state.displayedText = newText;
				}
				state.lastText = newText;
			}
		} else {
			// act: and aim: — immediate update with config
			state.displayedText = newText;
			state.lastText = newText;
			state.lastFlushTime = now;
			state.lastAnimTime = now;
			const config = lineKey === 'act' ? ILLUMINATE_CONFIGS.actLabel : undefined;
			if (config) {
				state.ripples.push(spawnIlluminateRipple(randomizedCenter(newText.length), now, config));
			} else {
				state.ripples.push(spawnRipple(randomizedCenter(newText.length), now));
			}
		}
		let keep = 0;
		for (let i = 0; i < state.ripples.length; i++) {
			if (now - state.ripples[i].time < state.ripples[i].dur) {
				state.ripples[keep++] = state.ripples[i];
			}
		}
		state.ripples.length = keep;
		return;
	}

	// Standard modes (stream/cascade/ripple)
	const textChanged = state.lastText !== newText;
	if (!state.initialized) {
		state.lastText = newText;
		state.initialized = true;
		return;
	}
	if (!textChanged) return;
	const oldText = state.lastText;
	// Detect tail-view slides: if old suffix matches new prefix significantly,
	// the visible window is just sliding — don't restart animation.
	const overlap = computeOverlapLen(oldText, newText);
	const minLen = Math.min(oldText.length, newText.length);
	if (overlap > 0 && overlap >= minLen * 0.5) {
		state.lastText = newText;
		return;
	}
	const cooledDown = now - state.lastAnimTime > MIN_RIPPLE_INTERVAL;
	if (cooledDown) {
		state.lastText = newText;
		state.lastAnimTime = now;
		if (mode === 'cascade') {
			state.queue = buildQueue(oldText, newText);
			state.startTime = now;
		} else {
			state.ripples.push(spawnRipple(randomizedCenter(newText.length), now));
		}
	}
	if (mode === 'ripple') {
		let keep = 0;
		for (let i = 0; i < state.ripples.length; i++) {
			if (now - state.ripples[i].time < state.ripples[i].dur) {
				state.ripples[keep++] = state.ripples[i];
			}
		}
		state.ripples.length = keep;
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
		phraseBuffer: '',
		displayedText: '',
		lastFlushTime: 0,
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
	if (maxOverlap === 0) return 0;

	// KMP LPS array for newStr prefix of length maxOverlap
	const lps = new Array(maxOverlap).fill(0);
	let len = 0;
	for (let i = 1; i < maxOverlap; i++) {
		while (len > 0 && newStr[i] !== newStr[len]) {
			len = lps[len - 1];
		}
		if (newStr[i] === newStr[len]) len++;
		lps[i] = len;
	}

	// Match newStr prefix against oldStr suffix
	len = 0;
	const startIdx = Math.max(0, oldStr.length - maxOverlap);
	for (let i = startIdx; i < oldStr.length; i++) {
		while (len > 0 && oldStr[i] !== newStr[len]) {
			len = lps[len - 1];
		}
		if (oldStr[i] === newStr[len]) len++;
	}

	return len;
}

const MAX_FLOW_ENTRIES = 128;

export class ScrambleStateManager {
	private static readonly VALID_MODES: readonly ScrambleMode[] = ['stream', 'cascade', 'ripple', 'illuminate'];
	private mode: ScrambleMode = DEFAULT_MODE;
	private cache = new Map<string, Record<LineKey, LineState>>();
	private tpsState = new Map<string, ValueFlashState>();
	private streamState = new Map<string, { msg: TypewriterState; act: TypewriterState }>();
	private genericCache = new Map<string, LineState>();

	setMode(mode: ScrambleMode): void {
		if (!ScrambleStateManager.VALID_MODES.includes(mode)) {
			throw new Error(`Invalid scramble mode: ${mode}. Expected one of: ${ScrambleStateManager.VALID_MODES.join(', ')}`);
		}
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
	// Generic text animation (any key, any text)
	// -----------------------------------------------------------------------

	private getGenericState(id: string, key: string): LineState {
		const cacheKey = `${id}#${key}`;
		let state = this.genericCache.get(cacheKey);
		if (!state) {
			state = createLineState();
			this.genericCache.set(cacheKey, state);
		}
		return state;
	}

	updateText(id: string, key: string, text: string, now: number, isComplete: boolean = false): ScrambleResult {
		if (isComplete) {
			const state = this.genericCache.get(`${id}#${key}`);
			if (!state) return { label: key, content: text, isAnimating: false };
		}
		const state = this.getGenericState(id, key);
		// Reset if a previously-completed flow is now running again
		if (!isComplete && state.completed) {
			state.completed = false;
			state.queue = [];
			state.ripples = [];
			state.lastText = '';
			state.initialized = false;
			state.phraseBuffer = '';
			state.displayedText = '';
			state.lastFlushTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) return { label: key, content: text, isAnimating: false };
		// Trigger initial reveal animation for static text (non-stream modes)
		if (!state.initialized && this.mode !== 'stream') {
			state.lastText = text;
			state.initialized = true;
			state.lastAnimTime = now;
			if (this.mode === 'cascade') {
				state.queue = buildQueue('', text);
				state.startTime = now;
			} else if (this.mode === 'illuminate') {
				state.ripples.push(spawnIlluminateRipple(randomizedCenter(text.length), now, ILLUMINATE_CONFIGS.msgContent));
			} else {
				state.ripples.push(spawnRipple(randomizedCenter(text.length), now));
			}
		} else {
			processLine(state, text, now, this.mode);
		}
		const content = applyScramble(text, state, now, this.mode);
		const isAnimating = this.isLineAnimating(state, now);
		return { label: key, content, isAnimating };
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
		if (isComplete) {
			const record = this.cache.get(id);
			if (!record) return { label: 'act:', content: text, isAnimating: false };
		}
		const state = this.getState(id, 'act');
		// Reset if a previously-completed flow is now running again (new flow started)
		if (!isComplete && state.completed) {
			state.completed = false;
			state.queue = [];
			state.ripples = [];
			state.lastText = '';
			state.initialized = false;
			state.phraseBuffer = '';
			state.displayedText = '';
			state.lastFlushTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) return { label: 'act:', content: text, isAnimating: false };
		processLine(state, text, now, this.mode, 'act');
		const content = applyScramble(text, state, now, this.mode, 'act');
		const isAnimating = this.isLineAnimating(state, now);
		return { label: 'act:', content, isAnimating };
	}

	// -----------------------------------------------------------------------
	// msg: — stream/cascade/ripple on text change
	// -----------------------------------------------------------------------

	updateMsg(id: string, text: string, now: number, isComplete: boolean = false): ScrambleResult {
		if (isComplete) {
			const record = this.cache.get(id);
			if (!record) return { label: 'msg:', content: text, isAnimating: false };
		}
		const state = this.getState(id, 'msg');
		// Reset if a previously-completed flow is now running again (new flow started)
		if (!isComplete && state.completed) {
			state.completed = false;
			state.queue = [];
			state.ripples = [];
			state.lastText = '';
			state.initialized = false;
			state.phraseBuffer = '';
			state.displayedText = '';
			state.lastFlushTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripples = [];
		}
		if (state.completed) return { label: 'msg:', content: text, isAnimating: false };
		processLine(state, text, now, this.mode, 'msg');
		const content = applyScramble(text, state, now, this.mode, 'msg');
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
		if (isComplete) {
			const record = this.streamState.get(id);
			if (!record) {
				const cleanText = stripAnsi(fullText);
				return tailText(cleanText, budget);
			}
		}
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
			// Only trust the overlap if the new text continues from the old;
			// otherwise it's a rewrite and we start from zero.
			let overlapLen = 0;
			if (state.fullText && cleanText.startsWith(state.fullText)) {
				overlapLen = computeOverlapLen(oldVisibleText, newVisibleText);
			}
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
		if (isComplete) {
			const record = this.streamState.get(id);
			if (!record) {
				const cleanText = stripAnsi(fullText);
				return cleanText.length > budget ? cleanText.slice(0, budget) : cleanText;
			}
		}
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

		// Detect tool call change — reset only when the tool name (first word) changes.
		// This avoids restarting the typewriter for minor arg changes of the same tool.
		if (state.fullText && cleanText !== state.fullText) {
			const oldTool = state.fullText.split(' ')[0];
			const newTool = cleanText.split(' ')[0];
			if (oldTool !== newTool) {
				state.fullText = cleanText;
				state.revealedCount = 0;
				state.lastRevealTime = now;
				state.cursorChars = [];
			} else {
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
		if (isComplete) {
			const s = this.tpsState.get(id);
			if (!s) return tpsText;
		}
		let state = this.tpsState.get(id);
		if (!state) {
			state = createValueFlashState();
			state.prev = tpsText;
			this.tpsState.set(id, state);
		}
		// Reset if a previously-completed flow is now running again (new flow started)
		if (!isComplete && state.completed) {
			state.completed = false;
			state.prev = '';
			state.queue = [];
			state.ripple = null;
			state.startTime = 0;
		}
		if (isComplete) {
			state.completed = true;
			state.queue = [];
			state.ripple = null;
		}
		if (state.completed) return tpsText;
		if (state.prev !== tpsText) {
			// Hysteresis: only flash on significant change or after settle time
			let shouldFlash = true;
			const prevVal = parseFloat(state.prev);
			const newVal = parseFloat(tpsText);
			if (!isNaN(prevVal) && !isNaN(newVal) && prevVal !== 0) {
				const deltaPct = Math.abs(newVal - prevVal) / prevVal;
				const timeSinceLast = state.startTime > 0 ? now - state.startTime : 0;
				shouldFlash = deltaPct > TPS_HYSTERESIS_PCT || timeSinceLast > TPS_HYSTERESIS_MS;
			}
			if (shouldFlash) {
				if (this.mode === 'cascade') {
					state.queue = buildQueue(state.prev, tpsText, CASCADE_FLASH_MAX_START, CASCADE_FLASH_MAX_LENGTH);
					state.startTime = now;
				} else if (this.mode === 'illuminate') {
					state.ripple = spawnIlluminateRipple(randomizedCenter(tpsText.length), now, ILLUMINATE_CONFIGS.tps);
					state.startTime = now;
				} else {
					state.ripple = spawnRipple(randomizedCenter(tpsText.length), now, TPS_FLASH_DUR, TPS_FLASH_SPREAD);
				}
			} else if (this.mode === 'cascade') {
				state.queue = []; // suppress old cascade when new value arrives without flash
			}
			state.prev = tpsText;
		}
		if (this.mode === 'cascade') {
			if (state.queue.length) {
				const frame = Math.max(0, Math.floor((now - state.startTime) / CASCADE_FRAME_MS));
				if (isCascadeComplete(state.queue, frame)) {
					state.queue = [];
					return tpsText;
				}
				return computeCascadeFrame(state.queue, frame);
			}
			return tpsText;
		} else if (this.mode === 'illuminate') {
			if (state.ripple && now - state.ripple.time < state.ripple.dur) {
				return applyRipples(tpsText, [state.ripple], now, ILLUMINATE_CONFIGS.tps);
			}
			state.ripple = null;
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
		// Cascade/ripple/illuminate
		const record = this.cache.get(id);
		if (record) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				if (this.isLineAnimating(record[key], now)) return true;
			}
		}
		// Generic cache entries for this id
		const prefix = `${id}#`;
		for (const [key, state] of this.genericCache) {
			if (key.startsWith(prefix) && this.isLineAnimating(state, now)) return true;
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
		// Cascade/ripple/illuminate
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
		for (const state of this.genericCache.values()) {
			if (this.isLineAnimating(state, now)) return true;
		}
		return false;
	}

	clear(): void {
		this.cache.clear();
		this.tpsState.clear();
		this.streamState.clear();
		this.genericCache.clear();
	}

	private sweepCompletedEntries(): void {
		if (this.cache.size <= MAX_FLOW_ENTRIES && this.streamState.size <= MAX_FLOW_ENTRIES && this.tpsState.size <= MAX_FLOW_ENTRIES && this.genericCache.size <= MAX_FLOW_ENTRIES * 2) {
			return;
		}
		for (const [id, record] of this.cache) {
			if (record.aim.completed && record.act.completed && record.msg.completed) {
				this.cache.delete(id);
			}
		}
		for (const [id, state] of this.streamState) {
			if (state.msg.completed && state.act.completed) {
				this.streamState.delete(id);
			}
		}
		for (const [id, state] of this.tpsState) {
			if (state.completed) {
				this.tpsState.delete(id);
			}
		}
		for (const [key, state] of this.genericCache) {
			if (state.completed) {
				this.genericCache.delete(key);
			}
		}
	}

	completeFlow(id: string): void {
		const record = this.cache.get(id);
		if (record) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				record[key].completed = true;
				record[key].queue = [];
				record[key].ripples = [];
				record[key].phraseBuffer = '';
				record[key].displayedText = '';
				record[key].lastFlushTime = 0;
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
		// Mark generic entries for this id as completed
		const prefix = `${id}#`;
		for (const [key, state] of this.genericCache) {
			if (key.startsWith(prefix)) {
				state.completed = true;
				state.queue = [];
				state.ripples = [];
			}
		}
		this.sweepCompletedEntries();
	}

	/** Legacy aliases */
	hasActiveRipples(id: string, now: number): boolean {
		return this.hasActiveAnimations(id, now);
	}

	hasAnyActiveRipples(now: number): boolean {
		return this.hasAnyActiveAnimations(now);
	}
}

/**
 * Shared animation timer — wired by any renderer that uses scrambleManager.
 * Uses chained setTimeout (not setInterval) to avoid TUI ghost frames.
 */
export function runScrambleTimer(args: Record<string, any> | undefined): void {
	if (args?.invalidate && args?.state) {
		const s = (args.state as any).__scramble = (args.state as any).__scramble || {};
		const now = Date.now();
		const hasActive = scrambleManager.hasAnyActiveAnimations(now);

		if (hasActive) {
			if (!s.animTimer) {
				const interval = scrambleManager.getMode() === 'cascade' ? CASCADE_FRAME_MS : 50;
				s.animTimer = setTimeout(() => {
					s.animTimer = undefined;
					args.invalidate!();
				}, interval);
			}
		} else if (s.animTimer) {
			clearTimeout(s.animTimer);
			s.animTimer = undefined;
		}
	}
}

/** Module-level singleton for use across render calls. */
export const scrambleManager = new ScrambleStateManager();

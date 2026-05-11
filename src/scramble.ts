/**
 * Hermes-style radial ripple text scramble effect for terminal TUI.
 *
 * Adapts the Hermes website's Scramble component (radial wave propagation
 * with box-drawing Unicode characters) for ANSI terminal output.
 * Ripples spawn on text/KPI changes, with a 5s idle word flip for aim: lines.
 */

import type { SingleResult, UsageStats } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Character set for scramble display — box-drawing + symbols (Hermes). */
const SCRAMBLE_CHARS = '.,·-─~+:;=*π""┐┌┘┴┬╗╔╝╚╬╠╣╩╦║░▒▓█▄▀▌▐■!?&#$@0123456789*';

const RIPPLE_DUR_DEFAULT = 666;   // ms — full content ripple duration
const RIPPLE_SPREAD_DEFAULT = 1;  // Hermes default spread

const LABEL_FLASH_DUR = 200;     // ms — brief label flash
const LABEL_FLASH_SPREAD = 0.5;  // tighter wave for short label text

const IDLE_FLIP_DUR = 300;       // ms — quick idle word flip
const IDLE_FLIP_SPREAD = 2;      // localized ripple
const IDLE_FLIP_INTERVAL = 5000; // ms — time between idle flips

const MIN_RIPPLE_INTERVAL = 200; // ms — cooldown to prevent chaos during streaming
const DEPTH_BAND_MAX = 3;        // Hermes: only scramble if 0 < depth <= 3

const DIM_ON = "\x1b[2m";
const DIM_OFF = "\x1b[0m";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface LineState {
	/** Previous display text for change detection. */
	lastText: string;
	/** Fingerprint of KPI values for change detection. */
	lastKpiHash: string;
	/** Active content ripples. */
	ripples: Ripple[];
	/** Active label ripples. */
	labelRipples: Ripple[];
	/** Timestamp of last ripple spawn (for cooldown). */
	lastRippleTime: number;
	/** Timestamp when next idle flip is due. */
	idleFlipDueAt: number;
	/** Whether the first call has initialized the state (to avoid false change on first set). */
	initialized: boolean;
}

type LineKey = "aim" | "act" | "msg";

export interface ScrambleResult {
	/** Label text (e.g. "aim:") — may be scrambled if label ripple active. */
	label: string;
	/** Content text — may be scrambled if content ripple active. */
	content: string;
	/** Whether any ripple animation is currently in progress. */
	isAnimating: boolean;
}

// ---------------------------------------------------------------------------
// Pure algorithm functions (Hermes ripple, verbatim)
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
 *     if (dist <= radius && depth > 0 && depth <= 3):
 *       char = CHARS[(3 * dist + floor(elapsed/40)) % CHARS.length]
 */
export function applyRipples(text: string, ripples: Ripple[], now: number): string {
	if (!ripples.length) return text;

	const len = text.length;
	if (len === 0) return text;

	// Filter to active ripples only
	const active = ripples.filter((r) => now - r.time < r.dur);
	if (!active.length) return text;

	let result = "";
	for (let idx = 0; idx < len; idx++) {
		const origChar = text[idx];

		// Spaces are preserved untouched (Hermes behavior)
		if (origChar === " ") {
			result += origChar;
			continue;
		}

		let scrambled = false;
		for (const ripple of active) {
			const elapsed = now - ripple.time;
			if (elapsed < 0) continue; // future ripple (shouldn't happen)

			const maxDist = Math.max(ripple.pos, len - ripple.pos - 1) + 5;
			const radius = Math.min(elapsed / ripple.dur, 1) * maxDist / ripple.spread;
			const dist = Math.abs(idx - ripple.pos);
			const depth = radius - dist;

			if (dist <= radius && depth > 0 && depth <= DEPTH_BAND_MAX) {
				const charIdx = (3 * dist + Math.floor(elapsed / 40)) % SCRAMBLE_CHARS.length;
				result += `${DIM_ON}${SCRAMBLE_CHARS[charIdx < 0 ? charIdx + SCRAMBLE_CHARS.length : charIdx]}${DIM_OFF}`;
			scrambled = true;
			break; // first matching ripple wins
			}
		}

		if (!scrambled) {
			result += origChar;
		}
	}
	return result;
}

/**
 * Spawn a ripple at a given position.
 * Pure factory function.
 */
function spawnRipple(pos: number, now: number, dur: number = RIPPLE_DUR_DEFAULT, spread: number = RIPPLE_SPREAD_DEFAULT): Ripple {
	return { pos, time: now, dur, spread };
}

/**
 * Find the center character index of a random complete word in text.
 * Returns undefined if no words found.
 */
function randomWordCenter(text: string): number | undefined {
	const words: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < text.length) {
		// Skip spaces
		while (i < text.length && text[i] === " ") i++;
		if (i >= text.length) break;
		const start = i;
		// Find end of word
		while (i < text.length && text[i] !== " ") i++;
		words.push({ start, end: i - 1 });
	}
	if (!words.length) return undefined;
	const word = words[Math.floor(Math.random() * words.length)];
	return Math.floor((word.start + word.end) / 2);
}

/**
 * Hash KPI values for change detection. Produces a stable string.
 */
function hashKpi(usage: UsageStats, extra?: number): string {
	return `${usage.input}:${usage.output}:${usage.toolCalls}${extra !== undefined ? `:${extra}` : ""}`;
}

/**
 * Process a single line's state: detect changes, spawn ripples, expire old ones.
 * Mutates `state` in place.
 */
function processLine(
	state: LineState,
	newText: string,
	newKpiHash: string,
	now: number,
	opts: { isAim: boolean; labelCenter?: number },
): void {
	const textChanged = state.lastText !== newText;
	const kpiChanged = state.lastKpiHash !== newKpiHash;
	const cooledDown = now - state.lastRippleTime > MIN_RIPPLE_INTERVAL;

	if (!state.initialized) {
		// First call: just store the initial values, no ripple
		state.lastText = newText;
		state.lastKpiHash = newKpiHash;
		state.initialized = true;
	} else if ((textChanged || kpiChanged) && cooledDown) {
		// Spawn content ripple at center of new text
		const center = Math.floor(newText.length / 2);
		state.ripples.push(spawnRipple(center, now, RIPPLE_DUR_DEFAULT, RIPPLE_SPREAD_DEFAULT));
		state.lastRippleTime = now;

		// Spawn label ripple (brief flash)
		const labelCenter = opts.labelCenter ?? 2;
		state.labelRipples.push(spawnRipple(labelCenter, now, LABEL_FLASH_DUR, LABEL_FLASH_SPREAD));

		state.lastText = newText;
		state.lastKpiHash = newKpiHash;
		state.idleFlipDueAt = now + IDLE_FLIP_INTERVAL;
	}

	// Idle flip (aim only)
	if (opts.isAim && now >= state.idleFlipDueAt && cooledDown) {
		const wordCenter = randomWordCenter(newText);
		if (wordCenter !== undefined) {
			state.ripples.push(spawnRipple(wordCenter, now, IDLE_FLIP_DUR, IDLE_FLIP_SPREAD));
			state.lastRippleTime = now;
		}
		state.idleFlipDueAt = now + IDLE_FLIP_INTERVAL;
	}

	// Expire old ripples
	state.ripples = state.ripples.filter((r) => now - r.time < r.dur);
	state.labelRipples = state.labelRipples.filter((r) => now - r.time < r.dur);
}

// ---------------------------------------------------------------------------
// ScrambleStateManager
// ---------------------------------------------------------------------------

function createLineState(now: number): LineState {
	return {
		lastText: "", // will be set on first call without triggering ripple
		lastKpiHash: "",
		ripples: [],
		labelRipples: [],
		lastRippleTime: 0,
		idleFlipDueAt: now + IDLE_FLIP_INTERVAL,
		initialized: false,
	};
}

export class ScrambleStateManager {
	private cache = new WeakMap<SingleResult, Record<LineKey, LineState>>();

	/** Get or create LineState for a given result + key. */
	private getState(r: SingleResult, key: LineKey, now: number): LineState {
		let record = this.cache.get(r);
		if (!record) {
			record = {
				aim: createLineState(now),
				act: createLineState(now),
				msg: createLineState(now),
			};
			this.cache.set(r, record);
		}
		return record[key];
	}

	/**
	 * Update aim line. Detects content changes.
	 * Also handles 5s idle word flip.
	 */
	updateAim(r: SingleResult, text: string, now: number): ScrambleResult {
		const state = this.getState(r, "aim", now);
		processLine(state, text, "", now, { isAim: true, labelCenter: 2 });

		const label = applyRipples("aim:", state.labelRipples, now);
		const content = applyRipples(text, state.ripples, now);
		const isAnimating = state.ripples.length > 0 || state.labelRipples.length > 0;

		return { label, content, isAnimating };
	}

	/**
	 * Update act line. Detects content changes AND toolCalls changes.
	 */
	updateAct(r: SingleResult, text: string, toolCalls: number, now: number): ScrambleResult {
		const state = this.getState(r, "act", now);
		const kpiHash = hashKpi(r.usage, toolCalls);
		processLine(state, text, kpiHash, now, { isAim: false, labelCenter: 2 });

		const label = applyRipples("act:", state.labelRipples, now);
		const content = applyRipples(text, state.ripples, now);
		const isAnimating = state.ripples.length > 0 || state.labelRipples.length > 0;

		return { label, content, isAnimating };
	}

	/**
	 * Update msg line. Detects content changes AND token usage changes.
	 */
	updateMsg(r: SingleResult, text: string, usage: UsageStats, now: number): ScrambleResult {
		const state = this.getState(r, "msg", now);
		const kpiHash = hashKpi(usage);
		processLine(state, text, kpiHash, now, { isAim: false, labelCenter: 2 });

		const label = applyRipples("msg:", state.labelRipples, now);
		const content = applyRipples(text, state.ripples, now);
		const isAnimating = state.ripples.length > 0 || state.labelRipples.length > 0;

		return { label, content, isAnimating };
	}
}

/** Module-level singleton for use across render calls. */
export const scrambleManager = new ScrambleStateManager();

/**
 * Radial ripple text scramble effect for terminal TUI.
 *
 * Adapts the Hermes website's Scramble component (radial wave propagation)
 * with classic ASCII-safe character set. Ripples spawn on text/KPI changes,
 * with a 5s idle word flip for aim: lines.
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

const RIPPLE_DUR_DEFAULT = 666;   // ms — full content ripple duration
const RIPPLE_SPREAD_DEFAULT = 1;  // Hermes default spread
const IDLE_FLIP_DUR = 300;       // ms — quick idle word flip
const IDLE_FLIP_SPREAD = 2;      // localized ripple
const IDLE_FLIP_INTERVAL = 5000; // ms — time between idle flips
const MIN_RIPPLE_INTERVAL = 250; // ms — cooldown to let the neon bloom settle
const DEPTH_BAND_MAX = 3;          // Classic: 0-3 depth band
const COUNTDOWN_FLASH_DUR = 150;  // ms — countdown value flash
const COUNTDOWN_FLASH_SPREAD = 0.5;
const TPS_FLASH_DUR = 150;       // ms — TPS value flash
const TPS_FLASH_SPREAD = 0.5;

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';

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
	/** Timestamp of last ripple spawn (for cooldown). */
	lastRippleTime: number;
	/** Timestamp when next idle flip is due. */
	idleFlipDueAt: number;
	/** Whether the first call has initialized the state (to avoid false change on first set). */
	initialized: boolean;
}

type LineKey = 'aim' | 'act' | 'msg';

export interface ScrambleResult {
	/** Label text (e.g. 'aim:') — always plain, never scrambled. */
	label: string;
	/** Content text — may be scrambled if content ripple active. */
	content: string;
	/** Whether any ripple animation is currently in progress. */
	isAnimating: boolean;
}

/**
 * Single-value flash state for countdown/TPS — tracks previous value
 * and one active ripple.
 */
interface ValueFlashState {
	prev: string;
	ripple: Ripple | null;
}

// ---------------------------------------------------------------------------
// Core algorithm functions (Hermes ripple, verbatim + Illuminate chars)
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
			if (elapsed < 0) continue; // future ripple (shouldn't happen)

			const maxDist = Math.max(ripple.pos, len - ripple.pos - 1) + 5;
			const radius = Math.min(elapsed / ripple.dur, 1) * maxDist / ripple.spread;
			const dist = Math.abs(idx - ripple.pos);
			const depth = radius - dist;

			if (dist <= radius && depth > 0 && depth <= DEPTH_BAND_MAX) {
				const charIdx = (3 * dist + Math.floor(elapsed / 40)) % SCRAMBLE_CHARS.length;
				const char = SCRAMBLE_CHARS[charIdx < 0 ? charIdx + SCRAMBLE_CHARS.length : charIdx];
				result += `${DIM_ON}${char}${DIM_OFF}`;
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
		while (i < text.length && text[i] === ' ') i++;
		if (i >= text.length) break;
		const start = i;
		// Find end of word
		while (i < text.length && text[i] !== ' ') i++;
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
	return usage.input + ':' + usage.output + ':' + usage.toolCalls + (extra !== undefined ? ':' + extra : '');
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
	opts: { isAim: boolean; noContentRipple?: boolean },
): void {
	const textChanged = state.lastText !== newText;
	const kpiChanged = state.lastKpiHash !== newKpiHash;
	const cooledDown = now - state.lastRippleTime > MIN_RIPPLE_INTERVAL;

	if (!state.initialized) {
		// First call: just store the initial values, no ripple
		state.lastText = newText;
		state.lastKpiHash = newKpiHash;
		state.initialized = true;
	} else if (textChanged || kpiChanged) {
		// Always track the latest text/KPI so we don't re-trigger after cooldown expires
		state.lastText = newText;
		state.lastKpiHash = newKpiHash;

		if (cooledDown) {
			// Only spawn content ripple if not suppressed (aim/act skip content ripple)
			if (!opts.noContentRipple) {
				const center = Math.floor(newText.length / 2);
				state.ripples.push(spawnRipple(center, now, RIPPLE_DUR_DEFAULT, RIPPLE_SPREAD_DEFAULT));
			}
			state.lastRippleTime = now;
			state.idleFlipDueAt = now + IDLE_FLIP_INTERVAL;
		}
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
}

// ---------------------------------------------------------------------------
// ScrambleStateManager
// ---------------------------------------------------------------------------

function createLineState(now: number): LineState {
	return {
		lastText: '', // will be set on first call without triggering ripple
		lastKpiHash: '',
		ripples: [],
		lastRippleTime: 0,
		idleFlipDueAt: now + IDLE_FLIP_INTERVAL,
		initialized: false,
	};
}

export class ScrambleStateManager {
	private cache = new Map<string, Record<LineKey, LineState>>();
	private countdownState = new Map<string, ValueFlashState>();
	private tpsState = new Map<string, ValueFlashState>();

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
	 * NO content ripple on text change — only idle word flip.
	 */
	updateAim(id: string, text: string, now: number): ScrambleResult {
		const state = this.getState(id, 'aim', now);
		processLine(state, text, '', now, { isAim: true, noContentRipple: true });

		const label = 'aim:';
		const content = applyRipples(text, state.ripples, now);
		const isAnimating = state.ripples.length > 0;

		return { label, content, isAnimating };
	}

	/**
	 * Update act line. Detects content changes AND toolCalls changes.
	 * NO content ripple — only label stays plain, act changes tracked.
	 */
	updateAct(id: string, text: string, toolCalls: number, usage: UsageStats, now: number): ScrambleResult {
		const state = this.getState(id, 'act', now);
		const kpiHash = hashKpi(usage, toolCalls);
		processLine(state, text, kpiHash, now, { isAim: false, noContentRipple: true });

		const label = 'act:';
		const content = applyRipples(text, state.ripples, now);
		const isAnimating = state.ripples.length > 0;

		return { label, content, isAnimating };
	}

	/**
	 * Update msg line. Detects content changes AND token usage changes.
	 * Content ripple IS active for msg.
	 */
	updateMsg(id: string, text: string, usage: UsageStats, now: number): ScrambleResult {
		const state = this.getState(id, 'msg', now);
		const kpiHash = hashKpi(usage);
		processLine(state, text, kpiHash, now, { isAim: false });

		const label = 'msg:';
		const content = applyRipples(text, state.ripples, now);
		const isAnimating = state.ripples.length > 0;

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
			state = { prev: countdown, ripple: null };
			this.countdownState.set(id, state);
			return countdown;
		}
		if (state.prev !== countdown) {
			state.ripple = spawnRipple(Math.floor(countdown.length / 2), now, COUNTDOWN_FLASH_DUR, COUNTDOWN_FLASH_SPREAD);
			state.prev = countdown;
		}
		if (state.ripple && now - state.ripple.time < state.ripple.dur) {
			return applyRipples(countdown, [state.ripple], now);
		}
		state.ripple = null;
		return countdown;
	}

	/**
	 * Flash the TPS value when it changes.
	 * Returns the (possibly scrambled) TPS string.
	 */
	updateTps(id: string, tpsText: string, now: number): string {
		if (!tpsText || tpsText.trim() === '-') return tpsText;
		let state = this.tpsState.get(id);
		if (!state) {
			state = { prev: tpsText, ripple: null };
			this.tpsState.set(id, state);
			return tpsText;
		}
		if (state.prev !== tpsText) {
			state.ripple = spawnRipple(Math.floor(tpsText.length / 2), now, TPS_FLASH_DUR, TPS_FLASH_SPREAD);
			state.prev = tpsText;
		}
		if (state.ripple && now - state.ripple.time < state.ripple.dur) {
			return applyRipples(tpsText, [state.ripple], now);
		}
		state.ripple = null;
		return tpsText;
	}

	/**
	 * Check whether a given result has any ripples still alive at `now`.
	 */
	hasActiveRipples(id: string, now: number): boolean {
		const record = this.cache.get(id);
		if (!record) return false;
		for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
			const state = record[key];
			if (state.ripples.some((rp) => rp.time + rp.dur > now)) return true;
		}
		return false;
	}

	clear(): void {
		this.cache.clear();
		this.countdownState.clear();
		this.tpsState.clear();
	}

	hasAnyActiveRipples(now: number): boolean {
		for (const record of this.cache.values()) {
			for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
				const state = record[key];
				if (state.ripples.some((rp) => rp.time + rp.dur > now)) return true;
			}
		}
		for (const state of this.countdownState.values()) {
			if (state.ripple && state.ripple.time + state.ripple.dur > now) return true;
		}
		for (const state of this.tpsState.values()) {
			if (state.ripple && state.ripple.time + state.ripple.dur > now) return true;
		}
		return false;
	}
}

/** Module-level singleton for use across render calls. */
export const scrambleManager = new ScrambleStateManager();

/**
 * Hermes-style radial ripple text scramble effect for terminal TUI.
 *
 * Adapts the Hermes website's Scramble component (radial wave propagation
 * with box-drawing Unicode characters) for ANSI terminal output.
 * Ripples spawn on text/KPI changes, with a 5s idle word flip for aim: lines.
 */

import type { UsageStats } from './types.js';

const SCRAMBLE_CHARS = '.,·-─~+:;=*π""┐┌┘┴┬╗╔╝╚╬╠╣╩╦║░▒▓█▄▀▌▐■!?&#$@0123456789*';

const RIPPLE_DUR_DEFAULT = 666;
const RIPPLE_SPREAD_DEFAULT = 1;
const LABEL_FLASH_DUR = 200;
const LABEL_FLASH_SPREAD = 0.5;
const IDLE_FLIP_DUR = 300;
const IDLE_FLIP_SPREAD = 2;
const IDLE_FLIP_INTERVAL = 5000;
const MIN_RIPPLE_INTERVAL = 200;
const DEPTH_BAND_MAX = 3;
const COUNTDOWN_FLASH_DUR = 150;
const COUNTDOWN_FLASH_SPREAD = 0.5;
const TPS_FLASH_DUR = 150;
const TPS_FLASH_SPREAD = 0.5;

interface Ripple {
	pos: number;
	time: number;
	dur: number;
	spread: number;
}

interface LineState {
	lastText: string;
	lastKpiHash: string;
	ripples: Ripple[];
	labelRipples: Ripple[];
	lastRippleTime: number;
	idleFlipDueAt: number;
	initialized: boolean;
}

type LineKey = 'aim' | 'act' | 'msg';

export interface ScrambleResult {
	label: string;
	content: string;
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
				result += '\x1b[2m' + SCRAMBLE_CHARS[charIdx < 0 ? charIdx + SCRAMBLE_CHARS.length : charIdx] + '\x1b[22m';
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

function spawnRipple(pos: number, now: number, dur: number = RIPPLE_DUR_DEFAULT, spread: number = RIPPLE_SPREAD_DEFAULT): Ripple {
	return { pos, time: now, dur, spread };
}

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

function hashKpi(usage: UsageStats, extra?: number): string {
	return usage.input + ':' + usage.output + ':' + usage.toolCalls + (extra !== undefined ? ':' + extra : '');
}

function processLine(
	state: LineState,
	newText: string,
	newKpiHash: string,
	now: number,
	opts: { isAim: boolean; labelCenter?: number; noContentRipple?: boolean },
): void {
	const textChanged = state.lastText !== newText;
	const kpiChanged = state.lastKpiHash !== newKpiHash;
	const cooledDown = now - state.lastRippleTime > MIN_RIPPLE_INTERVAL;

	if (!state.initialized) {
		state.lastText = newText;
		state.lastKpiHash = newKpiHash;
		state.initialized = true;
	} else if ((textChanged || kpiChanged) && cooledDown) {
		// Only spawn content ripple if not suppressed (aim: skips content ripple)
		if (!opts.noContentRipple) {
			const center = Math.floor(newText.length / 2);
			state.ripples.push(spawnRipple(center, now, RIPPLE_DUR_DEFAULT, RIPPLE_SPREAD_DEFAULT));
		}
		state.lastRippleTime = now;
		const labelCenter = opts.labelCenter ?? 2;
		state.labelRipples.push(spawnRipple(labelCenter, now, LABEL_FLASH_DUR, LABEL_FLASH_SPREAD));
		state.lastText = newText;
		state.lastKpiHash = newKpiHash;
		state.idleFlipDueAt = now + IDLE_FLIP_INTERVAL;
	}

	if (opts.isAim && now >= state.idleFlipDueAt && cooledDown) {
		const wordCenter = randomWordCenter(newText);
		if (wordCenter !== undefined) {
			state.ripples.push(spawnRipple(wordCenter, now, IDLE_FLIP_DUR, IDLE_FLIP_SPREAD));
			state.lastRippleTime = now;
		}
		state.idleFlipDueAt = now + IDLE_FLIP_INTERVAL;
	}

	state.ripples = state.ripples.filter((r) => now - r.time < r.dur);
	state.labelRipples = state.labelRipples.filter((r) => now - r.time < r.dur);
}

function createLineState(now: number): LineState {
	return {
		lastText: '',
		lastKpiHash: '',
		ripples: [],
		labelRipples: [],
		lastRippleTime: 0,
		idleFlipDueAt: now + IDLE_FLIP_INTERVAL,
		initialized: false,
	};
}

export class ScrambleStateManager {
	private cache = new Map<string, Record<LineKey, LineState>>();
	private countdownState = new Map<string, ValueFlashState>();
	private tpsState = new Map<string, ValueFlashState>();

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
	 * NO content ripple on text change — only label flash + idle word flip.
	 */
	updateAim(id: string, text: string, now: number): ScrambleResult {
		const state = this.getState(id, 'aim', now);
		processLine(state, text, '', now, { isAim: true, labelCenter: 2, noContentRipple: true });
		const label = applyRipples('aim:', state.labelRipples, now);
		const content = applyRipples(text, state.ripples, now);
		const isAnimating = state.ripples.length > 0 || state.labelRipples.length > 0;
		return { label, content, isAnimating };
	}

	updateAct(id: string, text: string, toolCalls: number, usage: UsageStats, now: number): ScrambleResult {
		const state = this.getState(id, 'act', now);
		const kpiHash = hashKpi(usage, toolCalls);
		processLine(state, text, kpiHash, now, { isAim: false, labelCenter: 2 });
		const label = applyRipples('act:', state.labelRipples, now);
		const content = applyRipples(text, state.ripples, now);
		const isAnimating = state.ripples.length > 0 || state.labelRipples.length > 0;
		return { label, content, isAnimating };
	}

	updateMsg(id: string, text: string, usage: UsageStats, now: number): ScrambleResult {
		const state = this.getState(id, 'msg', now);
		const kpiHash = hashKpi(usage);
		processLine(state, text, kpiHash, now, { isAim: false, labelCenter: 2 });
		const label = applyRipples('msg:', state.labelRipples, now);
		const content = applyRipples(text, state.ripples, now);
		const isAnimating = state.ripples.length > 0 || state.labelRipples.length > 0;
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

	hasActiveRipples(id: string, now: number): boolean {
		const record = this.cache.get(id);
		if (!record) return false;
		for (const key of ['aim', 'act', 'msg'] as LineKey[]) {
			const state = record[key];
			if (state.ripples.some((rp) => rp.time + rp.dur > now)) return true;
			if (state.labelRipples.some((rp) => rp.time + rp.dur > now)) return true;
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
				if (state.labelRipples.some((rp) => rp.time + rp.dur > now)) return true;
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

export const scrambleManager = new ScrambleStateManager();

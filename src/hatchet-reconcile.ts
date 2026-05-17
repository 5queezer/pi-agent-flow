/**
 * Hatchet run reconciliation service.
 *
 * Reads active registry entries, queries the adapter for their current status,
 * updates the registry, and records goal progress exactly once per completed run.
 */

import type { HatchetRemoteRunStatus, HatchetRunAdapter } from "./hatchet-run-adapter.js";
import type { HatchetRunRecord } from "./hatchet-run-registry.js";
import {
	listActiveHatchetRuns,
	updateHatchetRunResult,
	updateHatchetRunFailure,
	markHatchetGoalRecorded,
	loadHatchetRunRegistry,
	sanitizeHatchetText,
} from "./hatchet-run-registry.js";
import { recordFlowCompletion, addTokens, getGoal } from "./flow/store.js";
import type { SingleResult } from "./types/flow.js";

const DEFAULT_RECONCILE_RESULT_TIMEOUT_MS = 5_000;

export interface HatchetReconcileOptions {
	cwd: string;
	sessionId?: string;
	goalId?: string;
	adapter: HatchetRunAdapter;
	/** When true, also reconcile runs from other sessions. Default: false. */
	includeOtherSessions?: boolean;
	/** Maximum time to wait for one remote status lookup before preserving it as running. */
	resultTimeoutMs?: number;
}

export interface HatchetReconcileSummary {
	checked: number;
	completed: number;
	running: number;
	failed: number;
	cancelled: number;
	unknown: number;
	messages: string[];
}

/**
 * Reconcile all active Hatchet runs for the given cwd against the adapter.
 * Updates registry statuses, records goal progress once for completed runs.
 */
export async function reconcileHatchetRuns(options: HatchetReconcileOptions): Promise<HatchetReconcileSummary> {
	const { cwd, sessionId, goalId, adapter, includeOtherSessions = false, resultTimeoutMs = DEFAULT_RECONCILE_RESULT_TIMEOUT_MS } = options;

	const activeRuns = listActiveHatchetRuns(cwd);

	// Filter by session unless includeOtherSessions is set.
	const runsToCheck = includeOtherSessions
		? activeRuns
		: activeRuns.filter((r) => !r.sessionId || !sessionId || r.sessionId === sessionId);

	const summary: HatchetReconcileSummary = {
		checked: runsToCheck.length,
		completed: 0,
		running: 0,
		failed: 0,
		cancelled: 0,
		unknown: 0,
		messages: [],
	};

	for (const run of runsToCheck) {
		if (run.status === "completed" && run.result) {
			summary.completed++;
			summary.messages.push(`[completed] ${run.flowType} — ${run.aim} — exit ${run.result.exitCode} — ${run.id}`);
			recordGoalProgressIfNeeded(cwd, run, run.result, goalId);
			continue;
		}

		// Runs with no remote handle were never successfully submitted.
		if (!run.hatchetRunId) {
			updateHatchetRunFailure(cwd, run.id, "unknown", "no remote handle — run may not have been submitted");
			summary.unknown++;
			summary.messages.push(`[unknown] ${run.flowType} — ${run.id} — no remote handle`);
			continue;
		}

		try {
			const remoteStatus = await getResultWithTimeout(adapter, run.hatchetRunId, resultTimeoutMs);

			switch (remoteStatus.status) {
				case "completed": {
					const result = remoteStatus.result;
					updateHatchetRunResult(cwd, run.id, result);
					summary.completed++;
					summary.messages.push(`[completed] ${run.flowType} — ${run.aim} — exit ${result.exitCode} — ${run.id}`);
					recordGoalProgressIfNeeded(cwd, run, result, goalId);
					break;
				}
				case "failed": {
					const errorMessage = sanitizeHatchetText(remoteStatus.errorMessage, "Hatchet run failed");
					updateHatchetRunFailure(cwd, run.id, "failed", errorMessage);
					summary.failed++;
					summary.messages.push(`[failed] ${run.flowType} — ${run.aim} — ${errorMessage} — ${run.id}`);
					break;
				}
				case "cancelled": {
					updateHatchetRunFailure(cwd, run.id, "cancelled", sanitizeHatchetText(remoteStatus.errorMessage, "Hatchet run cancelled"));
					summary.cancelled++;
					summary.messages.push(`[cancelled] ${run.flowType} — ${run.aim} — ${run.id}`);
					break;
				}
				case "queued":
				case "running": {
					summary.running++;
					summary.messages.push(`[${remoteStatus.status}] ${run.flowType} — ${run.aim} — ${run.id}`);
					break;
				}
				case "unknown": {
					summary.unknown++;
					summary.messages.push(`[unknown] ${run.flowType} — ${run.aim} — ${sanitizeHatchetText(remoteStatus.errorMessage, "unknown status")} — ${run.id}`);
					break;
				}
			}
		} catch (err) {
			// Adapter error — do not mark run as failed; keep it active for retry.
			const msg = sanitizeHatchetText(err instanceof Error ? err.message : String(err), "unknown error");
			summary.messages.push(`[error] ${run.flowType} — ${run.aim} — Hatchet API unavailable: ${msg} — ${run.id}`);
			summary.running++; // Count as still running since we don't know the real state.
		}
	}

	return summary;
}

async function getResultWithTimeout(
	adapter: HatchetRunAdapter,
	runId: string,
	timeoutMs: number,
): Promise<HatchetRemoteRunStatus> {
	if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) return await adapter.getResult({ runId });
	return await new Promise<HatchetRemoteRunStatus>((resolve, reject) => {
		const timer = setTimeout(() => {
			resolve({ status: "running", errorMessage: `Hatchet run status lookup exceeded ${timeoutMs}ms.` });
		}, timeoutMs);
		adapter.getResult({ runId }).then(
			(result) => {
				clearTimeout(timer);
				resolve(result);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function recordGoalProgressIfNeeded(
	cwd: string,
	run: Pick<HatchetRunRecord, "id" | "goalId" | "goalRecordedAt">,
	result: SingleResult,
	currentGoalId: string | undefined,
): void {
	if (result.exitCode !== 0 || run.goalRecordedAt) return;
	const shouldRecordGoal = shouldRecordGoalProgress(cwd, run.goalId, currentGoalId);
	if (!shouldRecordGoal) return;
	try {
		recordFlowCompletion(cwd, { type: result.type, intent: result.intent, aim: result.aim });
		addTokens(cwd, result.usage.input + result.usage.output);
		markHatchetGoalRecorded(cwd, run.id);
	} catch {
		// Keep completed-but-unrecorded runs reconcilable so a later reconcile can retry.
	}
}

/**
 * Determines whether goal progress should be recorded for a completed run.
 * Returns true when the run's goal matches the current active goal, or when
 * no current goal is set but the run's goal matches the passed goalId.
 */
function shouldRecordGoalProgress(
	cwd: string,
	runGoalId: string | undefined,
	currentGoalId: string | undefined,
): boolean {
	if (!runGoalId) return false;
	// If a specific current goal is provided and matches the run's goal, record.
	if (currentGoalId && runGoalId === currentGoalId) return true;
	// Otherwise check against the active stored goal.
	try {
		const goal = getGoal(cwd);
		if (!goal) return false;
		return goal.id === runGoalId && goal.status === "active";
	} catch {
		return false;
	}
}

/**
 * Format a reconciliation summary as human-readable text for display.
 */
export function formatReconcileSummary(summary: HatchetReconcileSummary): string {
	if (summary.checked === 0) {
		return "No active Hatchet runs to reconcile.";
	}
	const lines = [
		`Reconciled ${summary.checked} Hatchet run(s):`,
		...(summary.completed > 0 ? [`  ${summary.completed} completed`] : []),
		...(summary.running > 0 ? [`  ${summary.running} still running`] : []),
		...(summary.failed > 0 ? [`  ${summary.failed} failed`] : []),
		...(summary.cancelled > 0 ? [`  ${summary.cancelled} cancelled`] : []),
		...(summary.unknown > 0 ? [`  ${summary.unknown} unknown`] : []),
	];
	return lines.join("\n");
}

/**
 * Format all stored Hatchet runs for status display.
 */
export function listHatchetRuns(cwd: string): string[] {
	const registry = loadHatchetRunRegistry(cwd);
	return registry.runs.map((r) => `[${r.status}] ${r.flowType} — ${r.aim} — ${r.id}`);
}

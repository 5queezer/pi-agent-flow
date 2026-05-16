/**
 * Durable Hatchet run registry.
 *
 * Persists Hatchet flow run metadata in `.pi/hatchet-runs.json`.
 * Does NOT store: forkSessionSnapshotJsonl, full HatchetFlowPayload, or secrets.
 * File is written atomically with 0600 permissions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { SingleResult } from "./types/flow.js";

export type HatchetRunStatus =
	| "submitting"
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "unknown";

export interface HatchetRunRecord {
	id: string;
	hatchetRunId?: string;
	clientRunId: string;
	status: HatchetRunStatus;
	cwd: string;
	sessionId?: string;
	goalId?: string;
	toolCallId?: string;
	flowType: string;
	intent: string;
	aim: string;
	paramIndex: number;
	attemptIndex: number;
	payloadHash: string;
	result?: SingleResult;
	errorMessage?: string;
	goalRecordedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface HatchetRunRegistry {
	version: 1;
	runs: HatchetRunRecord[];
}

export interface CreateHatchetRunRecordInput {
	cwd: string;
	sessionId?: string;
	goalId?: string;
	toolCallId?: string;
	flowType: string;
	intent: string;
	aim: string;
	paramIndex: number;
	attemptIndex: number;
	payloadHash: string;
}

const ACTIVE_STATUSES: HatchetRunStatus[] = ["submitting", "queued", "running"];
const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const MAX_STORED_TEXT_LENGTH = 8_000;

export function getHatchetRunRegistryPath(cwd: string): string {
	return path.join(cwd, ".pi", "hatchet-runs.json");
}

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getLockPath(cwd: string): string {
	return path.join(cwd, ".pi", ".hatchet-runs.lock");
}

function withRegistryLock<T>(cwd: string, fn: () => T): T {
	const dir = path.dirname(getHatchetRunRegistryPath(cwd));
	ensureDir(dir);
	const lockPath = getLockPath(cwd);
	const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;

	while (true) {
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			break;
		} catch (error) {
			if (!fs.existsSync(lockPath)) continue;
			try {
				const stat = fs.statSync(lockPath);
				if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
					fs.rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error("Timed out waiting for Hatchet run registry lock.");
			}
			sleepSync(20);
		}
	}

	try {
		return fn();
	} finally {
		try {
			fs.rmdirSync(lockPath);
		} catch {
			// best-effort cleanup
		}
	}
}

function loadHatchetRunRegistryUnlocked(cwd: string): HatchetRunRegistry {
	const filePath = getHatchetRunRegistryPath(cwd);
	if (!fs.existsSync(filePath)) {
		return { version: 1, runs: [] };
	}
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as HatchetRunRegistry;
		if (!parsed || typeof parsed !== "object") return { version: 1, runs: [] };
		if (!Array.isArray(parsed.runs)) parsed.runs = [];
		return { version: 1, runs: parsed.runs };
	} catch {
		// Corrupt file — preserve it and return empty registry.
		try {
			const corruptPath = `${filePath}.corrupt.${Date.now()}`;
			fs.renameSync(filePath, corruptPath);
		} catch {
			// best-effort
		}
		return { version: 1, runs: [] };
	}
}

export function loadHatchetRunRegistry(cwd: string): HatchetRunRegistry {
	return loadHatchetRunRegistryUnlocked(cwd);
}

function saveHatchetRunRegistryUnlocked(cwd: string, registry: HatchetRunRegistry): void {
	const filePath = getHatchetRunRegistryPath(cwd);
	const dir = path.dirname(filePath);
	ensureDir(dir);
	const tmpPath = path.join(dir, `.tmp-hatchet-runs.json.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`);
	fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
	// Ensure permissions on the target file (rename may not preserve on some systems).
	try {
		fs.chmodSync(filePath, 0o600);
	} catch {
		// best-effort
	}
}

export function saveHatchetRunRegistry(cwd: string, registry: HatchetRunRegistry): void {
	withRegistryLock(cwd, () => saveHatchetRunRegistryUnlocked(cwd, registry));
}

export function sanitizeHatchetText(value: string | undefined, fallback = ""): string {
	const text = value ?? fallback;
	return text
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/\b(?:sk|pk|pat|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_\-]{12,}\b/g, "[redacted]")
		.slice(0, MAX_STORED_TEXT_LENGTH);
}

export function sanitizeHatchetStoredResult(result: SingleResult): SingleResult {
	return {
		...result,
		messages: [],
		stderr: sanitizeHatchetText(result.stderr),
		errorMessage: result.errorMessage ? sanitizeHatchetText(result.errorMessage) : undefined,
	};
}

export function createHatchetRunRecord(input: CreateHatchetRunRecordInput): HatchetRunRecord {
	const now = new Date().toISOString();
	const id = `hrun-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
	const clientRunId = `crun-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
	return {
		id,
		clientRunId,
		status: "submitting",
		cwd: input.cwd,
		sessionId: input.sessionId,
		goalId: input.goalId,
		toolCallId: input.toolCallId,
		flowType: input.flowType,
		intent: input.intent,
		aim: input.aim,
		paramIndex: input.paramIndex,
		attemptIndex: input.attemptIndex,
		payloadHash: input.payloadHash,
		createdAt: now,
		updatedAt: now,
	};
}

export function appendHatchetRunRecord(cwd: string, record: HatchetRunRecord): HatchetRunRecord {
	return withRegistryLock(cwd, () => {
		const registry = loadHatchetRunRegistryUnlocked(cwd);
		registry.runs.push(record);
		saveHatchetRunRegistryUnlocked(cwd, registry);
		return record;
	});
}

function updateRecord(cwd: string, id: string, updater: (record: HatchetRunRecord) => void): HatchetRunRecord | undefined {
	return withRegistryLock(cwd, () => {
		const registry = loadHatchetRunRegistryUnlocked(cwd);
		const record = registry.runs.find((r) => r.id === id);
		if (!record) return undefined;
		updater(record);
		record.updatedAt = new Date().toISOString();
		saveHatchetRunRegistryUnlocked(cwd, registry);
		return record;
	});
}

export function markHatchetRunSubmitted(
	cwd: string,
	id: string,
	update: { hatchetRunId: string; status: "queued" | "running" },
): HatchetRunRecord | undefined {
	return updateRecord(cwd, id, (record) => {
		record.hatchetRunId = update.hatchetRunId;
		record.status = update.status;
	});
}

export function updateHatchetRunResult(cwd: string, id: string, result: SingleResult): HatchetRunRecord | undefined {
	return updateRecord(cwd, id, (record) => {
		record.status = "completed";
		record.result = sanitizeHatchetStoredResult(result);
	});
}

export function updateHatchetRunFailure(
	cwd: string,
	id: string,
	status: "failed" | "cancelled" | "unknown",
	errorMessage: string,
): HatchetRunRecord | undefined {
	return updateRecord(cwd, id, (record) => {
		record.status = status;
		record.errorMessage = sanitizeHatchetText(errorMessage, "No details");
	});
}

export function markHatchetGoalRecorded(cwd: string, id: string): HatchetRunRecord | undefined {
	return updateRecord(cwd, id, (record) => {
		record.goalRecordedAt = new Date().toISOString();
	});
}

export function listActiveHatchetRuns(cwd: string): HatchetRunRecord[] {
	const registry = loadHatchetRunRegistry(cwd);
	return registry.runs.filter(
		(r) => ACTIVE_STATUSES.includes(r.status) || (r.status === "completed" && Boolean(r.goalId) && !r.goalRecordedAt),
	);
}

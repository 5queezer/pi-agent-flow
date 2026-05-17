import * as crypto from "node:crypto";
import type { RunFlowOptions } from "./core/flow.js";
import type { FlowRunContext, FlowRunner } from "./flow-runner.js";
import { isRecord, validateSingleResult } from "./durable-flow-payload.js";
import {
	HATCHET_FLOW_TASK_NAME,
	deserializeHatchetFlowPayload,
	resolveHatchetSpawnCommand,
	serializeHatchetFlowPayload,
	validateHatchetFlowPayloadSize,
	validateHatchetWorkerPayload,
	type HatchetFlowPayload,
} from "./hatchet-payload.js";
import { emptyFlowUsage, type FlowDetails, type SingleResult } from "./types/flow.js";
import { SubmitterAdapter, type HatchetRunAdapter, type HatchetRunHandle } from "./hatchet-run-adapter.js";
import {
	createHatchetRunRecord,
	appendHatchetRunRecord,
	markHatchetRunSubmitted,
	updateHatchetRunResult,
	updateHatchetRunFailure,
} from "./hatchet-run-registry.js";
export {
	DEFAULT_DURABLE_MAX_PAYLOAD_BYTES,
	DURABLE_FLOW_TASK_NAME,
	PI_FLOW_DURABLE_MAX_PAYLOAD_BYTES_ENV,
	deserializeDurableFlowPayload,
	resolveDurableMaxPayloadBytes,
	resolveDurableSpawnCommand,
	serializeDurableFlowPayload,
	validateDurableFlowPayloadSize,
	validateDurableWorkerPayload,
} from "./durable-flow-payload.js";
export type { DurableFlowPayload } from "./durable-flow-payload.js";
export {
	DEFAULT_HATCHET_MAX_PAYLOAD_BYTES,
	HATCHET_FLOW_TASK_NAME,
	PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV,
	deserializeHatchetFlowPayload,
	resolveHatchetMaxPayloadBytes,
	resolveHatchetSpawnCommand,
	serializeHatchetFlowPayload,
	validateHatchetFlowPayloadSize,
	validateHatchetWorkerPayload,
} from "./hatchet-payload.js";
export type { HatchetFlowPayload } from "./hatchet-payload.js";
export const PI_FLOW_HATCHET_RESULT_TIMEOUT_MS_ENV = "PI_FLOW_HATCHET_RESULT_TIMEOUT_MS";
export const DEFAULT_HATCHET_RESULT_TIMEOUT_MS = 600_000;
export const DEFAULT_HATCHET_TASK_EXECUTION_TIMEOUT_MS = 3_600_000;
export const HATCHET_CLIENT_TLS_STRATEGY_ENV = "HATCHET_CLIENT_TLS_STRATEGY";
export const HATCHET_CLIENT_LOCAL_TLS_STRATEGY = "none";
export interface HatchetTaskContext {
	abortController: AbortController;
	cancelled: boolean;
	rethrowIfCancelled(err: unknown): void;
}
export interface HatchetTaskDeclaration {
	run(input: unknown): Promise<unknown>;
	runNoWait?(input: unknown, options?: unknown): Promise<HatchetWorkflowRunRef>;
}
export interface HatchetTaskClient {
	task<I, O>(options: {
		name: string;
		retries?: number;
		executionTimeout?: string;
		scheduleTimeout?: string;
		fn: (input: I, ctx?: HatchetTaskContext) => Promise<O> | O;
	}): HatchetTaskDeclaration;
}
interface HatchetSdkModule {
	[key: string]: unknown;
}
interface HatchetWorkflowRunRef {
	runId?: string | Promise<string>;
	getWorkflowRunId?: () => Promise<string>;
	result?: () => Promise<unknown>;
	output?: Promise<unknown>;
	cancel?: () => Promise<void>;
}
type HatchetSubmitter = (taskName: string, payload: HatchetFlowPayload) => Promise<SingleResult>;
function makeFlowDetails(projectFlowsDir: string | null): (results: SingleResult[]) => FlowDetails {
	return (results) => ({
		mode: "flow",
		flowStyle: "fork",
		projectAgentsDir: projectFlowsDir,
		results,
	});
}
export { validateSingleResult } from "./durable-flow-payload.js";

export function resolveHatchetResultTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[PI_FLOW_HATCHET_RESULT_TIMEOUT_MS_ENV]?.trim();
	if (!raw) return DEFAULT_HATCHET_RESULT_TIMEOUT_MS;
	if (!/^\d+$/.test(raw)) {
		throw new Error(`${PI_FLOW_HATCHET_RESULT_TIMEOUT_MS_ENV} must be a positive integer millisecond timeout.`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${PI_FLOW_HATCHET_RESULT_TIMEOUT_MS_ENV} must be a positive integer millisecond timeout.`);
	}
	return value;
}
export function resolveHatchetTaskExecutionTimeoutMs(): number {
	return DEFAULT_HATCHET_TASK_EXECUTION_TIMEOUT_MS;
}
function formatHatchetTimeout(ms: number): string {
	return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}
class HatchetResultTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(
			`Hatchet did not return a result for ${HATCHET_FLOW_TASK_NAME} within ${timeoutMs}ms. Check Hatchet connectivity and ensure a worker is registered for ${HATCHET_FLOW_TASK_NAME}. Adjust ${PI_FLOW_HATCHET_RESULT_TIMEOUT_MS_ENV} if longer waits are expected.`,
		);
		this.name = "HatchetResultTimeoutError";
	}
}

async function awaitHatchetResult<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new HatchetResultTimeoutError(timeoutMs)), timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
function parseHatchetHost(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.includes("://")) {
		if (trimmed.startsWith("[")) {
			const end = trimmed.indexOf("]");
			return end > 1 ? trimmed.slice(1, end) : null;
		}
		const match = /^(?<host>[^:]+)(?::\d+)?$/.exec(trimmed);
		return match?.groups?.host ?? null;
	}
	try {
		return new URL(trimmed).hostname || null;
	} catch {
		return null;
	}
}
export function applyLocalHatchetTlsStrategyDefault(env: NodeJS.ProcessEnv = process.env): void {
	if (env[HATCHET_CLIENT_TLS_STRATEGY_ENV]?.trim()) return;
	const host = parseHatchetHost(env.HATCHET_CLIENT_HOST_PORT) ?? parseHatchetHost(env.HATCHET_CLIENT_API_URL);
	if (host === "127.0.0.1") env[HATCHET_CLIENT_TLS_STRATEGY_ENV] = HATCHET_CLIENT_LOCAL_TLS_STRATEGY;
}
function getProperty(obj: unknown, key: string): unknown {
	return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}
function asFunction<T extends (...args: any[]) => any>(value: unknown): T | undefined {
	return typeof value === "function" ? (value as T) : undefined;
}
async function createHatchetClient(factory: (...args: unknown[]) => Promise<unknown>): Promise<unknown> {
	try {
		return new (factory as unknown as { new(): unknown })();
	} catch {
		return await factory();
	}
}
export function createHatchetFlowTaskDeclaration(client: HatchetTaskClient): HatchetTaskDeclaration {
	const taskTimeout = formatHatchetTimeout(resolveHatchetTaskExecutionTimeoutMs());
	return client.task<HatchetFlowPayload, SingleResult>({
		name: HATCHET_FLOW_TASK_NAME,
		retries: 0,
		executionTimeout: taskTimeout,
		scheduleTimeout: taskTimeout,
		fn: (input) => runHatchetFlowTask(input),
	});
}
export async function submitHatchetTaskWithClient(
	client: HatchetTaskClient,
	payload: HatchetFlowPayload,
): Promise<SingleResult> {
	const declaration = createHatchetFlowTaskDeclaration(client);
	return validateSingleResult(await declaration.run(payload), `Hatchet task ${HATCHET_FLOW_TASK_NAME}`);
}
async function loadHatchetSdk(): Promise<HatchetSdkModule> {
	try {
		return await import("@hatchet-dev/typescript-sdk/v1/index.js");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`PI_FLOW_RUNNER=hatchet requires optional package @hatchet-dev/typescript-sdk. Install and configure Hatchet before using this backend. (${message})`,
		);
	}
}
export async function submitHatchetTaskWithSdk(
	sdk: HatchetSdkModule,
	taskName: string,
	payload: HatchetFlowPayload,
): Promise<SingleResult> {
	const clientFactory =
		asFunction(getProperty(sdk, "HatchetClient")) ??
		asFunction(getProperty(sdk, "Hatchet")) ??
		asFunction(getProperty(sdk, "default"));
	const client = clientFactory ? await createHatchetClient(clientFactory) : (getProperty(sdk, "hatchet") ?? sdk);
	if (typeof getProperty(client, "task") === "function" && taskName === HATCHET_FLOW_TASK_NAME) {
		return submitHatchetTaskWithClient(client as HatchetTaskClient, payload);
	}
	const directRun = asFunction<(taskName: string, payload: HatchetFlowPayload) => Promise<unknown>>(
		getProperty(client, "run"),
	);
	if (directRun) return validateSingleResult(await directRun(taskName, payload), "Hatchet SDK result");
	const workflows = getProperty(client, "workflows") ?? getProperty(client, "workflow");
	const workflowRun = asFunction<(taskName: string, payload: HatchetFlowPayload) => Promise<unknown>>(
		getProperty(workflows, "run"),
	);
	if (workflowRun) return validateSingleResult(await workflowRun(taskName, payload), "Hatchet SDK result");
	const tasks = getProperty(client, "tasks") ?? getProperty(client, "task");
	const taskRun =
		asFunction<(taskName: string, payload: HatchetFlowPayload) => Promise<unknown>>(getProperty(tasks, "run")) ??
		asFunction<(taskName: string, payload: HatchetFlowPayload) => Promise<unknown>>(getProperty(tasks, "execute"));
	if (taskRun) return validateSingleResult(await taskRun(taskName, payload), "Hatchet SDK result");
	throw new Error(
		"Hatchet SDK loaded, but no supported task submission method was found. Expected client.run, client.workflows.run, or client.tasks.run.",
	);
}
async function defaultSubmitHatchetTask(taskName: string, payload: HatchetFlowPayload): Promise<SingleResult> {
	return await submitHatchetTaskWithSdk(await loadHatchetSdk(), taskName, payload);
}

async function resolveHatchetClientFromSdk(sdk: HatchetSdkModule): Promise<unknown> {
	const clientFactory =
		asFunction(getProperty(sdk, "HatchetClient")) ??
		asFunction(getProperty(sdk, "Hatchet")) ??
		asFunction(getProperty(sdk, "default"));
	return clientFactory ? await createHatchetClient(clientFactory) : (getProperty(sdk, "hatchet") ?? sdk);
}

async function getWorkflowRunId(ref: HatchetWorkflowRunRef): Promise<string> {
	if (typeof ref.getWorkflowRunId === "function") return await ref.getWorkflowRunId();
	const runId = await ref.runId;
	if (typeof runId === "string" && runId.trim()) return runId;
	throw new Error("Hatchet run reference did not expose a workflow run ID.");
}

async function getWorkflowRunOutput(ref: HatchetWorkflowRunRef): Promise<unknown> {
	if (typeof ref.result === "function") return await ref.result();
	if (ref.output) return await ref.output;
	throw new Error("Hatchet run reference did not expose a result/output reader.");
}

function validateHatchetRunOutput(value: unknown): SingleResult {
	try {
		return validateSingleResult(value, "Hatchet run result");
	} catch (originalError) {
		if (isRecord(value) && value[HATCHET_FLOW_TASK_NAME] !== undefined) {
			return validateSingleResult(value[HATCHET_FLOW_TASK_NAME], `Hatchet run result ${HATCHET_FLOW_TASK_NAME}`);
		}
		throw originalError;
	}
}

type HatchetRemoteRunStatus = import("./hatchet-run-adapter.js").HatchetRemoteRunStatus;

async function getPersistedRunStatus(client: unknown, runId: string): Promise<HatchetRemoteRunStatus | undefined> {
	const runs = getProperty(client, "runs");
	const getRun = asFunction<(id: string) => Promise<unknown>>(getProperty(runs, "get"));
	if (!runs || !getRun) return undefined;
	const run = await getRun.call(runs, runId);
	const tasks = isRecord(run) && Array.isArray(run.tasks) ? run.tasks : [];
	const task = tasks.find((entry) => isRecord(entry) && (entry.taskExternalId === runId || entry.workflowRunExternalId === runId)) ?? tasks[0];
	if (!isRecord(task)) return undefined;
	const rawStatus = typeof task.status === "string" ? task.status.toLowerCase() : "";
	if (rawStatus === "completed") return { status: "completed", result: validateHatchetRunOutput(task.output) };
	if (rawStatus === "failed") return { status: "failed", errorMessage: typeof task.errorMessage === "string" ? task.errorMessage : "Hatchet run failed" };
	if (rawStatus === "cancelled" || rawStatus === "canceled") return { status: "cancelled", errorMessage: typeof task.errorMessage === "string" ? task.errorMessage : "Hatchet run cancelled" };
	if (rawStatus === "queued" || rawStatus === "pending") return { status: "queued" };
	if (rawStatus === "running" || rawStatus === "started") return { status: "running" };
	return undefined;
}

function makeRunOptions(clientRunId: string | undefined): Record<string, unknown> | undefined {
	return clientRunId ? { additionalMetadata: { clientRunId } } : undefined;
}

function isWorkflowRunRef(value: unknown): value is HatchetWorkflowRunRef {
	return Boolean(value) && typeof value === "object";
}

export class SdkHatchetRunAdapter implements HatchetRunAdapter {
	private clientPromise: Promise<unknown> | undefined;
	private readonly refs = new Map<string, HatchetWorkflowRunRef>();

	constructor(private readonly sdkLoader: () => Promise<HatchetSdkModule> = loadHatchetSdk) {}

	private async getClient(): Promise<unknown> {
		this.clientPromise ??= this.sdkLoader().then(resolveHatchetClientFromSdk);
		return await this.clientPromise;
	}

	async submit(taskName: string, payload: HatchetFlowPayload, options?: { clientRunId?: string }): Promise<HatchetRunHandle> {
		const client = await this.getClient();
		const runOptions = makeRunOptions(options?.clientRunId);
		let ref: unknown;

		if (typeof getProperty(client, "task") === "function" && taskName === HATCHET_FLOW_TASK_NAME) {
			const declaration = createHatchetFlowTaskDeclaration(client as HatchetTaskClient);
			if (typeof declaration.runNoWait === "function") {
				ref = await declaration.runNoWait(payload, runOptions);
			}
		}

		if (!ref) {
			const directRunNoWait = asFunction<(taskName: string, payload: HatchetFlowPayload, options?: unknown) => Promise<unknown>>(
				getProperty(client, "runNoWait"),
			);
			if (directRunNoWait) ref = await directRunNoWait.call(client, taskName, payload, runOptions);
		}

		if (!ref) {
			const tasks = getProperty(client, "tasks") ?? getProperty(client, "task");
			const taskRunNoWait = asFunction<(taskName: string, payload: HatchetFlowPayload, options?: unknown) => Promise<unknown>>(
				getProperty(tasks, "runNoWait"),
			);
			if (taskRunNoWait) ref = await taskRunNoWait.call(tasks, taskName, payload, runOptions);
		}

		if (!isWorkflowRunRef(ref)) {
			throw new Error("Hatchet SDK loaded, but no supported non-blocking runNoWait method was found.");
		}

		const runId = await getWorkflowRunId(ref);
		this.refs.set(runId, ref);
		return { runId, durable: true };
	}

	async getResult(handle: HatchetRunHandle): Promise<import("./hatchet-run-adapter.js").HatchetRemoteRunStatus> {
		try {
			let ref = this.refs.get(handle.runId);
			if (!ref) {
				const client = await this.getClient();
				const persistedStatus = await getPersistedRunStatus(client, handle.runId);
				if (persistedStatus) return persistedStatus;
				const runRef = asFunction<(id: string) => HatchetWorkflowRunRef>(getProperty(client, "runRef"));
				if (!runRef) return { status: "unknown", errorMessage: "Hatchet SDK client does not support runRef(id)." };
				ref = runRef.call(client, handle.runId);
				this.refs.set(handle.runId, ref);
			}
			const result = validateHatchetRunOutput(await getWorkflowRunOutput(ref));
			this.refs.delete(handle.runId);
			return { status: "completed", result };
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			return { status: "unknown", errorMessage };
		}
	}

	async cancel(handle: HatchetRunHandle): Promise<void> {
		let ref = this.refs.get(handle.runId);
		if (!ref) {
			const client = await this.getClient();
			const runRef = asFunction<(id: string) => HatchetWorkflowRunRef>(getProperty(client, "runRef"));
			if (!runRef) throw new Error("Hatchet SDK client does not support runRef(id).");
			ref = runRef.call(client, handle.runId);
			this.refs.set(handle.runId, ref);
		}
		if (typeof ref.cancel !== "function") throw new Error("Hatchet run reference does not support cancellation.");
		await ref.cancel();
	}
}

export async function main(options: RunFlowOptions): Promise<SingleResult> {
	const runner = new HatchetFlowRunner();
	return await runner.run(options);
}

/**
 * Returns a HatchetRunAdapter if PI_FLOW_RUNNER=hatchet is configured, otherwise undefined.
 * The returned adapter uses SDK run references so persisted run IDs can be
 * re-opened after the Pi process restarts.
 */
export function createHatchetAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): import("./hatchet-run-adapter.js").HatchetRunAdapter | undefined {
	const requested = env["PI_FLOW_RUNNER"]?.trim().toLowerCase();
	if (requested !== "hatchet") return undefined;
	return new SdkHatchetRunAdapter();
}
function makeHatchetLifecycleResult(
	options: RunFlowOptions,
	status: string,
	errorMessage?: string,
): SingleResult {
	return {
		type: options.flowName.toLowerCase(),
		agentSource: "unknown",
		intent: options.intent,
		aim: options.aim,
		acceptance: options.acceptance,
		exitCode: -1,
		messages: [],
		stderr: `Hatchet flow ${status}.`,
		usage: emptyFlowUsage(),
		model: options.model,
		startedAtMs: Date.now(),
		errorMessage,
	};
}
function makeHatchetFailureLifecycleResult(options: RunFlowOptions): SingleResult {
	return makeHatchetLifecycleResult(options, "failed", "Hatchet submission failed.");
}
function emitHatchetLifecycleUpdate(
	options: RunFlowOptions,
	projectFlowsDir: string | null,
	text: string,
	result: SingleResult,
): void {
	options.onUpdate?.({ content: [{ type: "text", text }], details: makeFlowDetails(projectFlowsDir)([result]) });
}
export interface HatchetFlowRunnerOptions {
	adapter: HatchetRunAdapter;
	/**
	 * When true, fail before submitting to Hatchet if the local durable registry
	 * cannot be written. The default SDK-backed runner enables this because a
	 * submitted remote run without a local record cannot be recovered after Pi exits.
	 */
	requireRegistry?: boolean;
}

export class HatchetFlowRunner implements FlowRunner {
	private readonly adapter: HatchetRunAdapter;
	private readonly requireRegistry: boolean;

	constructor(submitterOrOptions?: HatchetSubmitter | HatchetFlowRunnerOptions) {
		if (!submitterOrOptions) {
			// Default: use durable SDK run references, not an in-memory synthetic handle.
			this.adapter = new SdkHatchetRunAdapter();
			this.requireRegistry = true;
		} else if (typeof submitterOrOptions === "function") {
			// Backward-compat: accept a plain submitter function
			this.adapter = new SubmitterAdapter(submitterOrOptions);
			this.requireRegistry = false;
		} else {
			// New: accept a full adapter options object
			this.adapter = submitterOrOptions.adapter;
			this.requireRegistry = submitterOrOptions.requireRegistry ?? false;
		}
	}

	async run(options: RunFlowOptions, context?: FlowRunContext): Promise<SingleResult> {
		const projectFlowsDir = context?.projectFlowsDir ?? null;
		const payload = serializeHatchetFlowPayload(options, projectFlowsDir);
		validateHatchetFlowPayloadSize(payload);
		const timeoutMs = resolveHatchetResultTimeoutMs();
		emitHatchetLifecycleUpdate(
			options,
			projectFlowsDir,
			`Hatchet queued/running flow ${payload.flowName}.`,
			makeHatchetLifecycleResult(options, "queued/running"),
		);

		// Compute payload hash (without snapshot or secrets)
		const payloadHash = "sha256:" + crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);

		// Create and persist registry record before submission (best-effort; never throws)
		const record = createHatchetRunRecord({
			cwd: options.cwd,
			sessionId: context?.sessionId,
			goalId: context?.goalId,
			toolCallId: context?.toolCallId,
			flowType: payload.flowName,
			intent: options.intent,
			aim: options.aim,
			paramIndex: context?.paramIndex ?? 0,
			attemptIndex: context?.attemptIndex ?? 0,
			payloadHash,
		});
		let registryEnabled = false;
		let registryError: Error | undefined;
		try {
			appendHatchetRunRecord(options.cwd, record);
			registryEnabled = true;
		} catch (error) {
			registryError = error instanceof Error ? error : new Error(String(error));
		}

		let failureEmitted = false;
		const emitFailure = () => {
			if (failureEmitted) return;
			failureEmitted = true;
			emitHatchetLifecycleUpdate(
				options,
				projectFlowsDir,
				`Hatchet failed flow ${payload.flowName}.`,
				makeHatchetFailureLifecycleResult(options),
			);
		};
		const registryUpdate = (fn: () => void) => { if (registryEnabled) { try { fn(); } catch { /* best-effort */ } } };
		if (registryError && this.requireRegistry) {
			emitFailure();
			throw new Error(`Hatchet durable registry unavailable; remote run was not submitted: ${registryError.message}`);
		}

		try {
			const handle = await this.adapter.submit(HATCHET_FLOW_TASK_NAME, payload, { clientRunId: record.clientRunId });
			// Persist the remote handle immediately after submission.
			registryUpdate(() => markHatchetRunSubmitted(options.cwd, record.id, { hatchetRunId: handle.runId, status: "running" }));

			const remoteStatus = await awaitHatchetResult(
				this.adapter.getResult(handle),
				timeoutMs,
			);
			if (remoteStatus.status === "completed") {
				const result = validateSingleResult(remoteStatus.result, "Hatchet runner result");
				registryUpdate(() => updateHatchetRunResult(options.cwd, record.id, result));
				emitHatchetLifecycleUpdate(options, projectFlowsDir, `Hatchet completed flow ${payload.flowName}.`, result);
				return result;
			}
			// failed, cancelled, or unknown
			const errMsg =
				remoteStatus.status === "failed" || remoteStatus.status === "cancelled"
					? remoteStatus.errorMessage
					: (remoteStatus.errorMessage ?? `Hatchet flow returned status: ${remoteStatus.status}`);
			registryUpdate(() => updateHatchetRunFailure(
				options.cwd,
				record.id,
				remoteStatus.status === "cancelled" ? "cancelled" : remoteStatus.status === "unknown" ? "unknown" : "failed",
				errMsg,
			));
			emitFailure();
			throw new Error(errMsg);
		} catch (error) {
			if (error instanceof HatchetResultTimeoutError) {
				// The remote run may still be queued/running. Keep the registry active so
				// restart reconciliation can recover the eventual result.
				emitFailure();
				throw error;
			}
			// Record a generic failure for unexpected errors.
			registryUpdate(() => updateHatchetRunFailure(options.cwd, record.id, "failed", error instanceof Error ? error.message : String(error)));
			emitFailure();
			throw error;
		}
	}
}
export async function runHatchetFlowTask(payload: HatchetFlowPayload): Promise<SingleResult> {
	const originalRunner = process.env.PI_FLOW_RUNNER;
	const originalSpawn = process.env.PI_FLOW_SPAWN_COMMAND;
	process.env.PI_FLOW_RUNNER = "local";
	process.env.PI_FLOW_SPAWN_COMMAND = resolveHatchetSpawnCommand(process.env);
	try {
		validateHatchetWorkerPayload(payload);
		const { runFlow } = await import("./core/flow.js");
		return validateSingleResult(await runFlow(deserializeHatchetFlowPayload(payload)), "Hatchet worker result");
	} finally {
		if (originalRunner === undefined) delete process.env.PI_FLOW_RUNNER;
		else process.env.PI_FLOW_RUNNER = originalRunner;
		if (originalSpawn === undefined) delete process.env.PI_FLOW_SPAWN_COMMAND;
		else process.env.PI_FLOW_SPAWN_COMMAND = originalSpawn;
	}
}

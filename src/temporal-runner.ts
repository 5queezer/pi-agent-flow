import * as crypto from "node:crypto";
import type { RunFlowOptions } from "./core/flow.js";
import type { FlowRunContext, FlowRunner } from "./flow-runner.js";
import {
	serializeHatchetFlowPayload,
	validateHatchetFlowPayloadSize,
	type HatchetFlowPayload,
} from "./hatchet-payload.js";
import { validateSingleResult } from "./hatchet-runner.js";
import { emptyFlowUsage, type FlowDetails, type SingleResult } from "./types/flow.js";

export const TEMPORAL_FLOW_WORKFLOW_TYPE = "runPiFlowWorkflow";
export const PI_FLOW_TEMPORAL_ADDRESS_ENV = "PI_FLOW_TEMPORAL_ADDRESS";
export const PI_FLOW_TEMPORAL_NAMESPACE_ENV = "PI_FLOW_TEMPORAL_NAMESPACE";
export const PI_FLOW_TEMPORAL_TASK_QUEUE_ENV = "PI_FLOW_TEMPORAL_TASK_QUEUE";
export const PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS_ENV = "PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS";
export const DEFAULT_TEMPORAL_ADDRESS = "localhost:7233";
export const DEFAULT_TEMPORAL_NAMESPACE = "default";
export const DEFAULT_TEMPORAL_TASK_QUEUE = "pi-agent-flow";
export const DEFAULT_TEMPORAL_RESULT_TIMEOUT_MS = 600_000;

export interface TemporalWorkflowExecutionOptions {
	address: string;
	namespace: string;
	taskQueue: string;
	workflowId: string;
}

type TemporalWorkflowExecutor = (
	workflowType: string,
	payload: HatchetFlowPayload,
	options: TemporalWorkflowExecutionOptions,
) => Promise<unknown>;

interface TemporalClientSdkModule {
	Connection: {
		connect(options: { address: string }): Promise<unknown>;
	};
	Client: new (options: { connection: unknown; namespace: string }) => {
		workflow: {
			execute(workflowType: string, options: { taskQueue: string; workflowId: string; args: [HatchetFlowPayload] }): Promise<unknown>;
		};
	};
}

function makeFlowDetails(projectFlowsDir: string | null): (results: SingleResult[]) => FlowDetails {
	return (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: projectFlowsDir, results });
}

export function resolveTemporalAddress(env: NodeJS.ProcessEnv = process.env): string {
	return env[PI_FLOW_TEMPORAL_ADDRESS_ENV]?.trim() || DEFAULT_TEMPORAL_ADDRESS;
}

export function resolveTemporalNamespace(env: NodeJS.ProcessEnv = process.env): string {
	return env[PI_FLOW_TEMPORAL_NAMESPACE_ENV]?.trim() || DEFAULT_TEMPORAL_NAMESPACE;
}

export function resolveTemporalTaskQueue(env: NodeJS.ProcessEnv = process.env): string {
	return env[PI_FLOW_TEMPORAL_TASK_QUEUE_ENV]?.trim() || DEFAULT_TEMPORAL_TASK_QUEUE;
}

export function resolveTemporalResultTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS_ENV]?.trim();
	if (!raw) return DEFAULT_TEMPORAL_RESULT_TIMEOUT_MS;
	if (!/^\d+$/.test(raw)) {
		throw new Error(`${PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS_ENV} must be a positive integer millisecond timeout.`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS_ENV} must be a positive integer millisecond timeout.`);
	}
	return value;
}

class TemporalResultTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(
			`Temporal did not return a result for ${TEMPORAL_FLOW_WORKFLOW_TYPE} within ${timeoutMs}ms. Check Temporal connectivity and ensure a worker is polling ${resolveTemporalTaskQueue()}. Adjust ${PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS_ENV} if longer waits are expected.`,
		);
		this.name = "TemporalResultTimeoutError";
	}
}

async function awaitTemporalResult<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new TemporalResultTimeoutError(timeoutMs)), timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function loadTemporalClientSdk(): Promise<TemporalClientSdkModule> {
	try {
		return await import("@temporalio/client") as TemporalClientSdkModule;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`PI_FLOW_RUNNER=temporal requires optional package @temporalio/client. Install and configure Temporal before using this backend. (${message})`,
		);
	}
}

async function defaultExecuteTemporalWorkflow(
	workflowType: string,
	payload: HatchetFlowPayload,
	options: TemporalWorkflowExecutionOptions,
): Promise<unknown> {
	const { Connection, Client } = await loadTemporalClientSdk();
	const connection = await Connection.connect({ address: options.address });
	const client = new Client({ connection, namespace: options.namespace });
	return await client.workflow.execute(workflowType, {
		taskQueue: options.taskQueue,
		workflowId: options.workflowId,
		args: [payload],
	});
}

function makeTemporalWorkflowId(flowName: string): string {
	return `pi-agent-flow-${flowName.toLowerCase()}-${Date.now()}-${crypto.randomUUID()}`;
}

function makeTemporalLifecycleResult(
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
		stderr: `Temporal flow ${status}.`,
		usage: emptyFlowUsage(),
		model: options.model,
		startedAtMs: Date.now(),
		errorMessage,
	};
}

function makeTemporalFailureLifecycleResult(options: RunFlowOptions): SingleResult {
	return makeTemporalLifecycleResult(options, "failed", "Temporal submission failed.");
}

function emitTemporalLifecycleUpdate(
	options: RunFlowOptions,
	projectFlowsDir: string | null,
	text: string,
	result: SingleResult,
): void {
	options.onUpdate?.({ content: [{ type: "text", text }], details: makeFlowDetails(projectFlowsDir)([result]) });
}

export class TemporalFlowRunner implements FlowRunner {
	constructor(private readonly executeWorkflow: TemporalWorkflowExecutor = defaultExecuteTemporalWorkflow) {}

	async run(options: RunFlowOptions, context?: FlowRunContext): Promise<SingleResult> {
		const projectFlowsDir = context?.projectFlowsDir ?? null;
		const payload = serializeHatchetFlowPayload(options, projectFlowsDir);
		validateHatchetFlowPayloadSize(payload);
		const timeoutMs = resolveTemporalResultTimeoutMs();
		const executionOptions: TemporalWorkflowExecutionOptions = {
			address: resolveTemporalAddress(),
			namespace: resolveTemporalNamespace(),
			taskQueue: resolveTemporalTaskQueue(),
			workflowId: makeTemporalWorkflowId(payload.flowName),
		};

		emitTemporalLifecycleUpdate(
			options,
			projectFlowsDir,
			`Temporal queued/running flow ${payload.flowName}.`,
			makeTemporalLifecycleResult(options, "queued/running"),
		);

		try {
			const result = validateSingleResult(
				await awaitTemporalResult(
					this.executeWorkflow(TEMPORAL_FLOW_WORKFLOW_TYPE, payload, executionOptions),
					timeoutMs,
				),
				"Temporal workflow result",
			);
			emitTemporalLifecycleUpdate(options, projectFlowsDir, `Temporal completed flow ${payload.flowName}.`, result);
			return result;
		} catch (error) {
			emitTemporalLifecycleUpdate(
				options,
				projectFlowsDir,
				`Temporal failed flow ${payload.flowName}.`,
				makeTemporalFailureLifecycleResult(options),
			);
			throw error;
		}
	}
}

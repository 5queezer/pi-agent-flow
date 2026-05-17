#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	DEFAULT_TEMPORAL_ADDRESS,
	DEFAULT_TEMPORAL_NAMESPACE,
	DEFAULT_TEMPORAL_TASK_QUEUE,
	PI_FLOW_TEMPORAL_ADDRESS_ENV,
	PI_FLOW_TEMPORAL_NAMESPACE_ENV,
	PI_FLOW_TEMPORAL_TASK_QUEUE_ENV,
} from "./temporal-runner.js";

export const PI_FLOW_TEMPORAL_WORKER_SLOTS_ENV = "PI_FLOW_TEMPORAL_WORKER_SLOTS";
export const DEFAULT_TEMPORAL_WORKER_SLOTS = 1;

export interface TemporalWorkerLike {
	run(): Promise<void>;
}

export interface TemporalNativeConnectionLike {
	close?(): Promise<void>;
}

export interface TemporalWorkerSdkLike {
	NativeConnection: {
		connect(options: { address: string }): Promise<TemporalNativeConnectionLike>;
	};
	Worker: {
		create(options: {
			connection: TemporalNativeConnectionLike;
			namespace: string;
			taskQueue: string;
			workflowsPath: string;
			activities: Record<string, unknown>;
			maxConcurrentActivityTaskExecutions: number;
		}): Promise<TemporalWorkerLike>;
	};
}

export interface TemporalWorkerConfig {
	address: string;
	namespace: string;
	taskQueue: string;
	activitySlots: number;
}

export interface TemporalWorkerLogger {
	info(message: string): void;
	error(message: string): void;
}

export interface TemporalWorkerCliMainOptions {
	env?: NodeJS.ProcessEnv;
	logger?: TemporalWorkerLogger;
	sdk?: TemporalWorkerSdkLike;
	activities?: Record<string, unknown>;
}

export function resolveTemporalWorkerSlots(env: NodeJS.ProcessEnv = process.env): number {
	const configured = env[PI_FLOW_TEMPORAL_WORKER_SLOTS_ENV]?.trim();
	if (!configured) return DEFAULT_TEMPORAL_WORKER_SLOTS;
	if (!/^\d+$/.test(configured)) {
		throw new Error(`${PI_FLOW_TEMPORAL_WORKER_SLOTS_ENV} must be a positive integer. Received ${JSON.stringify(configured)}.`);
	}
	const slots = Number.parseInt(configured, 10);
	if (!Number.isSafeInteger(slots) || slots < 1) {
		throw new Error(`${PI_FLOW_TEMPORAL_WORKER_SLOTS_ENV} must be a positive integer. Received ${JSON.stringify(configured)}.`);
	}
	return slots;
}

export function resolveTemporalWorkerConfig(env: NodeJS.ProcessEnv = process.env): TemporalWorkerConfig {
	return {
		address: env[PI_FLOW_TEMPORAL_ADDRESS_ENV]?.trim() || DEFAULT_TEMPORAL_ADDRESS,
		namespace: env[PI_FLOW_TEMPORAL_NAMESPACE_ENV]?.trim() || DEFAULT_TEMPORAL_NAMESPACE,
		taskQueue: env[PI_FLOW_TEMPORAL_TASK_QUEUE_ENV]?.trim() || DEFAULT_TEMPORAL_TASK_QUEUE,
		activitySlots: resolveTemporalWorkerSlots(env),
	};
}

async function loadTemporalWorkerSdk(): Promise<TemporalWorkerSdkLike> {
	try {
		return await import("@temporalio/worker") as TemporalWorkerSdkLike;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`npm run temporal-worker requires optional package @temporalio/worker. Install and configure Temporal before starting this worker. (${message})`,
		);
	}
}

async function loadTemporalActivities(): Promise<Record<string, unknown>> {
	return await import("./temporal-activities.js") as Record<string, unknown>;
}

export async function createTemporalFlowWorker(
	sdk: TemporalWorkerSdkLike,
	env: NodeJS.ProcessEnv = process.env,
	activities?: Record<string, unknown>,
): Promise<{ worker: TemporalWorkerLike; connection: TemporalNativeConnectionLike; config: TemporalWorkerConfig }> {
	const config = resolveTemporalWorkerConfig(env);
	const connection = await sdk.NativeConnection.connect({ address: config.address });
	try {
		const worker = await sdk.Worker.create({
			connection,
			namespace: config.namespace,
			taskQueue: config.taskQueue,
			workflowsPath: fileURLToPath(new URL("./temporal-workflows.js", import.meta.url)),
			activities: activities ?? await loadTemporalActivities(),
			maxConcurrentActivityTaskExecutions: config.activitySlots,
		});
		return { worker, connection, config };
	} catch (error) {
		await connection.close?.();
		throw error;
	}
}

export async function startTemporalFlowWorker(
	sdk: TemporalWorkerSdkLike,
	env: NodeJS.ProcessEnv = process.env,
	logger: TemporalWorkerLogger = console,
	activities?: Record<string, unknown>,
): Promise<void> {
	const { worker, connection, config } = await createTemporalFlowWorker(sdk, env, activities);
	logger.info(`Temporal worker ready for task queue ${config.taskQueue} (namespace=${config.namespace}, address=${config.address}, activitySlots=${config.activitySlots}).`);
	try {
		await worker.run();
	} finally {
		await connection.close?.();
	}
}

export async function main(options: TemporalWorkerCliMainOptions = {}): Promise<void> {
	const env = options.env ?? process.env;
	const logger = options.logger ?? console;
	try {
		const sdk = options.sdk ?? await loadTemporalWorkerSdk();
		await startTemporalFlowWorker(sdk, env, logger, options.activities);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to start Temporal worker: ${detail}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main();
}

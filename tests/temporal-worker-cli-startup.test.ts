import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_TEMPORAL_ADDRESS,
	DEFAULT_TEMPORAL_NAMESPACE,
	DEFAULT_TEMPORAL_TASK_QUEUE,
	PI_FLOW_TEMPORAL_ADDRESS_ENV,
	PI_FLOW_TEMPORAL_NAMESPACE_ENV,
	PI_FLOW_TEMPORAL_TASK_QUEUE_ENV,
} from "../src/temporal-runner.js";
import {
	DEFAULT_TEMPORAL_WORKER_SLOTS,
	PI_FLOW_TEMPORAL_WORKER_SLOTS_ENV,
	createTemporalFlowWorker,
	main,
	resolveTemporalWorkerConfig,
	startTemporalFlowWorker,
	type TemporalWorkerSdkLike,
} from "../src/temporal-worker-cli.js";

vi.mock("@temporalio/worker", () => {
	throw new Error("Temporal worker SDK should not load during worker CLI import when an SDK is injected");
});

describe("Temporal worker CLI startup", () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	it("can be imported and resolves default worker config without loading the Temporal worker SDK", () => {
		expect(resolveTemporalWorkerConfig({} as NodeJS.ProcessEnv)).toEqual({
			address: DEFAULT_TEMPORAL_ADDRESS,
			namespace: DEFAULT_TEMPORAL_NAMESPACE,
			taskQueue: DEFAULT_TEMPORAL_TASK_QUEUE,
			activitySlots: DEFAULT_TEMPORAL_WORKER_SLOTS,
		});
	});

	it("creates and runs a Temporal worker with injected SDK and activities", async () => {
		const connection = { close: vi.fn(async () => {}) };
		const worker = { run: vi.fn(async () => {}) };
		const sdk: TemporalWorkerSdkLike = {
			NativeConnection: { connect: vi.fn(async () => connection) },
			Worker: { create: vi.fn(async () => worker) },
		};
		const activities = { runTemporalFlowActivity: vi.fn() };
		const logger = { info: vi.fn(), error: vi.fn() };
		const env = {
			[PI_FLOW_TEMPORAL_ADDRESS_ENV]: "temporal.example:7233",
			[PI_FLOW_TEMPORAL_NAMESPACE_ENV]: "prod",
			[PI_FLOW_TEMPORAL_TASK_QUEUE_ENV]: "pi-flow-prod",
			[PI_FLOW_TEMPORAL_WORKER_SLOTS_ENV]: "2",
		} as NodeJS.ProcessEnv;

		await startTemporalFlowWorker(sdk, env, logger, activities);

		expect(sdk.NativeConnection.connect).toHaveBeenCalledWith({ address: "temporal.example:7233" });
		expect(sdk.Worker.create).toHaveBeenCalledWith(
			expect.objectContaining({
				connection,
				namespace: "prod",
				taskQueue: "pi-flow-prod",
				activities,
				maxConcurrentActivityTaskExecutions: 2,
			}),
		);
		expect((sdk.Worker.create as any).mock.calls[0][0].workflowsPath).toContain("temporal-workflows.js");
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Temporal worker ready"));
		expect(worker.run).toHaveBeenCalledTimes(1);
		expect(connection.close).toHaveBeenCalledTimes(1);
	});

	it("closes the Temporal connection if worker creation fails", async () => {
		const connection = { close: vi.fn(async () => {}) };
		const sdk: TemporalWorkerSdkLike = {
			NativeConnection: { connect: vi.fn(async () => connection) },
			Worker: { create: vi.fn(async () => { throw new Error("bad worker"); }) },
		};

		await expect(createTemporalFlowWorker(sdk, {} as NodeJS.ProcessEnv, { runTemporalFlowActivity: vi.fn() })).rejects.toThrow(
			"bad worker",
		);
		expect(connection.close).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid Temporal worker slot configuration", () => {
		expect(() => resolveTemporalWorkerConfig({ [PI_FLOW_TEMPORAL_WORKER_SLOTS_ENV]: "0" } as NodeJS.ProcessEnv)).toThrow(
			"positive integer",
		);
		expect(() => resolveTemporalWorkerConfig({ [PI_FLOW_TEMPORAL_WORKER_SLOTS_ENV]: "many" } as NodeJS.ProcessEnv)).toThrow(
			"positive integer",
		);
	});

	it("main logs startup failures without throwing", async () => {
		const sdk: TemporalWorkerSdkLike = {
			NativeConnection: { connect: vi.fn(async () => { throw new Error("cannot connect"); }) },
			Worker: { create: vi.fn() as any },
		};
		const logger = { info: vi.fn(), error: vi.fn() };
		const previousExitCode = process.exitCode;
		try {
			process.exitCode = undefined;
			await main({ sdk, logger, activities: { runTemporalFlowActivity: vi.fn() } });
			expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("cannot connect"));
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("createTemporalFlowWorker returns worker, connection, and resolved config", async () => {
		const connection = { close: vi.fn(async () => {}) };
		const worker = { run: vi.fn(async () => {}) };
		const sdk: TemporalWorkerSdkLike = {
			NativeConnection: { connect: vi.fn(async () => connection) },
			Worker: { create: vi.fn(async () => worker) },
		};
		const result = await createTemporalFlowWorker(sdk, {} as NodeJS.ProcessEnv, { runTemporalFlowActivity: vi.fn() });
		expect(result).toMatchObject({ worker, connection, config: resolveTemporalWorkerConfig({} as NodeJS.ProcessEnv) });
	});
});

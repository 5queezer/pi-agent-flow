import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunFlowOptions } from "../src/core/flow.js";
import { runFlow } from "../src/core/flow.js";
import { createFlowRunnerFromEnv, DEFAULT_LOCAL_FLOW_RUNNER } from "../src/flow-runner.js";
import { serializeHatchetFlowPayload } from "../src/hatchet-payload.js";
import {
	DEFAULT_TEMPORAL_ADDRESS,
	DEFAULT_TEMPORAL_NAMESPACE,
	DEFAULT_TEMPORAL_TASK_QUEUE,
	PI_FLOW_TEMPORAL_ADDRESS_ENV,
	PI_FLOW_TEMPORAL_NAMESPACE_ENV,
	PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS_ENV,
	PI_FLOW_TEMPORAL_TASK_QUEUE_ENV,
	TEMPORAL_FLOW_WORKFLOW_TYPE,
	TemporalFlowRunner,
	resolveTemporalAddress,
	resolveTemporalNamespace,
	resolveTemporalTaskQueue,
} from "../src/temporal-runner.js";
import { runTemporalFlowActivity } from "../src/temporal-activities.js";
import { emptyFlowUsage, type SingleResult } from "../src/types/flow.js";

vi.mock("../src/core/flow.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/flow.js")>();
	return {
		...actual,
		runFlow: vi.fn(async (opts: any): Promise<SingleResult> => {
			expect(process.env.PI_FLOW_RUNNER).toBe("local");
			return {
				type: opts.flowName,
				agentSource: "project",
				intent: opts.intent,
				aim: opts.aim,
				exitCode: 0,
				messages: [],
				stderr: "",
				usage: emptyFlowUsage(),
			};
		}),
	};
});

function options(overrides: Partial<RunFlowOptions> = {}): RunFlowOptions {
	return {
		cwd: process.cwd(),
		flows: [
			{
				name: "build",
				description: "Code",
				systemPrompt: "Prompt",
				source: "project",
				filePath: `${process.cwd()}/.pi/agents/build.md`,
			},
		],
		flowName: "build",
		intent: "Implement feature",
		aim: "Implement feature",
		forkSessionSnapshotJsonl: null,
		parentDepth: 1,
		parentFlowStack: ["craft"],
		maxDepth: 3,
		preventCycles: true,
		toolOptimize: true,
		structuredOutput: true,
		model: "test-model",
		makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
		...overrides,
	};
}

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		type: "build",
		agentSource: "project",
		intent: "Implement feature",
		aim: "Implement feature",
		exitCode: 0,
		messages: [],
		stderr: "done",
		usage: emptyFlowUsage(),
		...overrides,
	};
}

describe("Temporal runner", () => {
	const originalAddress = process.env[PI_FLOW_TEMPORAL_ADDRESS_ENV];
	const originalNamespace = process.env[PI_FLOW_TEMPORAL_NAMESPACE_ENV];
	const originalTaskQueue = process.env[PI_FLOW_TEMPORAL_TASK_QUEUE_ENV];
	const originalTimeout = process.env[PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS_ENV];
	const originalRunner = process.env.PI_FLOW_RUNNER;
	const originalSpawn = process.env.PI_FLOW_SPAWN_COMMAND;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env[PI_FLOW_TEMPORAL_ADDRESS_ENV];
		delete process.env[PI_FLOW_TEMPORAL_NAMESPACE_ENV];
		delete process.env[PI_FLOW_TEMPORAL_TASK_QUEUE_ENV];
		delete process.env[PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS_ENV];
		delete process.env.PI_FLOW_RUNNER;
		delete process.env.PI_FLOW_SPAWN_COMMAND;
	});

	afterEach(() => {
		vi.doUnmock("@temporalio/client");
		if (originalAddress === undefined) delete process.env[PI_FLOW_TEMPORAL_ADDRESS_ENV];
		else process.env[PI_FLOW_TEMPORAL_ADDRESS_ENV] = originalAddress;
		if (originalNamespace === undefined) delete process.env[PI_FLOW_TEMPORAL_NAMESPACE_ENV];
		else process.env[PI_FLOW_TEMPORAL_NAMESPACE_ENV] = originalNamespace;
		if (originalTaskQueue === undefined) delete process.env[PI_FLOW_TEMPORAL_TASK_QUEUE_ENV];
		else process.env[PI_FLOW_TEMPORAL_TASK_QUEUE_ENV] = originalTaskQueue;
		if (originalTimeout === undefined) delete process.env[PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS_ENV];
		else process.env[PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS_ENV] = originalTimeout;
		if (originalRunner === undefined) delete process.env.PI_FLOW_RUNNER;
		else process.env.PI_FLOW_RUNNER = originalRunner;
		if (originalSpawn === undefined) delete process.env.PI_FLOW_SPAWN_COMMAND;
		else process.env.PI_FLOW_SPAWN_COMMAND = originalSpawn;
		vi.useRealTimers();
	});

	it("selects Temporal only when PI_FLOW_RUNNER=temporal", () => {
		expect(createFlowRunnerFromEnv({} as NodeJS.ProcessEnv)).toBe(DEFAULT_LOCAL_FLOW_RUNNER);
		expect(createFlowRunnerFromEnv({ PI_FLOW_RUNNER: "local" } as NodeJS.ProcessEnv)).toBe(DEFAULT_LOCAL_FLOW_RUNNER);
		expect(createFlowRunnerFromEnv({ PI_FLOW_RUNNER: "temporal" } as NodeJS.ProcessEnv).constructor.name).toBe(
			"TemporalFlowRunner",
		);
	});

	it("resolves Temporal client defaults and env overrides", () => {
		expect(resolveTemporalAddress({} as NodeJS.ProcessEnv)).toBe(DEFAULT_TEMPORAL_ADDRESS);
		expect(resolveTemporalNamespace({} as NodeJS.ProcessEnv)).toBe(DEFAULT_TEMPORAL_NAMESPACE);
		expect(resolveTemporalTaskQueue({} as NodeJS.ProcessEnv)).toBe(DEFAULT_TEMPORAL_TASK_QUEUE);
		expect(resolveTemporalAddress({ PI_FLOW_TEMPORAL_ADDRESS: " temporal:7233 " } as NodeJS.ProcessEnv)).toBe(
			"temporal:7233",
		);
		expect(resolveTemporalNamespace({ PI_FLOW_TEMPORAL_NAMESPACE: " prod " } as NodeJS.ProcessEnv)).toBe("prod");
		expect(resolveTemporalTaskQueue({ PI_FLOW_TEMPORAL_TASK_QUEUE: " queue " } as NodeJS.ProcessEnv)).toBe("queue");
	});

	it("submits a Temporal workflow payload and emits lifecycle updates", async () => {
		const updates: any[] = [];
		const submissions: any[] = [];
		process.env[PI_FLOW_TEMPORAL_ADDRESS_ENV] = "temporal.example:7233";
		process.env[PI_FLOW_TEMPORAL_NAMESPACE_ENV] = "prod";
		process.env[PI_FLOW_TEMPORAL_TASK_QUEUE_ENV] = "pi-flow-prod";
		const runner = new TemporalFlowRunner(async (workflowType, payload, executionOptions) => {
			submissions.push({ workflowType, payload, executionOptions });
			return makeResult({ stderr: "from temporal" });
		});

		const result = await runner.run(options({ onUpdate: (update) => updates.push(update) }), {
			projectFlowsDir: `${process.cwd()}/.pi/agents`,
		});

		expect(result.stderr).toBe("from temporal");
		expect(submissions).toHaveLength(1);
		expect(submissions[0].workflowType).toBe(TEMPORAL_FLOW_WORKFLOW_TYPE);
		expect(submissions[0].payload.flowName).toBe("build");
		expect(submissions[0].payload.projectFlowsDir).toBe(`${process.cwd()}/.pi/agents`);
		expect(submissions[0].executionOptions).toMatchObject({
			address: "temporal.example:7233",
			namespace: "prod",
			taskQueue: "pi-flow-prod",
		});
		expect(submissions[0].executionOptions.workflowId).toMatch(/^pi-agent-flow-build-/);
		expect(updates.map((update) => update.content[0].text)).toEqual([
			"Temporal queued/running flow build.",
			"Temporal completed flow build.",
		]);
		expect(updates[0].details.results[0]).toMatchObject({ type: "build", agentSource: "unknown", exitCode: -1 });
		expect(updates[1].details.results[0]).toMatchObject({ type: "build", stderr: "from temporal", exitCode: 0 });
	});

	it("default executor closes the Temporal client connection after workflow completion", async () => {
		const close = vi.fn(async () => {});
		const connection = { close };
		const execute = vi.fn(async () => makeResult({ stderr: "from sdk" }));
		const connect = vi.fn(async () => connection);
		class Client {
			workflow = { execute };
			constructor(readonly options: any) {
				expect(options).toEqual({ connection, namespace: DEFAULT_TEMPORAL_NAMESPACE });
			}
		}
		vi.doMock("@temporalio/client", () => ({ Connection: { connect }, Client }));

		const result = await new TemporalFlowRunner().run(options());

		expect(result.stderr).toBe("from sdk");
		expect(connect).toHaveBeenCalledWith({ address: DEFAULT_TEMPORAL_ADDRESS });
		expect(execute).toHaveBeenCalledWith(
			TEMPORAL_FLOW_WORKFLOW_TYPE,
			expect.objectContaining({ taskQueue: DEFAULT_TEMPORAL_TASK_QUEUE, args: [expect.objectContaining({ flowName: "build" })] }),
		);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("rejects malformed Temporal workflow results before completion is emitted", async () => {
		const updates: any[] = [];
		const runner = new TemporalFlowRunner(async () => ({ result: "wrapped" }));

		await expect(runner.run(options({ onUpdate: (update) => updates.push(update) }))).rejects.toThrow(
			"invalid SingleResult",
		);
		expect(updates.map((update) => update.content[0].text)).toEqual([
			"Temporal queued/running flow build.",
			"Temporal failed flow build.",
		]);
		expect(updates[1].details.results[0]).toMatchObject({
			type: "build",
			stderr: "Temporal flow failed.",
			errorMessage: "Temporal submission failed.",
			exitCode: -1,
		});
	});

	it("times out when Temporal never returns a result", async () => {
		process.env[PI_FLOW_TEMPORAL_RESULT_TIMEOUT_MS_ENV] = "5";
		vi.useFakeTimers();
		const runner = new TemporalFlowRunner(async () => await new Promise<SingleResult>(() => {}));
		const resultPromise = expect(runner.run(options())).rejects.toThrow("did not return a result");
		await vi.advanceTimersByTimeAsync(5);
		await resultPromise;
	});

	it("activity entrypoint forces local child flow execution and restores env", async () => {
		const previousRunner = process.env.PI_FLOW_RUNNER;
		const previousSpawn = process.env.PI_FLOW_SPAWN_COMMAND;
		const payload = serializeHatchetFlowPayload(options({ cwd: process.cwd() }), `${process.cwd()}/.pi/agents`);
		await runTemporalFlowActivity(payload);
		expect(runFlow).toHaveBeenCalledTimes(1);
		expect(process.env.PI_FLOW_RUNNER).toBe(previousRunner);
		expect(process.env.PI_FLOW_SPAWN_COMMAND).toBe(previousSpawn);
	});
});

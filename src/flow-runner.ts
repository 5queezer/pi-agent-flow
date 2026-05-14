import { runFlow, type RunFlowOptions } from "./flow.js";
import { HatchetFlowRunner } from "./hatchet-runner.js";
import type { SingleResult } from "./types.js";

export interface FlowRunContext {
	/** Project-local flow directory discovered by the parent process, if any. */
	projectFlowsDir: string | null;
}

/**
 * Execution backend for a single resolved flow attempt.
 *
 * Implementations must propagate depth guards (PI_FLOW_DEPTH,
 * PI_FLOW_MAX_DEPTH, PI_FLOW_STACK, PI_FLOW_PREVENT_CYCLES) and timeout
 * deadline environment variables (PI_FLOW_DEADLINE_MS,
 * PI_FLOW_TOOL_SUMMARY_GRACE_MS) to child processes. LocalFlowRunner is the
 * canonical implementation and preserves this propagation contract by
 * delegating to runFlow.
 */
export interface FlowRunner {
	run(options: RunFlowOptions, context?: FlowRunContext): Promise<SingleResult>;
}

/** Default in-process runner that preserves existing forked child-process behavior. */
export class LocalFlowRunner implements FlowRunner {
	run(options: RunFlowOptions): Promise<SingleResult> {
		return runFlow(options);
	}
}

export const PI_FLOW_RUNNER_ENV = "PI_FLOW_RUNNER";
export const DEFAULT_LOCAL_FLOW_RUNNER = new LocalFlowRunner();

export function createFlowRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): FlowRunner {
	const requested = env[PI_FLOW_RUNNER_ENV]?.trim().toLowerCase();
	if (!requested || requested === "local") return DEFAULT_LOCAL_FLOW_RUNNER;
	if (requested === "hatchet") return new HatchetFlowRunner();
	console.warn(`[pi-agent-flow] Ignoring unknown ${PI_FLOW_RUNNER_ENV}="${requested}". Using local runner.`);
	return DEFAULT_LOCAL_FLOW_RUNNER;
}

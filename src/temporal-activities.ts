import { Context } from "@temporalio/activity";
import type { SingleResult } from "./types/flow.js";
import {
	deserializeHatchetFlowPayload,
	resolveHatchetSpawnCommand,
	validateHatchetWorkerPayload,
	type HatchetFlowPayload,
} from "./hatchet-payload.js";
import { validateSingleResult } from "./hatchet-runner.js";

function heartbeat(detail: string): void {
	try {
		Context.current().heartbeat(detail);
	} catch {
		// Unit tests and direct invocations may run outside a Temporal Activity context.
	}
}

export async function runTemporalFlowActivity(payload: HatchetFlowPayload): Promise<SingleResult> {
	const originalRunner = process.env.PI_FLOW_RUNNER;
	const originalSpawn = process.env.PI_FLOW_SPAWN_COMMAND;
	process.env.PI_FLOW_RUNNER = "local";
	process.env.PI_FLOW_SPAWN_COMMAND = resolveHatchetSpawnCommand(process.env);
	try {
		validateHatchetWorkerPayload(payload);
		heartbeat("starting pi flow");
		const { runFlow } = await import("./core/flow.js");
		const result = validateSingleResult(
			await runFlow(deserializeHatchetFlowPayload(payload)),
			"Temporal activity result",
		);
		heartbeat("completed pi flow");
		return result;
	} finally {
		if (originalRunner === undefined) delete process.env.PI_FLOW_RUNNER;
		else process.env.PI_FLOW_RUNNER = originalRunner;
		if (originalSpawn === undefined) delete process.env.PI_FLOW_SPAWN_COMMAND;
		else process.env.PI_FLOW_SPAWN_COMMAND = originalSpawn;
	}
}

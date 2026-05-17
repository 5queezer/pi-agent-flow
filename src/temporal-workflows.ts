import { proxyActivities } from "@temporalio/workflow";
import type { HatchetFlowPayload } from "./hatchet-payload.js";
import type { SingleResult } from "./types/flow.js";
import type * as activities from "./temporal-activities.js";

const { runTemporalFlowActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "1 hour",
	retry: {
		maximumAttempts: 1,
	},
});

export async function runPiFlowWorkflow(payload: HatchetFlowPayload): Promise<SingleResult> {
	return await runTemporalFlowActivity(payload);
}

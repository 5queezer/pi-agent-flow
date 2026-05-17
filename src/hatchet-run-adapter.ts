/**
 * Hatchet run adapter abstraction.
 *
 * Decouples HatchetFlowRunner from the live SDK so tests can use fake adapters.
 * Production adapters should return a remote Hatchet run handle that can be
 * re-opened after the Pi process restarts.
 */
import type { SingleResult } from "./types/flow.js";
import type { DurableFlowPayload } from "./durable-flow-payload.js";

/** A remote Hatchet run handle returned after successful submission. */
export interface HatchetRunHandle {
	runId: string;
	/** False for compatibility adapters whose handle only works in this process. */
	durable?: boolean;
}

export interface HatchetRunSubmitOptions {
	clientRunId?: string;
}

/** Status response from polling a remote Hatchet run. */
export type HatchetRemoteRunStatus =
	| { status: "queued" | "running" | "unknown"; errorMessage?: string }
	| { status: "completed"; result: SingleResult }
	| { status: "failed" | "cancelled"; errorMessage: string; result?: SingleResult };

/**
 * Adapter interface for submitting and polling Hatchet flow runs.
 * Implement this interface to create test fakes or alternative Hatchet clients.
 */
export interface HatchetRunAdapter {
	/** Submit a task to Hatchet and return a handle immediately (or when the run is accepted). */
	submit(taskName: string, payload: DurableFlowPayload, options?: HatchetRunSubmitOptions): Promise<HatchetRunHandle>;
	/** Get the current status/result of a submitted run. */
	getResult(handle: HatchetRunHandle): Promise<HatchetRemoteRunStatus>;
	/** Cancel a running run. Optional — implementations may leave this undefined. */
	cancel?(handle: HatchetRunHandle): Promise<void>;
}

/**
 * Compatibility adapter that wraps an existing HatchetSubmitter function.
 *
 * This adapter is intentionally not durable: it can only recover results while
 * the current Pi process is alive. The default PI_FLOW_RUNNER=hatchet path uses
 * the SDK run-ref adapter instead.
 */
export class SubmitterAdapter implements HatchetRunAdapter {
	private readonly inFlight = new Map<string, Promise<SingleResult>>();
	private nextId = 0;

	constructor(private readonly submitter: (taskName: string, payload: DurableFlowPayload) => Promise<SingleResult>) {}

	async submit(taskName: string, payload: DurableFlowPayload): Promise<HatchetRunHandle> {
		const runId = `synthetic-${++this.nextId}-${Date.now()}`;
		// Start the submission but don't await it here; cache the promise.
		const promise = this.submitter(taskName, payload);
		this.inFlight.set(runId, promise);
		return { runId, durable: false };
	}

	async getResult(handle: HatchetRunHandle): Promise<HatchetRemoteRunStatus> {
		const promise = this.inFlight.get(handle.runId);
		if (!promise) {
			return { status: "unknown", errorMessage: "No in-flight promise found for this synthetic run handle." };
		}
		try {
			const result = await promise;
			this.inFlight.delete(handle.runId);
			return { status: "completed", result };
		} catch (err) {
			this.inFlight.delete(handle.runId);
			const errorMessage = err instanceof Error ? err.message : String(err);
			return { status: "failed", errorMessage };
		}
	}
}

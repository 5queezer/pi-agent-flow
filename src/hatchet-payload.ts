import type { RunFlowOptions } from "./core/flow.js";
import {
  DEFAULT_DURABLE_MAX_PAYLOAD_BYTES,
  DURABLE_FLOW_TASK_NAME,
  PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV,
  deserializeDurableFlowPayload,
  resolveDurableMaxPayloadBytes,
  resolveDurableSpawnCommand,
  serializeDurableFlowPayload,
  validateDurableFlowPayloadSize,
  validateDurableWorkerPayload,
  type DurableFlowPayload,
} from "./durable-flow-payload.js";

/**
 * Hatchet task name used by the parent runner and worker entrypoint.
 * Kept as a compatibility alias for the backend-neutral durable task name.
 */
export const HATCHET_FLOW_TASK_NAME = DURABLE_FLOW_TASK_NAME;

/** Legacy Hatchet-specific payload size environment variable. */
export { PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV };

/** Compatibility alias for the backend-neutral durable payload size default. */
export const DEFAULT_HATCHET_MAX_PAYLOAD_BYTES = DEFAULT_DURABLE_MAX_PAYLOAD_BYTES;

/** Compatibility alias for the backend-neutral durable flow payload. */
export type HatchetFlowPayload = DurableFlowPayload;

/** Compatibility wrapper that resolves durable payload size limits. */
export function resolveHatchetMaxPayloadBytes(env: NodeJS.ProcessEnv = process.env): number {
  return resolveDurableMaxPayloadBytes(env);
}

/** Compatibility wrapper that preserves the Hatchet-specific error wording. */
export function validateHatchetFlowPayloadSize(
  payload: HatchetFlowPayload,
  maxBytes = resolveHatchetMaxPayloadBytes(),
): void {
  validateDurableFlowPayloadSize(
    payload,
    maxBytes,
    "Hatchet flow payload",
    PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV,
  );
}

/** Compatibility wrapper that preserves the Hatchet worker label in diagnostics. */
export function validateHatchetWorkerPayload(payload: HatchetFlowPayload): void {
  validateDurableWorkerPayload(payload, "Hatchet worker");
}

/** Compatibility alias for durable worker spawn command validation. */
export const resolveHatchetSpawnCommand = resolveDurableSpawnCommand;

/** Compatibility wrapper for serializing runFlow options into a durable payload. */
export function serializeHatchetFlowPayload(
  options: RunFlowOptions,
  projectFlowsDir: string | null = null,
): HatchetFlowPayload {
  return serializeDurableFlowPayload(options, projectFlowsDir);
}

/** Compatibility wrapper for deserializing durable payloads into runFlow options. */
export function deserializeHatchetFlowPayload(payload: HatchetFlowPayload): RunFlowOptions {
  return deserializeDurableFlowPayload(payload);
}

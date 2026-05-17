import { statSync } from "node:fs";
import type { FlowConfig } from "./core/agents.js";
import type { RunFlowOptions } from "./core/flow.js";
import type { AgentSessionMode } from "./core/session-mode.js";
import type { FlowDetails, SingleResult } from "./types/flow.js";

/**
 * Durable task name used by queue-backed flow runners and worker entrypoints.
 * Payloads cross a durable queue trust boundary and may contain sensitive session context.
 */
export const DURABLE_FLOW_TASK_NAME = "pi-agent-flow.runFlow";

/** Backend-neutral environment variable for maximum serialized durable payload size in bytes. */
export const PI_FLOW_DURABLE_MAX_PAYLOAD_BYTES_ENV = "PI_FLOW_DURABLE_MAX_PAYLOAD_BYTES";

/** Legacy Hatchet-specific payload size environment variable, still honored as a fallback. */
export const PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV = "PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES";

/**
 * Default maximum serialized durable task payload size.
 * The limit bounds session-snapshot exposure and catches accidental oversized queue messages early.
 */
export const DEFAULT_DURABLE_MAX_PAYLOAD_BYTES = 1_500_000;

/**
 * JSON-safe payload submitted to a durable backend for one flow attempt.
 * All fields originate from the local parent executor; consumers must treat queued payloads as sensitive.
 */
export interface DurableFlowPayload {
  /** Working directory used by the worker for the flow. */
  cwd: string;
  /** Resolved flow definitions selected by the parent process. */
  flows: FlowConfig[];
  /** Name of the flow to run. */
  flowName: string;
  /** User-facing intent passed to the flow. */
  intent: string;
  /** Short aim label for the flow attempt. */
  aim: string;
  /** Optional acceptance criteria supplied by the parent. */
  acceptance?: string;
  /** Optional task-specific working directory. */
  taskCwd?: string;
  /** Serialized forked session snapshot; may contain sensitive conversation or tool context. */
  forkSessionSnapshotJsonl: string | null;
  /** Parent flow depth used for delegation guards. */
  parentDepth: number;
  /** Ancestor flow stack used for cycle prevention. */
  parentFlowStack: string[];
  /** Maximum allowed delegation depth. */
  maxDepth: number;
  /** Whether cycle prevention is enabled for the run. */
  preventCycles: boolean;
  /** Optional tool optimization mode selected by the parent. */
  toolOptimize?: boolean;
  /** Optional structured-output setting selected by the parent. */
  structuredOutput?: boolean;
  /** Optional model override for the flow attempt. */
  model?: string;
  /** Optional session timeout/profile mode. */
  sessionMode?: AgentSessionMode;
  /** Project-local flow directory discovered by the parent, or null when unavailable. */
  projectFlowsDir: string | null;
}

function makeFlowDetails(projectFlowsDir: string | null): (results: SingleResult[]) => FlowDetails {
  return (results) => ({
    mode: "flow",
    flowStyle: "fork",
    projectAgentsDir: projectFlowsDir,
    results,
  });
}

function stringifyDurablePayload(payload: DurableFlowPayload): string {
  return JSON.stringify(payload);
}

function assertJsonSerializable(payload: DurableFlowPayload): void {
  JSON.parse(stringifyDurablePayload(payload));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateSingleResult(value: unknown, source = "Durable flow result"): SingleResult {
  if (!isRecord(value)) {
    throw new Error(`${source} returned an invalid SingleResult: expected an object.`);
  }

  for (const field of ["type", "agentSource", "intent", "aim", "stderr"] as const) {
    if (typeof value[field] !== "string") {
      throw new Error(`${source} returned an invalid SingleResult: ${JSON.stringify(field)} must be a string.`);
    }
  }

  if (!(["user", "project", "bundled", "unknown"] as const).includes(value.agentSource as any)) {
    throw new Error(
      `${source} returned an invalid SingleResult: "agentSource" must be one of user, project, bundled, or unknown.`,
    );
  }

  if (typeof value.exitCode !== "number" || !Number.isFinite(value.exitCode)) {
    throw new Error(`${source} returned an invalid SingleResult: "exitCode" must be a finite number.`);
  }

  if (!Array.isArray(value.messages)) {
    throw new Error(`${source} returned an invalid SingleResult: "messages" must be an array.`);
  }

  if (!isRecord(value.usage)) {
    throw new Error(`${source} returned an invalid SingleResult: "usage" must be an object.`);
  }

  for (const field of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cost",
    "contextTokens",
    "turns",
    "toolCalls",
  ] as const) {
    if (typeof value.usage[field] !== "number" || !Number.isFinite(value.usage[field])) {
      throw new Error(
        `${source} returned an invalid SingleResult: ${JSON.stringify(`usage.${field}`)} must be a finite number.`,
      );
    }
  }

  if (
    value.usage.smoothedTps !== undefined &&
    (typeof value.usage.smoothedTps !== "number" || !Number.isFinite(value.usage.smoothedTps))
  ) {
    throw new Error(
      `${source} returned an invalid SingleResult: "usage.smoothedTps" must be a finite number when present.`,
    );
  }

  for (const field of ["acceptance", "model", "stopReason", "errorMessage", "streamingText"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`${source} returned an invalid SingleResult: ${JSON.stringify(field)} must be a string when present.`);
    }
  }

  if (value.sawAgentEnd !== undefined && typeof value.sawAgentEnd !== "boolean") {
    throw new Error(`${source} returned an invalid SingleResult: "sawAgentEnd" must be a boolean when present.`);
  }

  for (const field of ["startedAtMs", "deadlineAtMs"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) {
      throw new Error(`${source} returned an invalid SingleResult: ${JSON.stringify(field)} must be a finite number when present.`);
    }
  }

  if (value.structuredOutput !== undefined && !isRecord(value.structuredOutput)) {
    throw new Error(`${source} returned an invalid SingleResult: "structuredOutput" must be an object when present.`);
  }

  return value as unknown as SingleResult;
}

function configuredPayloadLimit(env: NodeJS.ProcessEnv): { value: string; envName: string } | undefined {
  const durableValue = env[PI_FLOW_DURABLE_MAX_PAYLOAD_BYTES_ENV]?.trim();
  if (durableValue) return { value: durableValue, envName: PI_FLOW_DURABLE_MAX_PAYLOAD_BYTES_ENV };

  const legacyHatchetValue = env[PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV]?.trim();
  if (legacyHatchetValue) return { value: legacyHatchetValue, envName: PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV };

  return undefined;
}

/**
 * Resolves the maximum durable payload size from environment configuration.
 * Reads PI_FLOW_DURABLE_MAX_PAYLOAD_BYTES first, then legacy PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES.
 */
export function resolveDurableMaxPayloadBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = configuredPayloadLimit(env);
  if (!configured) return DEFAULT_DURABLE_MAX_PAYLOAD_BYTES;

  if (!/^\d+$/.test(configured.value)) {
    throw new Error(`${configured.envName} must be a positive integer byte limit.`);
  }

  const value = Number(configured.value);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${configured.envName} must be a positive integer byte limit.`);
  }

  return value;
}

/**
 * Validates the serialized durable payload size before crossing the queue trust boundary.
 */
export function validateDurableFlowPayloadSize(
  payload: DurableFlowPayload,
  maxBytes = resolveDurableMaxPayloadBytes(),
  payloadLabel = "Durable flow payload",
  envHint = PI_FLOW_DURABLE_MAX_PAYLOAD_BYTES_ENV,
): void {
  const sizeBytes = Buffer.byteLength(stringifyDurablePayload(payload), "utf8");
  if (sizeBytes > maxBytes) {
    throw new Error(
      `${payloadLabel} is ${sizeBytes} bytes, exceeding limit ${maxBytes}. ` +
        `Reduce inherited context or raise ${envHint} only for trusted private queues with suitable retention controls.`,
    );
  }
}

function assertWorkerDirectory(workerLabel: string, label: string, dir: string): void {
  try {
    const stat = statSync(dir);
    if (stat.isDirectory()) return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${workerLabel} ${label} ${JSON.stringify(dir)} is not accessible. ` +
        `Ensure the worker has a current checkout/workspace before running queued flows. (${message})`,
    );
  }

  throw new Error(
    `${workerLabel} ${label} ${JSON.stringify(dir)} is not a directory. ` +
      "Ensure the worker has a current checkout/workspace before running queued flows.",
  );
}

/** Validates worker-local filesystem assumptions before executing a queued flow. */
export function validateDurableWorkerPayload(
  payload: DurableFlowPayload,
  workerLabel = "Durable worker",
): void {
  assertWorkerDirectory(workerLabel, "cwd", payload.cwd);
  if (payload.taskCwd !== undefined) assertWorkerDirectory(workerLabel, "taskCwd", payload.taskCwd);
}

/** Resolves and validates the worker child-process spawn command. */
export function resolveDurableSpawnCommand(env: NodeJS.ProcessEnv = process.env): string {
  const command = env.PI_FLOW_SPAWN_COMMAND?.trim() || "pi";
  if (/[\0\r\n]/.test(command)) {
    throw new Error("PI_FLOW_SPAWN_COMMAND must be a single command without NUL or newline characters.");
  }
  return command;
}

/** Converts runFlow options into a JSON-safe durable queue payload. */
export function serializeDurableFlowPayload(
  options: RunFlowOptions,
  projectFlowsDir: string | null = null,
): DurableFlowPayload {
  const payload: DurableFlowPayload = {
    cwd: options.cwd,
    flows: options.flows,
    flowName: options.flowName,
    intent: options.intent,
    aim: options.aim,
    ...(options.acceptance !== undefined ? { acceptance: options.acceptance } : {}),
    ...(options.taskCwd !== undefined ? { taskCwd: options.taskCwd } : {}),
    forkSessionSnapshotJsonl: options.forkSessionSnapshotJsonl,
    parentDepth: options.parentDepth,
    parentFlowStack: [...options.parentFlowStack],
    maxDepth: options.maxDepth,
    preventCycles: options.preventCycles,
    ...(options.toolOptimize !== undefined ? { toolOptimize: options.toolOptimize } : {}),
    ...(options.structuredOutput !== undefined ? { structuredOutput: options.structuredOutput } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.sessionMode !== undefined ? { sessionMode: options.sessionMode } : {}),
    projectFlowsDir,
  };
  assertJsonSerializable(payload);
  return payload;
}

/** Reconstructs runFlow options from a durable queue payload. */
export function deserializeDurableFlowPayload(payload: DurableFlowPayload): RunFlowOptions {
  assertJsonSerializable(payload);
  return {
    cwd: payload.cwd,
    flows: payload.flows,
    flowName: payload.flowName,
    intent: payload.intent,
    aim: payload.aim,
    acceptance: payload.acceptance,
    taskCwd: payload.taskCwd,
    forkSessionSnapshotJsonl: payload.forkSessionSnapshotJsonl,
    parentDepth: payload.parentDepth,
    parentFlowStack: payload.parentFlowStack,
    maxDepth: payload.maxDepth,
    preventCycles: payload.preventCycles,
    toolOptimize: payload.toolOptimize,
    structuredOutput: payload.structuredOutput,
    model: payload.model,
    sessionMode: payload.sessionMode,
    makeDetails: makeFlowDetails(payload.projectFlowsDir),
  };
}

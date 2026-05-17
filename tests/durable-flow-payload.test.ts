import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunFlowOptions } from "../src/core/flow.js";
import {
  DEFAULT_DURABLE_MAX_PAYLOAD_BYTES,
  DURABLE_FLOW_TASK_NAME,
  PI_FLOW_DURABLE_MAX_PAYLOAD_BYTES_ENV,
  PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV,
  deserializeDurableFlowPayload,
  resolveDurableMaxPayloadBytes,
  resolveDurableSpawnCommand,
  serializeDurableFlowPayload,
  validateDurableFlowPayloadSize,
  validateDurableWorkerPayload,
} from "../src/durable-flow-payload.js";

function options(overrides: Partial<RunFlowOptions> = {}): RunFlowOptions {
  return {
    cwd: "/repo",
    flows: [
      {
        name: "build",
        description: "Code",
        systemPrompt: "Prompt",
        source: "project",
        filePath: "/repo/.pi/agents/build.md",
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
    sessionMode: "fast",
    makeDetails: (results) => ({ mode: "flow", flowStyle: "fork", projectAgentsDir: null, results }),
    signal: new AbortController().signal,
    onUpdate: () => {},
    ...overrides,
  };
}

describe("durable flow payload helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("serializes flow options into a backend-neutral JSON payload", () => {
    const payload = serializeDurableFlowPayload(options({ acceptance: "Done", taskCwd: "/repo/task" }), "/repo/.pi/agents");

    expect(DURABLE_FLOW_TASK_NAME).toBe("pi-agent-flow.runFlow");
    expect(payload).toMatchObject({
      cwd: "/repo",
      flowName: "build",
      intent: "Implement feature",
      aim: "Implement feature",
      acceptance: "Done",
      taskCwd: "/repo/task",
      parentDepth: 1,
      parentFlowStack: ["craft"],
      maxDepth: 3,
      preventCycles: true,
      toolOptimize: true,
      structuredOutput: true,
      model: "test-model",
      sessionMode: "fast",
      projectFlowsDir: "/repo/.pi/agents",
    });
    expect(JSON.stringify(payload)).not.toContain("onUpdate");
    expect(JSON.stringify(payload)).not.toContain("makeDetails");
    expect(JSON.stringify(payload)).not.toContain("signal");
  });

  it("deserializes payloads with worker-local details restored", () => {
    const runOptions = deserializeDurableFlowPayload(
      serializeDurableFlowPayload(options(), "/repo/.pi/agents"),
    );

    expect(runOptions.flowName).toBe("build");
    expect(runOptions.parentFlowStack).toEqual(["craft"]);
    expect(runOptions.makeDetails([{ type: "build", agentSource: "project", intent: "i", aim: "a", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolCalls: 0 } }])).toMatchObject({
      mode: "flow",
      flowStyle: "fork",
      projectAgentsDir: "/repo/.pi/agents",
    });
  });

  it("resolves durable payload size limits with legacy Hatchet env fallback", () => {
    expect(resolveDurableMaxPayloadBytes({} as NodeJS.ProcessEnv)).toBe(DEFAULT_DURABLE_MAX_PAYLOAD_BYTES);
    expect(resolveDurableMaxPayloadBytes({ [PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV]: "123" } as NodeJS.ProcessEnv)).toBe(123);
    expect(resolveDurableMaxPayloadBytes({ [PI_FLOW_DURABLE_MAX_PAYLOAD_BYTES_ENV]: "456", [PI_FLOW_HATCHET_MAX_PAYLOAD_BYTES_ENV]: "123" } as NodeJS.ProcessEnv)).toBe(456);
    expect(() => resolveDurableMaxPayloadBytes({ [PI_FLOW_DURABLE_MAX_PAYLOAD_BYTES_ENV]: "0" } as NodeJS.ProcessEnv)).toThrow(PI_FLOW_DURABLE_MAX_PAYLOAD_BYTES_ENV);
  });

  it("validates payload size, worker directories, and spawn commands", () => {
    const cwd = mkdtempSync(join(tmpdir(), "durable-payload-"));
    const taskCwd = mkdtempSync(join(cwd, "task-"));
    const filePath = join(cwd, "not-dir");
    writeFileSync(filePath, "x");
    tempDirs.push(cwd);

    const payload = serializeDurableFlowPayload(options({ cwd, taskCwd }));
    expect(() => validateDurableFlowPayloadSize(payload, 10)).toThrow("exceeding limit");
    expect(() => validateDurableWorkerPayload(payload)).not.toThrow();
    expect(() => validateDurableWorkerPayload({ ...payload, taskCwd: filePath })).toThrow("not a directory");
    expect(resolveDurableSpawnCommand({} as NodeJS.ProcessEnv)).toBe("pi");
    expect(resolveDurableSpawnCommand({ PI_FLOW_SPAWN_COMMAND: " custom-pi " } as NodeJS.ProcessEnv)).toBe("custom-pi");
    expect(() => resolveDurableSpawnCommand({ PI_FLOW_SPAWN_COMMAND: "pi\nrm" } as NodeJS.ProcessEnv)).toThrow("single command");
  });
});

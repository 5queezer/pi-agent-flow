import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePlanArtifact } from "../src/snapshot/plan-artifact.js";

describe("writePlanArtifact", () => {
  it("writes a markdown plan under .pi/plans and returns the path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-plan-"));
    const p = writePlanArtifact(cwd, { title: "My Plan", tasks: [{ intent: "i", files: ["a.ts"], verify: "npm test", rollback: "git co a.ts" }] });
    expect(p).toMatch(/[\\/]\.pi[\\/]plans[\\/]\d+.*my-plan\.md$/);
    const files = readdirSync(join(cwd, ".pi", "plans"));
    expect(files).toHaveLength(1);
    expect(readFileSync(p, "utf8")).toContain("## Task 1: i");
  });
});

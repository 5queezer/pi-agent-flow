# Workflow Discipline P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the P1 items of ADR 0006 — verification evidence, plan-artifact contract, review-ingest loop, and a configurable post-build audit gate — without changing default (advisory-router) behavior.

**Architecture:** Four independently-shippable phases. Each reuses existing machinery (structured-output schema, transition matrix, `.pi/` artifact convention, flow-markdown loader) — no new subsystems. All new enforcement is opt-in via env var and defaults off; baseline behavior must be regression-proven unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest (`tests/**/*.test.ts`), flows as Markdown+YAML in `agents/` (bundled) / `.pi/agents/` (project).

**Source ADR:** `doc/adr/0006-configurable-workflow-discipline-gates-and-plan-artifact.md`

**Assumptions (flag if wrong before executing):**
- A1. True mid-run hard-blocking of a child flow is **out of scope** (fork architecture can't preempt a running child without major surgery). The post-build gate (A2) is therefore enforced at the **orchestrator routing layer**: a REQUIRED (not advisory) transition message + a `gated` flag on the result. This matches ADR 0006's "configurable, reuse machinery, don't break the router".
- A2. `tests/__mocks__` already stubs `@earendil-works/*`; new tests follow the existing `tests/transitions.test.ts` / `tests/config.test.ts` style (Vitest `describe`/`it`, no network).
- A3. The executor post-flow loop in `src/core/executor.ts` (~line 452) has access to a project `cwd`. If it does not, Phase 3 Task 3.2 adds threading it through; verify first.
- A4. Lint = `npm run lint`, tests = `npm test`, build = `npm run build` (per `ci.yml`).

**Global per-task rule:** every task ends green on `npm test` and `npm run lint` before its commit. Conventional commit messages. Do not merge to main.

---

## Phase 1 — Foundations (zero behavior change)

Smallest, safest slice. Adds the `gate` primitive (data-only, unused) and documents the advisory-vs-blocking model. Unblocks Phase 4.

### Task 1.1: Add optional `gate` field to `FlowTransition`

**Files:**
- Modify: `src/core/transitions.ts:15-24` (interface), `:30-41` (matrix unchanged)
- Test: `tests/transitions.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/transitions.test.ts`:

```ts
import { DEFAULT_TRANSITIONS, getTransitionAdvice, type FlowTransition } from "../src/core/transitions.js";

it("supports an optional gate flag on transitions without changing advice output", () => {
  const gated: FlowTransition = { from: "build", to: "audit", on: "success", advice: "x", gate: true };
  expect(gated.gate).toBe(true);
  // Default matrix entries remain ungated (advisory).
  expect(DEFAULT_TRANSITIONS.every((t) => t.gate === undefined || t.gate === false)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transitions.test.ts -t "optional gate flag"`
Expected: FAIL — `Object literal may only specify known properties` (TS) / property `gate` missing.

- [ ] **Step 3: Add the field**

In `src/core/transitions.ts`, inside `interface FlowTransition`, after the `advice` field:

```ts
	/** Advisory message shown to the user. */
	advice: string;
	/**
	 * When true, this transition is a blocking gate rather than advisory:
	 * the orchestrator must run `to` (or explicitly waive) before treating
	 * `from`'s work as complete. Default (undefined/false) = advisory.
	 */
	gate?: boolean;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/transitions.test.ts -t "optional gate flag"`
Expected: PASS

- [ ] **Step 5: Full suite + lint**

Run: `npm test && npm run lint`
Expected: PASS (no existing transition behavior changed — `getTransitionAdvice` does not read `gate` yet).

- [ ] **Step 6: Commit**

```bash
git add src/core/transitions.ts tests/transitions.test.ts
git commit -m "feat(transitions): add optional gate flag to FlowTransition (ADR 0006 A3)"
```

### Task 1.2: Document the advisory-vs-blocking model

**Files:**
- Modify: `CLAUDE.md` (Flow Taxonomy section — after the Tier 2 Orchestrator block)

- [ ] **Step 1: Add the documentation block**

Append to `CLAUDE.md` immediately after the line ending `each flow's \`maxDepth\` overrides it.`:

```markdown
### Routing model: advisory by default, gated by opt-in

Post-flow transitions (`src/core/transitions.ts`) are **advisory**: the
orchestrator receives `💡` suggestions and decides whether to follow them.
Nothing blocks. This is intentional — pi-agent-flow is a router, not a
linear pipeline.

A transition may be marked `gate: true`. A gated transition is **REQUIRED**:
the orchestrator must run the target flow (or explicitly waive it) before
treating the source flow's work as complete. Gates are opt-in via env var
and default off. See ADR 0006.

| Env var | Default | Effect |
|---------|---------|--------|
| `PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD` | off | Marks `build --success--> audit` as a blocking gate. |
```

- [ ] **Step 2: Verify rendering**

Run: `grep -n "advisory by default" CLAUDE.md`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document advisory-vs-blocking routing model (ADR 0006 H2)"
```

---

## Phase 2 — Verification evidence (E1, E2)

Adds a uniform `verification` array to structured output, teaches the directive to emit it, and flags success-without-evidence at parse time. Independent of Phase 1.

### Task 2.1: Add `VerificationEntry` to the output schema

**Files:**
- Modify: `src/types/output.ts` (add interface + field on `FlowStructuredOutput` and `CompressedFlowResult`)
- Test: `tests/structured-output.test.ts` (create if absent — mirror `tests/transitions.test.ts` style)

- [ ] **Step 1: Write the failing test**

Create `tests/structured-output.test.ts` (or append if it exists):

```ts
import { describe, it, expect } from "vitest";
import { extractStructuredOutput } from "../src/snapshot/structured-output.js";

describe("verification evidence", () => {
  it("parses a verification array", () => {
    const text = '```json\n{"version":"1","status":"complete","summary":"s","verification":[{"command":"npm test","result":"pass","evidence":"42 passed"}]}\n```';
    const out = extractStructuredOutput(text);
    expect(out?.verification).toEqual([{ command: "npm test", result: "pass", evidence: "42 passed" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/structured-output.test.ts -t "parses a verification array"`
Expected: FAIL — `out.verification` is `undefined`.

- [ ] **Step 3: Add the type**

In `src/types/output.ts`, after the `Action` interface, add:

```ts
/** A verification command run to prove a success claim. */
export interface VerificationEntry {
	/** Exact command executed (verbatim). */
	command: string;
	/** Outcome of the verification. */
	result: "pass" | "fail" | "skipped";
	/** Short observed evidence (e.g. "42 passed", exit 0). Truncate to ~300 chars. */
	evidence?: string;
}
```

In `interface FlowStructuredOutput`, after `commands: CommandEntry[];`:

```ts
	/** Verification commands run to substantiate the status. */
	verification: VerificationEntry[];
```

In `interface CompressedFlowResult`, after `commands?: CommandEntry[];`:

```ts
	/** Verification commands run to substantiate the status. */
	verification?: VerificationEntry[];
```

- [ ] **Step 4: Wire parsing in `structured-output.ts`**

In `src/snapshot/structured-output.ts`:

Add to the imported types (`import type { Action, CommandEntry, ... }`): `VerificationEntry`.

In `type StructuredOutputRecord`, after `commands?: CommandEntry[];`:

```ts
	verification?: VerificationEntry[];
```

In `isValidStructuredOutput`, add to the boolean chain (after the `commands` check):

```ts
			isOptionalArray(obj, "verification") &&
```

In the return object of `extractStructuredOutput`, after `commands: parsed.commands ?? [],`:

```ts
		verification: parsed.verification ?? [],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/structured-output.test.ts -t "parses a verification array"`
Expected: PASS

- [ ] **Step 6: Fix the compressed-result copy in the executor**

In `src/core/executor.ts` post-flow loop (after `if (so.commands.length > 0) compressed.commands = so.commands;`):

```ts
    if (so.verification.length > 0) compressed.verification = so.verification;
```

- [ ] **Step 7: Full suite + lint**

Run: `npm test && npm run lint`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/types/output.ts src/snapshot/structured-output.ts src/core/executor.ts tests/structured-output.test.ts
git commit -m "feat(output): add verification evidence to structured output (ADR 0006 E1)"
```

### Task 2.2: Emit the verification field in the structured directive

**Files:**
- Modify: `src/core/flow.ts:421-424` (the `## Structured Output` appendix)
- Test: `tests/structured-output.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/structured-output.test.ts`:

```ts
it("flags a complete status with no verification evidence", () => {
  const text = '```json\n{"version":"1","status":"complete","summary":"done"}\n```';
  const out = extractStructuredOutput(text);
  expect(out?.notes.some((n) => n.includes("no verification evidence"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/structured-output.test.ts -t "no verification evidence"`
Expected: FAIL — note not present.

- [ ] **Step 3: Add the parse-time flag (E2)**

In `src/snapshot/structured-output.ts`, in `extractStructuredOutput`, just before the `return {` of the sanitized object:

```ts
	const verification = parsed.verification ?? [];
	const notes = (parsed.notes ?? []).map((n) => String(n).trim());
	if (parsed.status === "complete" && verification.length === 0) {
		notes.push("⚠️ status=complete with no verification evidence (ADR 0006 E2)");
	}
```

Then change the returned object so it uses these locals: `verification,` and `notes,` (replace `notes: parsed.notes ?? [],` and `verification: parsed.verification ?? [],`).

- [ ] **Step 4: Update the directive text**

In `src/core/flow.ts`, replace the structured-output appendix string (currently the `End with a \`\`\`json block: { version, status, summary, files[], actions[], notDone[], nextSteps[], reasoning[], notes[] }...` line) with:

```ts
		directiveBody +=
			`\n\n## Structured Output\n` +
			`End with a \`\`\`json block: { version, status, summary, files[], actions[], verification[], notDone[], nextSteps[], reasoning[], notes[] }. ` +
			`When status is "complete", verification[] MUST list the exact command(s) run and their result ({command,result,evidence}). ` +
			`Commands auto-extracted; omit empty arrays. Keep snippets under 300 chars. List at most 10 items per array.`;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/structured-output.test.ts`
Expected: PASS (both verification tests).

- [ ] **Step 6: Full suite + lint, then commit**

Run: `npm test && npm run lint`

```bash
git add src/core/flow.ts src/snapshot/structured-output.ts tests/structured-output.test.ts
git commit -m "feat(flow): require verification evidence for complete status (ADR 0006 E2)"
```

---

## Phase 3 — Plan-artifact contract (B1, B2, B3)

`craft` emits a structured plan in `extensions.plan`; the executor persists it to `.pi/plans/`; `build`'s directive instructs it to consume the most recent plan and report per-task verification.

### Task 3.1: Define and validate the plan shape (B1)

**Files:**
- Modify: `src/types/output.ts` (add `PlanTask` / `FlowPlan`)
- Test: `tests/structured-output.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import type { FlowPlan } from "../src/types/output.js";

it("accepts a plan in extensions", () => {
  const plan: FlowPlan = { title: "X", tasks: [{ intent: "do", files: ["a.ts"], verify: "npm test", rollback: "git checkout a.ts" }] };
  const text = '```json\n' + JSON.stringify({ version: "1", status: "complete", summary: "s", verification: [{command:"npm test",result:"pass"}], extensions: { plan } }) + '\n```';
  const out = extractStructuredOutput(text);
  expect((out?.extensions?.plan as FlowPlan).tasks[0].verify).toBe("npm test");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/structured-output.test.ts -t "accepts a plan in extensions"`
Expected: FAIL — type `FlowPlan` does not exist.

- [ ] **Step 3: Add the types**

In `src/types/output.ts`, after `VerificationEntry`:

```ts
/** One ordered, independently-verifiable unit of an implementation plan. */
export interface PlanTask {
	/** What this task accomplishes (one line). */
	intent: string;
	/** Exact files this task creates or modifies. */
	files: string[];
	/** Exact command that proves this task is done. */
	verify: string;
	/** How to undo this task if it goes wrong. */
	rollback: string;
}

/** A craft-produced implementation plan handed to build. */
export interface FlowPlan {
	title: string;
	tasks: PlanTask[];
}
```

(`extensions` stays `Record<string, unknown>`; the plan rides in `extensions.plan`. No validator change needed — parsing already passes `extensions` through verbatim.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/structured-output.test.ts -t "accepts a plan in extensions"`
Expected: PASS

- [ ] **Step 5: Teach `craft` to emit it**

In `agents/craft.md`, append to the `rules:` block:

```
When this craft flow produces an implementation plan, also emit it in structured-output extensions as { plan: { title, tasks: [{ intent, files, verify, rollback }] } }. Each task must be independently verifiable by its verify command.
```

Mirror the same line into `.pi/agents/craft.md` (project copy) so local runs match.

- [ ] **Step 6: Full suite + lint, commit**

Run: `npm test && npm run lint`

```bash
git add src/types/output.ts agents/craft.md .pi/agents/craft.md tests/structured-output.test.ts
git commit -m "feat(craft): define FlowPlan artifact emitted via extensions (ADR 0006 B1)"
```

### Task 3.2: Persist craft plans to `.pi/plans/` (B2)

**Files:**
- Create: `src/snapshot/plan-artifact.ts`
- Modify: `src/core/executor.ts` (post-flow loop, ~line 452)
- Test: `tests/plan-artifact.test.ts`

- [ ] **Step 1: Verify `cwd` availability**

Run: `grep -n "cwd\|deps\." src/core/executor.ts | sed -n '1,30p'`
Expected: identify a project directory on `deps`. If none exists, thread `cwd` from the caller in `src/index.ts` before continuing (note it in the commit).

- [ ] **Step 2: Write the failing test**

Create `tests/plan-artifact.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePlanArtifact } from "../src/snapshot/plan-artifact.js";

describe("writePlanArtifact", () => {
  it("writes a markdown plan under .pi/plans and returns the path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-plan-"));
    const p = writePlanArtifact(cwd, { title: "My Plan", tasks: [{ intent: "i", files: ["a.ts"], verify: "npm test", rollback: "git co a.ts" }] });
    expect(p).toMatch(/\.pi\/plans\/\d+.*my-plan\.md$/);
    const files = readdirSync(join(cwd, ".pi", "plans"));
    expect(files).toHaveLength(1);
    expect(readFileSync(p, "utf8")).toContain("## Task 1: i");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/plan-artifact.test.ts`
Expected: FAIL — module `plan-artifact.js` not found.

- [ ] **Step 4: Implement the writer**

Create `src/snapshot/plan-artifact.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { FlowPlan } from "../types/output.js";

function slugify(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
}

/** Persist a craft plan to <cwd>/.pi/plans/<ts>-<slug>.md. Returns the absolute path. */
export function writePlanArtifact(cwd: string, plan: FlowPlan): string {
	const dir = path.join(cwd, ".pi", "plans");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${Date.now()}-${slugify(plan.title)}.md`);
	const body = [
		`# ${plan.title}`,
		"",
		...plan.tasks.flatMap((t, i) => [
			`## Task ${i + 1}: ${t.intent}`,
			`- Files: ${t.files.join(", ")}`,
			`- Verify: \`${t.verify}\``,
			`- Rollback: \`${t.rollback}\``,
			"",
		]),
	].join("\n");
	fs.writeFileSync(file, body, "utf8");
	return file;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/plan-artifact.test.ts`
Expected: PASS

- [ ] **Step 6: Call it from the executor**

In `src/core/executor.ts`, inside the `for (const result of results)` post-flow loop, after the `compressed` object is fully built (before the `flowResultCache` push), add:

```ts
    const plan = (so.extensions as { plan?: import("../types/output.js").FlowPlan } | undefined)?.plan;
    if (result.type === "craft" && plan?.tasks?.length && cwd) {
      try {
        const planPath = writePlanArtifact(cwd, plan);
        logInfo(`[pi-agent-flow] craft plan persisted: ${planPath}`);
      } catch (e) {
        logWarn(`[pi-agent-flow] failed to persist craft plan: ${String(e)}`);
      }
    }
```

Add the import at the top of `executor.ts`: `import { writePlanArtifact } from "../snapshot/plan-artifact.js";` (and ensure `logInfo`/`logWarn` are already imported — `logWarn` is used nearby; reuse the same logger module).

- [ ] **Step 7: Full suite + lint, commit**

Run: `npm test && npm run lint`

```bash
git add src/snapshot/plan-artifact.ts src/core/executor.ts tests/plan-artifact.test.ts
git commit -m "feat(executor): persist craft plans to .pi/plans (ADR 0006 B2)"
```

### Task 3.3: Teach `build` to consume the plan and report per-task (B3)

**Files:**
- Modify: `agents/build.md`, `.pi/agents/build.md`
- Test: `tests/agents.test.ts` (assert directive content present)

- [ ] **Step 1: Write the failing test**

Append to `tests/agents.test.ts`:

```ts
it("build flow instructs consuming the latest .pi/plans plan", () => {
  const { flows } = discoverFlows(process.cwd(), "bundled");
  const build = flows.find((f) => f.name === "build");
  expect(build?.systemPrompt).toMatch(/\.pi\/plans/);
  expect(build?.systemPrompt).toMatch(/per-task verification/i);
});
```

(Reuse the existing `discoverFlows` import already present in `tests/agents.test.ts`; check its current import line and match it.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agents.test.ts -t "consuming the latest"`
Expected: FAIL — string not in build prompt.

- [ ] **Step 3: Update the build flow**

In `agents/build.md`, add a step to the `workflow:` block after step `1 Analyze`:

```
1b Plan check: if .pi/plans/ has a recent plan for this work, read the newest file and treat its tasks as the authoritative task list; implement tasks in order
```

And add to the `rules:` block:

```
If a .pi/plans plan drives this build, report per-task verification: for each plan task run its verify command and record {command,result,evidence} in structured-output verification[]
```

Apply the identical edits to `.pi/agents/build.md`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/agents.test.ts -t "consuming the latest"`
Expected: PASS

- [ ] **Step 5: Full suite + lint, commit**

Run: `npm test && npm run lint`

```bash
git add agents/build.md .pi/agents/build.md tests/agents.test.ts
git commit -m "feat(build): consume craft plan artifact with per-task verification (ADR 0006 B3)"
```

---

## Phase 4 — Review-ingest loop + post-build gate (C1, C2, A2)

Adds a `revise` flow, wires `audit --failure--> revise`, and makes `build --success--> audit` a blocking (orchestrator-enforced) gate when `PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD` is set. Depends on Phase 1 (the `gate` field).

### Task 4.1: Create the `revise` flow (C1)

**Files:**
- Create: `agents/revise.md`, `.pi/agents/revise.md`
- Modify: `src/core/agents.ts` (tier switch, ~line 46-53)
- Test: `tests/agents.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("discovers a revise flow with flash tier", () => {
  const { flows } = discoverFlows(process.cwd(), "bundled");
  const revise = flows.find((f) => f.name === "revise");
  expect(revise).toBeTruthy();
  expect(revise?.tier).toBe("flash");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agents.test.ts -t "discovers a revise flow"`
Expected: FAIL — no `revise` flow.

- [ ] **Step 3: Create the flow file**

Create `agents/revise.md` (and an identical `.pi/agents/revise.md`):

```markdown
---
name: revise
description: Triage review or audit findings accept or reject each with rationale apply accepted fixes and re-verify
tools: batch bash find grep ls web
maxDepth: 0
tier: flash
---

mission: Ingest review or audit findings, decide each one on technical merit, apply only the accepted fixes, and prove the result. Treat conversation history as background only.

workflow:
1 Collect: gather the findings to triage (audit output, CodeRabbit comments, reviewer notes)
2 Triage: for each finding decide ACCEPT or REJECT with a one-line technical rationale; never accept on authority alone
3 Apply: implement only accepted fixes with the smallest safe change
4 Verify: run the relevant tests or checks and record exact command and result
5 Report: list each finding with decision, rationale, and (for accepted) the verification evidence

rules:
Decide on technical merit not on who raised the finding
Reject findings that are wrong or out of scope and say why
Do not expand scope beyond the findings under review
Record per-fix verification in structured-output verification[]
If a finding needs a broader redesign recommend craft instead of forcing a local patch
See _conventions for tmp scripts and batch reads
```

- [ ] **Step 4: Add the tier mapping**

In `src/core/agents.ts`, in the `getFlowTier` switch, add `revise` to the `flash` group (next to `case "build":` / `case "audit":`):

```ts
		case "build":
		case "audit":
		case "revise":
			return "flash";
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/agents.test.ts -t "discovers a revise flow"`
Expected: PASS

- [ ] **Step 6: Full suite + lint, commit**

Run: `npm test && npm run lint`

```bash
git add agents/revise.md .pi/agents/revise.md src/core/agents.ts tests/agents.test.ts
git commit -m "feat(flows): add revise flow for review-ingest (ADR 0006 C1)"
```

### Task 4.2: Wire `audit --failure--> revise` (C2)

**Files:**
- Modify: `src/core/transitions.ts:30-41`
- Test: `tests/transitions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("recommends revise after a failed audit", () => {
  const advice = getTransitionAdvice(
    [{ type: "audit", intent: "x" }],
    [{ type: "audit", exitCode: 1, messages: [] }],
  );
  expect(advice.join(" ")).toMatch(/\[revise\]/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/transitions.test.ts -t "after a failed audit"`
Expected: FAIL — no `[revise]` advice.

- [ ] **Step 3: Add the transition**

In `DEFAULT_TRANSITIONS`, add (and adjust the existing `audit --failure--> build` advice to point at revise as primary):

```ts
	{ from: "audit", to: "revise", on: "failure", advice: "Audit found issues. Consider running a [revise] flow to triage and fix them, then re-audit." },
```

(Keep the existing `audit -> build` entry; both are advisory and order is matrix order.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/transitions.test.ts -t "after a failed audit"`
Expected: PASS

- [ ] **Step 5: Full suite + lint, commit**

Run: `npm test && npm run lint`

```bash
git add src/core/transitions.ts tests/transitions.test.ts
git commit -m "feat(transitions): route failed audit to revise (ADR 0006 C2)"
```

### Task 4.3: Configurable post-build audit gate (A2)

**Files:**
- Modify: `src/core/transitions.ts` (env-driven gate marking + REQUIRED rendering), `src/core/executor.ts` (consume gate flag)
- Test: `tests/transitions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("upgrades build->audit to a REQUIRED gate when env is set", () => {
  const prev = process.env.PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD;
  process.env.PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD = "1";
  try {
    const advice = getTransitionAdvice(
      [{ type: "build", intent: "x" }],
      [{ type: "build", exitCode: 0, sawAgentEnd: true, messages: [] }],
    );
    expect(advice.join(" ")).toMatch(/REQUIRED/);
  } finally {
    if (prev === undefined) delete process.env.PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD;
    else process.env.PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD = prev;
  }
});

it("leaves build->audit advisory when env is unset", () => {
  delete process.env.PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD;
  const advice = getTransitionAdvice(
    [{ type: "build", intent: "x" }],
    [{ type: "build", exitCode: 0, sawAgentEnd: true, messages: [] }],
  );
  expect(advice.join(" ")).not.toMatch(/REQUIRED/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/transitions.test.ts -t "REQUIRED gate"`
Expected: FAIL — no REQUIRED rendering.

- [ ] **Step 3: Implement env-driven gating**

In `src/core/transitions.ts`, add a helper mirroring the existing `PI_FLOW_SKIP_STRUCTURED_DIRECTIVE` parse style used in `flow.ts`:

```ts
function envFlag(name: string): boolean {
	const v = process.env[name];
	return v !== undefined && ["1", "true", "yes"].includes(v.trim().toLowerCase());
}

/** Apply env-driven gate overrides to a transition matrix (non-mutating). */
export function withEnvGates(transitions: FlowTransition[]): FlowTransition[] {
	const gateBuildAudit = envFlag("PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD");
	if (!gateBuildAudit) return transitions;
	return transitions.map((t) =>
		t.from === "build" && t.to === "audit" && t.on === "success"
			? { ...t, gate: true }
			: t,
	);
}
```

In `getTransitionAdvice`, change the default param and render gated entries with a REQUIRED prefix:

- Replace the signature default `transitions: FlowTransition[] = DEFAULT_TRANSITIONS,` with `transitions: FlowTransition[] = withEnvGates(DEFAULT_TRANSITIONS),`.
- Where it does `advisors.push(t.advice);`, change to:

```ts
			advisors.push(t.gate ? `REQUIRED (gate): ${t.advice}` : t.advice);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/transitions.test.ts -t "REQUIRED gate"` then `-t "advisory when env is unset"`
Expected: PASS both.

- [ ] **Step 5: Regression — default behavior unchanged**

Run: `npm test`
Expected: PASS — all existing `tests/transitions.test.ts` advisory assertions still green (env unset path returns the original matrix).

- [ ] **Step 6: Lint + commit**

Run: `npm run lint`

```bash
git add src/core/transitions.ts tests/transitions.test.ts
git commit -m "feat(transitions): PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD gate, default off (ADR 0006 A2)"
```

### Task 4.4: Document env var + update ADR status note

**Files:**
- Modify: `CLAUDE.md` (Environment Variables table), `doc/adr/0006-...md` (no status flip — still Proposed; add an implementation-progress note under Consequences only if the project ADR policy allows annotating Proposed ADRs; it does)

- [ ] **Step 1: Add env var to the table**

In `CLAUDE.md` Environment Variables table, add a row:

```markdown
| `PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD` | Marks `build → audit` as a REQUIRED gate (orchestrator must run audit). Default off. |
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD (ADR 0006 A2)"
```

---

## Self-Review

**Spec coverage (ADR 0006 P1 items):**
- B1 → Task 3.1 · B2 → Task 3.2 · B3 → Task 3.3
- C1 → Task 4.1 · C2 → Task 4.2
- E1 → Task 2.1 · E2 → Task 2.2
- A3 → Task 1.1 · A2 → Task 4.3
- H2 → Task 1.2 (+ env doc Task 4.4)
All ten P1 items mapped. No gaps.

**Type consistency:** `VerificationEntry` (2.1) reused by `FlowPlan.tasks[].verify` semantics (3.1) and the build per-task report (3.3). `FlowTransition.gate` defined in 1.1, consumed in 4.3. `FlowPlan` defined in 3.1, consumed in 3.2 (`writePlanArtifact`) and 3.3 (build directive). `withEnvGates`/`envFlag` mirror the existing `PI_FLOW_SKIP_STRUCTURED_DIRECTIVE` pattern in `flow.ts`.

**Placeholder scan:** No TBD/TODO; every code step contains literal code; commands have expected output. Two flagged uncertainties are surfaced as explicit assumptions (A1 gate semantics, A3 executor `cwd`) with a verification step (3.2 Step 1) rather than left as placeholders.

**Phase independence:** Phase 1 (no behavior change) ships alone. Phase 2 ships alone. Phase 3 depends only on E1's shape (soft). Phase 4 depends on Phase 1's `gate` field. Each phase ends green and is independently revertable.

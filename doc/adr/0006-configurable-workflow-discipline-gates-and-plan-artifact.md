# 6. Configurable Workflow Discipline Gates and Plan Artifact

Date: 2026-05-17

## Status

Proposed

## Context

A comparison of the pi-agent-flow flow taxonomy against the Superpowers
Claude Code pipeline (brainstorm → worktree → plan → execute → per-task
review → verify → finish) surfaced a consistent pattern: pi-agent-flow
already implements the *topology* of a disciplined AI engineering workflow
(observe → design → build → audit, with debug as a branch) and matches or
exceeds Superpowers on `debug` rigor, adversarial `audit`, process-fork
isolation, depth/cycle guards, and per-flow model-tier economy.

Where it diverges is **enforcement**. Every Superpowers hard gate is, in
pi-agent-flow, an advisory transition the orchestrator may skip:

- `transitions.ts` emits suggestions ("Consider running an [audit] flow…"),
  never blocks. `build` can commit/push to green CI with no audit or review
  gate firing.
- No human design-approval gate exists before implementation.
- TDD in `build` is "write or identify a failing test when practical" —
  soft, not test-first/verify-fail-first.
- The `audit → fix` loop dead-ends at a generic "recommend build"
  recommendation; there is no structured analogue to receiving and
  triaging code-review feedback.
- `craft` produces a prose plan, not a machine-checkable artifact, so the
  `craft → build` handoff has no contract and no per-task verification.
- Success claims are made per-flow without a uniform verification-evidence
  requirement.

This divergence is partly intentional. pi-agent-flow's identity is an
*advisory router with autonomous workers*, not an enforced linear pipeline.
Converting it wholesale into Superpowers' mandatory model would break the
orchestrator's routing flexibility and existing usage. The opportunity is
to add discipline as **opt-in, configurable capability that reuses existing
machinery** (structured output, the transition matrix, the `.pi/` artifact
convention, timed-bash verbatim capture) rather than new subsystems.

This track is broad, so it can ship in coherent slices while this ADR
remains Proposed until all acceptance criteria are met.

## Decision

Adopt a Workflow Discipline track that strengthens pipeline rigor while
preserving the advisory-router model. Default behavior is unchanged;
discipline is enabled by configuration. Implement incrementally:

1. **Structured plan artifact (`craft → build` contract).** Define a plan
   schema — ordered tasks, each with intent, target files, a verification
   command, and a rollback note. `craft` emits it via structured output and
   persists it to `.pi/plans/<timestamp>-<slug>.md` (mirroring
   `.pi/flow-reports/`). `build` consumes the plan as its task list and
   reports per-task pass/fail against each verification command.

2. **Verification-evidence requirement.** Add a uniform `verification`
   block to structured output for `build`, `debug`, and `audit`: the exact
   command run and its observed result, enriched from the existing
   timed-bash verbatim capture (`generateCommandsFromHistory`). At parse
   time, `extractStructuredOutput()` flags any result that claims success
   without verification evidence.

3. **Review-ingest capability.** Introduce a review-ingest mode (a `revise`
   flow or a `build` sub-mode) that takes `audit`/CodeRabbit findings,
   triages each (accept/reject with rationale), applies accepted fixes, and
   re-verifies. Wire an `audit --failure--> revise` transition so the
   review loop no longer dead-ends.

4. **Configurable blocking gates.** Add a `gate: boolean` field to
   `FlowTransition` so specific transitions become blocking when enabled.
   Expose, all defaulting to off:
   - `PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD` — gate `build`'s ship step on an
     `audit` pass over the diff.
   - `PI_FLOW_REQUIRE_DESIGN_GATE` — for tasks above a complexity
     threshold, require `craft`/`ideas` plus an orchestrator-surfaced
     Decision-Required design block before `build`.

5. **TDD rigor.** Strengthen `build` to enforce test-first and
   verify-fail-first when the change is testable; retain a "not practically
   testable" escape that requires an explicit stated justification in the
   structured output.

6. **No-mutation enforcement.** `scout`, `ideas`, and `craft` must report
   zero file writes; violations are flagged at parse time.

7. **Documentation.** Document the advisory-vs-blocking model and the new
   configuration surface explicitly in the CLAUDE.md Flow Taxonomy.

Lower-priority items captured but deferred: a structured completion-decision
block for `build` (merge/PR/leave), a parallel-dispatch heuristic doc, and
routing-adherence telemetry (advice emitted vs. orchestrator action,
optionally recorded to git notes).

Explicitly out of scope: mandatory-by-default gating, git-worktree-per-flow
isolation (process-fork isolation already covers the safety need), and any
new plan DSL or workflow engine.

## Acceptance Criteria

This ADR may move to Accepted when:

- `craft` emits and persists a schema-valid plan artifact that `build`
  consumes and reports per-task verification results against.
- Structured output for `build`/`debug`/`audit` carries a verification
  block, and success claims without verification evidence are flagged at
  parse time.
- A review-ingest path exists and the `audit --failure--> revise`
  transition is wired and exercised.
- `FlowTransition` supports a blocking `gate` flag, and
  `PI_FLOW_REQUIRE_AUDIT_AFTER_BUILD` and `PI_FLOW_REQUIRE_DESIGN_GATE`
  work end to end with default-off behavior verified to be unchanged.
- `build` enforces test-first/verify-fail-first with a justified escape
  hatch, and no-mutation flows are verified to report and enforce zero
  writes.
- The advisory-vs-blocking model and configuration surface are documented
  in CLAUDE.md.

## Consequences

- Teams that want Superpowers-grade discipline can opt in; default users
  keep the lightweight advisory-router behavior unchanged.
- The `craft → build` handoff becomes a checkable contract, reducing
  plan/implementation drift and enabling per-task verification.
- The `audit → revise` loop closes, so review findings are acted on with
  rationale instead of dead-ending at a recommendation.
- Uniform verification evidence makes "done" claims auditable and reduces
  false-success reporting.
- Added configuration surface and a new flow/mode increase the testing
  matrix; default-off paths must be regression-tested to prove the
  baseline router behavior is untouched.
- Reusing structured output, the transition matrix, and `.pi/` artifacts
  avoids new subsystems but couples these features to those formats;
  schema changes must remain backward compatible.

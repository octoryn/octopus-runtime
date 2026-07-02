import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decide,
  AutonomyLevel,
  ManualClock,
  type Policy,
  type PolicyContext,
  type PolicyRuling,
  type PlannedAction
} from "../src/index.js";

function policy(id: string, ruling: PolicyRuling): Policy {
  return { id, evaluate: () => ruling };
}

function contextFor(requestedAutonomy: AutonomyLevel): PolicyContext {
  const action: PlannedAction = {
    ref: "a1",
    connectorId: "probe",
    actionType: "probe.act",
    requestedAutonomy,
    input: {}
  };
  return {
    event: { id: "e", source: "test", occurredAt: "2020-01-01T00:00:00.000Z", payload: {} },
    action,
    runId: "run-1",
    workflowId: "wf",
    clock: new ManualClock()
  };
}

test("no policies leaves the requested autonomy unchanged", async () => {
  const decision = await decide([], contextFor(AutonomyLevel.Autonomous));
  assert.equal(decision.effectiveAutonomy, AutonomyLevel.Autonomous);
  assert.equal(decision.requiresApproval, false);
  assert.equal(decision.denied, undefined);
});

test("a policy can lower autonomy", async () => {
  const decision = await decide(
    [policy("cap-draft", { cap: AutonomyLevel.Draft })],
    contextFor(AutonomyLevel.Autonomous)
  );
  assert.equal(decision.effectiveAutonomy, AutonomyLevel.Draft);
  assert.deepEqual(decision.appliedPolicies, ["cap-draft"]);
});

test("a policy can NEVER raise autonomy above what was requested", async () => {
  const decision = await decide(
    [policy("try-raise", { cap: AutonomyLevel.Autonomous })],
    contextFor(AutonomyLevel.Shadow)
  );
  // Requested Shadow; a policy asking for Autonomous contributes nothing.
  assert.equal(decision.effectiveAutonomy, AutonomyLevel.Shadow);
  assert.deepEqual(decision.appliedPolicies, []);
});

test("most restrictive policy wins, regardless of order", async () => {
  const capDraft = policy("cap-draft", { cap: AutonomyLevel.Draft });
  const capObserve = policy("cap-observe", { cap: AutonomyLevel.Observe });

  const forward = await decide([capDraft, capObserve], contextFor(AutonomyLevel.Autonomous));
  const reverse = await decide([capObserve, capDraft], contextFor(AutonomyLevel.Autonomous));

  assert.equal(forward.effectiveAutonomy, AutonomyLevel.Observe);
  assert.equal(reverse.effectiveAutonomy, AutonomyLevel.Observe);
});

test("adding a policy can only tighten, never loosen (monotonicity)", async () => {
  const base = await decide([policy("cap-draft", { cap: AutonomyLevel.Draft })], contextFor(AutonomyLevel.Autonomous));
  const withMore = await decide(
    [
      policy("cap-draft", { cap: AutonomyLevel.Draft }),
      policy("cap-observe", { cap: AutonomyLevel.Observe }),
      policy("try-raise", { cap: AutonomyLevel.Autonomous })
    ],
    contextFor(AutonomyLevel.Autonomous)
  );
  // The extra policies can only lower (Observe) or no-op (raise attempt).
  assert.equal(base.effectiveAutonomy, AutonomyLevel.Draft);
  assert.equal(withMore.effectiveAutonomy, AutonomyLevel.Observe);
});

test("deny is recorded and sticky to the first denier", async () => {
  const decision = await decide(
    [policy("a", {}), policy("b", { deny: "not allowed" }), policy("c", { deny: "also no" })],
    contextFor(AutonomyLevel.Autonomous)
  );
  assert.equal(decision.denied, "not allowed");
});

test("requireApproval is surfaced and constraints accumulate", async () => {
  const decision = await decide(
    [
      policy("approval", { requireApproval: true }),
      policy("limits", {
        constraints: [{ type: "rate_limit", detail: { perHour: 10 } }]
      })
    ],
    contextFor(AutonomyLevel.Autonomous)
  );
  assert.equal(decision.requiresApproval, true);
  assert.equal(decision.constraints.length, 1);
  assert.equal(decision.constraints[0]?.type, "rate_limit");
});

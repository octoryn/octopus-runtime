import { test } from "node:test";
import assert from "node:assert/strict";

import { AutonomyLevel } from "../src/index.js";
import { probeConnector, singleActionWorkflow, testEvent, makeRuntime } from "./helpers.js";

test("an autonomous run emits an audit record at every boundary, in order", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Autonomous })]
  );

  const run = await runtime.run("wf", testEvent());
  const trail = await runtime.read.getAuditTrail(run.id);
  const events = trail.map((r) => r.event);

  assert.deepEqual(events, [
    "trigger.received",
    "condition.evaluated",
    "plan.created",
    "policy.decided",
    "gate.routed",
    "render.succeeded",
    "execute.succeeded",
    "result.recorded"
  ]);

  // Every record is scoped to this run.
  assert.ok(trail.every((r) => r.runId === run.id));

  const boundaries = new Set(trail.map((r) => r.boundary));
  for (const expected of [
    "trigger",
    "condition",
    "plan",
    "policy",
    "autonomy_gate",
    "connector_render",
    "connector_execute",
    "result"
  ]) {
    assert.ok(boundaries.has(expected as never), `missing boundary: ${expected}`);
  }
});

test("audit timestamps are non-decreasing", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Autonomous })]
  );

  const run = await runtime.run("wf", testEvent());
  const trail = await runtime.read.getAuditTrail(run.id);

  for (let i = 1; i < trail.length; i += 1) {
    assert.ok((trail[i]?.at ?? "") >= (trail[i - 1]?.at ?? ""), "audit records must be time-ordered");
  }
});

test("the draft + approval flow is fully audited", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime([probe.connector], [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Draft })]);

  const run = await runtime.run("wf", testEvent());
  const approvalId = run.results[0]?.approvalId as string;
  await runtime.resolveApproval(approvalId, { approved: true, decidedBy: "ops" });

  const events = (await runtime.read.getAuditTrail(run.id)).map((r) => r.event);

  // Draft phase creates an approval and does not execute.
  assert.ok(events.includes("approval.created"));
  // Resolution phase records the decision and the resulting execution.
  assert.ok(events.includes("approval.decided"));
  assert.ok(events.includes("execute.succeeded"));

  // approval.created precedes approval.decided precedes the execution.
  assert.ok(events.indexOf("approval.created") < events.indexOf("approval.decided"));
  assert.ok(events.indexOf("approval.decided") < events.lastIndexOf("execute.succeeded"));
});

test("the approval flow's audit is monotonic in `at` and logically ordered", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime([probe.connector], [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Draft })]);

  const run = await runtime.run("wf", testEvent());
  const approvalId = run.results[0]?.approvalId as string;
  await runtime.resolveApproval(approvalId, { approved: true, decidedBy: "ops" });

  const trail = await runtime.read.getAuditTrail(run.id);

  // `at` never goes backwards across the whole trail (incl. the resolution).
  for (let i = 1; i < trail.length; i += 1) {
    assert.ok(
      (trail[i]?.at ?? "") >= (trail[i - 1]?.at ?? ""),
      `audit at index ${i} (${trail[i]?.event}) went backwards in time`
    );
  }

  // The decision precedes the execution it authorized, which precedes the result.
  const events = trail.map((r) => r.event);
  assert.ok(events.indexOf("approval.decided") < events.indexOf("execute.succeeded"));
  assert.ok(events.indexOf("execute.succeeded") < events.lastIndexOf("result.recorded"));
});

test("a halted run still audits the trigger and condition boundaries", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [
      singleActionWorkflow({
        requestedAutonomy: AutonomyLevel.Autonomous,
        conditions: [{ id: "never", test: () => false }]
      })
    ]
  );

  const run = await runtime.run("wf", testEvent());
  const events = (await runtime.read.getAuditTrail(run.id)).map((r) => r.event);

  assert.deepEqual(events, ["trigger.received", "condition.evaluated"]);
  assert.equal(run.status, "halted");
});

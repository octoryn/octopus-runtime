import { test } from "node:test";
import assert from "node:assert/strict";

import { AutonomyLevel } from "../src/index.js";
import { probeConnector, singleActionWorkflow, testEvent, makeRuntime } from "./helpers.js";

test("Draft renders and creates a pending approval but does not execute", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime([probe.connector], [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Draft })]);

  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "drafted");
  assert.ok(result?.approvalId, "an approval id is recorded");
  assert.equal(probe.renderCalls, 1);
  assert.equal(probe.executeCalls, 0, "execution must not happen before approval");

  const pending = await runtime.read.listPendingApprovals();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.status, "pending");
});

test("approving a draft executes exactly once", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime([probe.connector], [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Draft })]);

  const run = await runtime.run("wf", testEvent());
  const approvalId = run.results[0]?.approvalId;
  assert.ok(approvalId);
  assert.equal(probe.executeCalls, 0);

  const executed = await runtime.resolveApproval(approvalId, {
    approved: true,
    decidedBy: "ops@example.com"
  });

  assert.equal(executed.outcome, "executed");
  assert.equal(probe.executeCalls, 1);
  assert.deepEqual(executed.effectRefs, [{ kind: "probe.effect", id: "e1" }]);

  // The stored result is updated in place from drafted -> executed.
  const stored = await runtime.read.getResult(run.id, "a1");
  assert.equal(stored?.outcome, "executed");

  // No approvals remain pending.
  assert.equal((await runtime.read.listPendingApprovals()).length, 0);
});

test("rejecting a draft never executes", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime([probe.connector], [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Draft })]);

  const run = await runtime.run("wf", testEvent());
  const approvalId = run.results[0]?.approvalId;
  assert.ok(approvalId);

  const rejected = await runtime.resolveApproval(approvalId, {
    approved: false,
    decidedBy: "ops@example.com",
    note: "not now"
  });

  assert.equal(rejected.outcome, "rejected");
  assert.equal(probe.executeCalls, 0);

  const approval = await runtime.read.getApproval(approvalId);
  assert.equal(approval?.status, "rejected");
  assert.equal(approval?.note, "not now");
});

test("an approval cannot be resolved twice", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime([probe.connector], [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Draft })]);

  const run = await runtime.run("wf", testEvent());
  const approvalId = run.results[0]?.approvalId as string;

  await runtime.resolveApproval(approvalId, { approved: true, decidedBy: "a" });

  await assert.rejects(
    () => runtime.resolveApproval(approvalId, { approved: true, decidedBy: "b" }),
    /already approved/
  );
  assert.equal(probe.executeCalls, 1, "a second resolve must not execute again");
});

test("concurrent resolutions of the same approval execute at most once", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime([probe.connector], [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Draft })]);

  const run = await runtime.run("wf", testEvent());
  const approvalId = run.results[0]?.approvalId as string;

  // Fire two resolutions concurrently; exactly one must win.
  const settled = await Promise.allSettled([
    runtime.resolveApproval(approvalId, { approved: true, decidedBy: "a" }),
    runtime.resolveApproval(approvalId, { approved: true, decidedBy: "b" })
  ]);

  const fulfilled = settled.filter((s) => s.status === "fulfilled");
  assert.equal(fulfilled.length, 1, "only one resolution succeeds");
  assert.equal(probe.executeCalls, 1, "execute runs exactly once");
});

test("requireApproval downgrades Autonomous to a Draft approval", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [
      singleActionWorkflow({
        requestedAutonomy: AutonomyLevel.Autonomous,
        policies: [{ id: "needs-approval", evaluate: () => ({ requireApproval: true }) }]
      })
    ]
  );

  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "drafted");
  assert.equal(probe.executeCalls, 0);
});

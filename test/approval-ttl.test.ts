import { test } from "node:test";
import assert from "node:assert/strict";

import { createRuntime, AutonomyLevel, ManualClock, ConfigurationError } from "../src/index.js";
import { probeConnector, singleActionWorkflow, testEvent } from "./helpers.js";

/** A runtime with a TTL and a clock the test can advance. */
function ttlRuntime(ttlMs: number) {
  const probe = probeConnector();
  const clock = new ManualClock();
  const runtime = createRuntime({
    connectors: [probe.connector],
    workflows: [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Draft })],
    clock,
    approvalTtlMs: ttlMs
  });
  return { probe, clock, runtime };
}

test("a draft approval records an expiry deadline", async () => {
  const { runtime } = ttlRuntime(100_000);
  await runtime.run("wf", testEvent());
  const [approval] = await runtime.read.listPendingApprovals();
  assert.ok(approval?.expiresAt, "expiresAt is set when a TTL is configured");
});

test("sweeping expires overdue approvals fail-closed, without executing", async () => {
  const { probe, clock, runtime } = ttlRuntime(100_000);
  const run = await runtime.run("wf", testEvent());
  const approvalId = run.results[0]?.approvalId as string;

  clock.advance(200_000); // well past the TTL
  const expired = await runtime.sweepExpiredApprovals();

  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.outcome, "expired");
  assert.equal(probe.executeCalls, 0, "an expired approval never executes");

  const approval = await runtime.read.getApproval(approvalId);
  assert.equal(approval?.status, "expired");
  assert.equal((await runtime.read.listPendingApprovals()).length, 0);

  // The stored per-action result reflects the expiry.
  const result = await runtime.read.getResult(run.id, "a1");
  assert.equal(result?.outcome, "expired");
});

test("approving after the deadline is refused fail-closed (lazy expiry)", async () => {
  const { probe, clock, runtime } = ttlRuntime(100_000);
  const run = await runtime.run("wf", testEvent());
  const approvalId = run.results[0]?.approvalId as string;

  clock.advance(200_000);

  // No explicit sweep — resolving an overdue approval expires it rather than executing.
  const result = await runtime.resolveApproval(approvalId, { approved: true, decidedBy: "ops" });
  assert.equal(result.outcome, "expired");
  assert.equal(probe.executeCalls, 0);
});

test("approving before the deadline still executes normally", async () => {
  const { probe, runtime } = ttlRuntime(100_000);
  const run = await runtime.run("wf", testEvent());
  const approvalId = run.results[0]?.approvalId as string;

  const result = await runtime.resolveApproval(approvalId, { approved: true, decidedBy: "ops" });
  assert.equal(result.outcome, "executed");
  assert.equal(probe.executeCalls, 1);
});

test("an already-expired approval cannot be resolved again", async () => {
  const { clock, runtime } = ttlRuntime(100_000);
  const run = await runtime.run("wf", testEvent());
  const approvalId = run.results[0]?.approvalId as string;

  clock.advance(200_000);
  await runtime.sweepExpiredApprovals();

  await assert.rejects(
    () => runtime.resolveApproval(approvalId, { approved: true, decidedBy: "ops" }),
    ConfigurationError
  );
});

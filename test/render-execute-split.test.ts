import { test } from "node:test";
import assert from "node:assert/strict";

import { AutonomyLevel } from "../src/index.js";
import { probeConnector, singleActionWorkflow, testEvent, makeRuntime } from "./helpers.js";

test("Shadow uses render only — an execute that would throw is never reached", async () => {
  // execute is rigged to throw; if the engine ever calls it in Shadow, the
  // outcome would be `failed` instead of `predicted`.
  const probe = probeConnector({ executeThrows: true });
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Shadow })],
  );

  const run = await runtime.run("wf", testEvent());
  assert.equal(run.results[0]?.outcome, "predicted");
  assert.equal(probe.executeCalls, 0);
});

test("Draft uses render only — a throwing execute is never reached until approval", async () => {
  const probe = probeConnector({ executeThrows: true });
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Draft })],
  );

  const run = await runtime.run("wf", testEvent());
  assert.equal(run.results[0]?.outcome, "drafted");
  assert.equal(probe.executeCalls, 0);
});

test("render is pure: its payload is what execute later receives", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Autonomous, value: "abc" })],
  );

  const run = await runtime.run("wf", testEvent());
  const rendered = run.results[0]?.rendered;
  assert.deepEqual(rendered?.payload, { value: "abc" });
  assert.equal(rendered?.preview, "probe:abc");
});

test("execute is reached only on the Autonomous path", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Autonomous })],
  );

  await runtime.run("wf", testEvent());
  assert.equal(probe.renderCalls, 1);
  assert.equal(probe.executeCalls, 1);
});

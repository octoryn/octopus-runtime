import { test } from "node:test";
import assert from "node:assert/strict";

import { AutonomyLevel } from "../src/index.js";
import { probeConnector, singleActionWorkflow, testEvent, makeRuntime } from "./helpers.js";

test("Observe records nothing: no render, no execute", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Observe })],
  );

  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "observed");
  assert.equal(result?.rendered, undefined);
  assert.equal(probe.renderCalls, 0);
  assert.equal(probe.executeCalls, 0);
});

test("Shadow renders a prediction but never executes", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Shadow, value: "hi" })],
  );

  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "predicted");
  assert.equal(result?.rendered?.preview, "probe:hi");
  assert.equal(probe.renderCalls, 1);
  assert.equal(probe.executeCalls, 0);
});

test("Autonomous renders and executes", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Autonomous })],
  );

  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "executed");
  assert.equal(probe.renderCalls, 1);
  assert.equal(probe.executeCalls, 1);
  assert.deepEqual(result?.effectRefs, [{ kind: "probe.effect", id: "e1" }]);
  assert.deepEqual(result?.output, { ok: true });
});

test("effectiveAutonomy on the result reflects the applied level", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Shadow })],
  );

  const run = await runtime.run("wf", testEvent());
  assert.equal(run.results[0]?.effectiveAutonomy, AutonomyLevel.Shadow);
  assert.equal(run.results[0]?.requestedAutonomy, AutonomyLevel.Shadow);
});

test("a policy denial stops before render or execute", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [
      singleActionWorkflow({
        requestedAutonomy: AutonomyLevel.Autonomous,
        policies: [{ id: "block", evaluate: () => ({ deny: "blocked" }) }],
      }),
    ],
  );

  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "denied");
  assert.equal(result?.reason, "blocked");
  assert.equal(probe.renderCalls, 0);
  assert.equal(probe.executeCalls, 0);
});

test("a policy capping Autonomous to Shadow prevents execution", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [
      singleActionWorkflow({
        requestedAutonomy: AutonomyLevel.Autonomous,
        policies: [{ id: "cap", evaluate: () => ({ cap: AutonomyLevel.Shadow }) }],
      }),
    ],
  );

  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "predicted");
  assert.equal(result?.effectiveAutonomy, AutonomyLevel.Shadow);
  assert.equal(probe.executeCalls, 0);
});

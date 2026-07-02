import { test } from "node:test";
import assert from "node:assert/strict";

import { AutonomyLevel, defineConnector, defineAction, schema as s } from "../src/index.js";
import {
  probeConnector,
  singleActionWorkflow,
  planWorkflow,
  testEvent,
  makeRuntime,
} from "./helpers.js";

test("a throwing execute yields a failed result with the error recorded", async () => {
  const probe = probeConnector({ executeThrows: true });
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Autonomous })],
  );

  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "failed");
  assert.equal(result?.reason, "execute_failed");
  assert.equal(result?.error?.message, "execute boom");
});

test("a throwing render yields a failed result and never executes", async () => {
  const probe = probeConnector({ renderThrows: true });
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Autonomous })],
  );

  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "failed");
  assert.equal(result?.reason, "render_failed");
  assert.equal(probe.executeCalls, 0);
});

test("invalid input fails closed before render", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [
      planWorkflow({
        actions: [
          {
            ref: "a1",
            connectorId: "probe",
            actionType: "probe.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { value: 123 }, // schema requires a string
          },
        ],
      }),
    ],
  );

  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "failed");
  assert.equal(result?.reason, "input_validation_failed");
  assert.equal(probe.renderCalls, 0);
  assert.equal(probe.executeCalls, 0);
});

test("a throwing condition halts the run fail-closed", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [
      singleActionWorkflow({
        requestedAutonomy: AutonomyLevel.Autonomous,
        conditions: [
          {
            id: "boom",
            test: () => {
              throw new Error("condition boom");
            },
          },
        ],
      }),
    ],
  );

  const run = await runtime.run("wf", testEvent());

  assert.equal(run.status, "halted");
  assert.equal(run.haltedReason, "condition_not_met");
  assert.equal(run.results.length, 0);
  assert.equal(probe.renderCalls, 0);
});

test("a dependent action is skipped when its dependency fails (fail-closed)", async () => {
  const probe = probeConnector({ executeThrows: true });
  const runtime = makeRuntime(
    [probe.connector],
    [
      planWorkflow({
        actions: [
          {
            ref: "first",
            connectorId: "probe",
            actionType: "probe.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { value: "a" },
          },
          {
            ref: "second",
            connectorId: "probe",
            actionType: "probe.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { value: "b" },
            dependsOn: ["first"],
          },
        ],
      }),
    ],
  );

  const run = await runtime.run("wf", testEvent());

  assert.equal(run.results[0]?.outcome, "failed");
  assert.equal(run.results[1]?.outcome, "skipped");
  assert.match(run.results[1]?.reason ?? "", /dependency_unsatisfied: first/);
  // second never rendered or executed
  assert.equal(probe.renderCalls, 1);
  assert.equal(probe.executeCalls, 1);
});

test("a throwing policy fails closed to a denial without aborting the run", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [
      planWorkflow({
        policies: [
          {
            id: "boom-on-second",
            evaluate: ({ action }) => {
              if (action.ref === "second") throw new Error("policy boom");
              return {};
            },
          },
        ],
        actions: [
          {
            ref: "first",
            connectorId: "probe",
            actionType: "probe.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { value: "a" },
          },
          {
            ref: "second",
            connectorId: "probe",
            actionType: "probe.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { value: "b" },
          },
        ],
      }),
    ],
  );

  const run = await runtime.run("wf", testEvent());

  // The run completed and was persisted — the earlier effect is never orphaned.
  assert.equal(run.status, "completed");
  assert.ok(await runtime.read.getRun(run.id), "run record is persisted");

  assert.equal(run.results[0]?.outcome, "executed");
  assert.equal(run.results[1]?.outcome, "denied");
  assert.match(run.results[1]?.reason ?? "", /policy_evaluation_failed: policy boom/);
  // The failing policy prevented the second effect from firing.
  assert.equal(probe.executeCalls, 1);
});

test("non-cloneable execute output is sanitized so the run still persists", async () => {
  const weird = defineConnector({
    id: "weird",
    version: "1.0.0",
    actions: [
      defineAction({
        type: "weird.act",
        input: s.object({}),
        render: () => ({ preview: "weird", payload: {} }),
        // Returns a value structuredClone cannot handle (a function).
        execute: () => ({
          output: { fn: () => 42 },
          effectRefs: [{ kind: "weird.effect", id: "w1" }],
        }),
      }),
    ],
  });

  const runtime = makeRuntime(
    [weird],
    [
      planWorkflow({
        actions: [
          {
            ref: "a1",
            connectorId: "weird",
            actionType: "weird.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: {},
          },
        ],
      }),
    ],
  );

  const run = await runtime.run("wf", testEvent());

  assert.equal(run.results[0]?.outcome, "executed");
  assert.deepEqual(run.results[0]?.output, {
    unrecordable: true,
    reason: "execute output is not structured-cloneable",
  });
  // effectRefs (plain data) survive, and the run is retrievable.
  assert.equal(run.results[0]?.effectRefs?.[0]?.id, "w1");
  const stored = await runtime.read.getRun(run.id);
  assert.ok(stored, "run persisted despite exotic output");
});

test("an independent sibling still runs after another action fails", async () => {
  const probe = probeConnector();
  // Rig only the FIRST action to fail by using a distinct throwing connector.
  const failing = probeConnector({ executeThrows: true });
  // Give the failing connector a different id so both can register.
  const failingConnector = {
    ...failing.connector,
    id: "probe-fail",
  };

  const runtime = makeRuntime(
    [probe.connector, failingConnector],
    [
      planWorkflow({
        actions: [
          {
            ref: "boom",
            connectorId: "probe-fail",
            actionType: "probe.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { value: "x" },
          },
          {
            ref: "ok",
            connectorId: "probe",
            actionType: "probe.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { value: "y" },
          },
        ],
      }),
    ],
  );

  const run = await runtime.run("wf", testEvent());
  assert.equal(run.results[0]?.outcome, "failed");
  assert.equal(run.results[1]?.outcome, "executed");
});

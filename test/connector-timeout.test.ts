import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRuntime,
  defineConnector,
  defineAction,
  defineWorkflow,
  matchSource,
  AutonomyLevel,
  TimeoutError,
  schema as s,
  type Connector,
} from "../src/index.js";
import { testEvent } from "./helpers.js";

/** A connector whose render/execute resolve only after `ms` of real time. */
function slowConnector(opts: { renderMs?: number; executeMs?: number }): Connector {
  return defineConnector({
    id: "slow",
    version: "1.0.0",
    actions: [
      defineAction({
        type: "slow.act",
        input: s.object({}),
        render: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ preview: "slow", payload: {} }), opts.renderMs ?? 0),
          ),
        execute: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ output: { ok: true }, effectRefs: [] }), opts.executeMs ?? 0),
          ),
      }),
    ],
  });
}

function slowRuntime(connector: Connector, timeoutMs: number) {
  return createRuntime({
    connectors: [connector],
    connectorTimeoutMs: timeoutMs,
    workflows: [
      defineWorkflow({
        id: "wf",
        match: matchSource("test"),
        plan: () => [
          {
            ref: "a1",
            connectorId: "slow",
            actionType: "slow.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: {},
          },
        ],
      }),
    ],
  });
}

test("a slow execute is failed closed on timeout", async () => {
  const runtime = slowRuntime(slowConnector({ executeMs: 80 }), 20);
  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "failed");
  assert.equal(result?.reason, "execute_timeout");
  assert.equal(result?.error?.name, "TimeoutError");
});

test("a slow render is failed closed on timeout, before any execute", async () => {
  const runtime = slowRuntime(slowConnector({ renderMs: 80 }), 20);
  const run = await runtime.run("wf", testEvent());
  const result = run.results[0];

  assert.equal(result?.outcome, "failed");
  assert.equal(result?.reason, "render_timeout");
});

test("a connector well within the timeout executes normally", async () => {
  const runtime = slowRuntime(slowConnector({ executeMs: 1 }), 200);
  const run = await runtime.run("wf", testEvent());
  assert.equal(run.results[0]?.outcome, "executed");
});

test("a connector throwing its own TimeoutError is not mislabeled as a runtime timeout", async () => {
  // No connectorTimeoutMs configured; the connector itself throws the public
  // TimeoutError. It must be recorded as a normal failure, not execute_timeout.
  const connector = defineConnector({
    id: "throws",
    version: "1.0.0",
    actions: [
      defineAction({
        type: "throws.act",
        input: s.object({}),
        render: () => ({ preview: "x", payload: {} }),
        execute: () => {
          throw new TimeoutError("downstream HTTP timed out", 1234);
        },
      }),
    ],
  });
  const runtime = createRuntime({
    connectors: [connector],
    workflows: [
      defineWorkflow({
        id: "wf",
        match: matchSource("test"),
        plan: () => [
          {
            ref: "a1",
            connectorId: "throws",
            actionType: "throws.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: {},
          },
        ],
      }),
    ],
  });

  const run = await runtime.run("wf", testEvent());
  assert.equal(run.results[0]?.outcome, "failed");
  assert.equal(run.results[0]?.reason, "execute_failed", "not execute_timeout");
});

test("the timed-out audit event is recorded", async () => {
  const runtime = slowRuntime(slowConnector({ executeMs: 80 }), 20);
  const run = await runtime.run("wf", testEvent());
  const trail = await runtime.read.getAuditTrail(run.id);
  assert.ok(trail.some((r) => r.event === "execute.timed_out"), "execute.timed_out audited");
});

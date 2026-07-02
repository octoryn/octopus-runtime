import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRuntime,
  defineWorkflow,
  matchSource,
  AutonomyLevel,
  ManualClock,
  ConfigurationError,
  type TriggerEvent,
} from "../src/index.js";
import { createEmailConnector, inMemoryTransport } from "../src/connectors/email.js";
import { probeConnector, planWorkflow, testEvent, makeRuntime } from "./helpers.js";

function signupEvent(email: string): TriggerEvent {
  return {
    id: "evt-signup",
    source: "signup",
    occurredAt: "2020-01-01T00:00:00.000Z",
    payload: { email },
  };
}

function emailRuntime() {
  const { transport, outbox } = inMemoryTransport();
  const runtime = createRuntime({
    connectors: [createEmailConnector(transport)],
    clock: new ManualClock(),
    workflows: [
      defineWorkflow<{ email: string }>({
        id: "welcome",
        match: matchSource("signup"),
        plan: ({ event }) => [
          {
            ref: "send",
            connectorId: "email",
            actionType: "email.send",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { to: [event.payload.email], subject: "Welcome", body: "Hello" },
          },
        ],
      }),
    ],
  });
  return { runtime, outbox };
}

test("dispatch runs matching workflows and skips non-matching events", async () => {
  const { runtime, outbox } = emailRuntime();

  const matched = await runtime.dispatch(signupEvent("ada@example.com"));
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.workflowId, "welcome");

  const unmatched = await runtime.dispatch({
    id: "e2",
    source: "unrelated",
    occurredAt: "2020-01-01T00:00:00.000Z",
    payload: {},
  });
  assert.equal(unmatched.length, 0);

  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]?.to[0], "ada@example.com");
});

test("the email connector executes end to end with effect refs", async () => {
  const { runtime, outbox } = emailRuntime();

  const run = await runtime.run("welcome", signupEvent("grace@example.com"));
  const result = run.results[0];

  assert.equal(result?.outcome, "executed");
  assert.equal(result?.effectRefs?.[0]?.kind, "email.message");
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]?.subject, "Welcome");
});

test("read APIs project stored runs and results", async () => {
  const { runtime } = emailRuntime();
  const run = await runtime.run("welcome", signupEvent("ada@example.com"));

  const fetched = await runtime.read.getRun(run.id);
  assert.equal(fetched?.id, run.id);

  const runs = await runtime.read.listRuns();
  assert.equal(runs.length, 1);

  const results = await runtime.read.getRunResults(run.id);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.actionType, "email.send");
});

test("the in-memory transport dedupes by idempotency key", async () => {
  const { transport, outbox } = inMemoryTransport();
  const first = await transport.deliver(
    { to: ["a@x.com"], subject: "s", body: "b" },
    { idempotencyKey: "k1" },
  );
  const second = await transport.deliver(
    { to: ["a@x.com"], subject: "s", body: "b" },
    { idempotencyKey: "k1" },
  );

  assert.equal(first.messageId, second.messageId);
  assert.equal(outbox.length, 1);
});

test("sequential multi-action runs preserve order and expose per-action results", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [
      planWorkflow({
        actions: [
          {
            ref: "one",
            connectorId: "probe",
            actionType: "probe.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { value: "1" },
          },
          {
            ref: "two",
            connectorId: "probe",
            actionType: "probe.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { value: "2" },
            dependsOn: ["one"],
          },
        ],
      }),
    ],
  );

  const run = await runtime.run("wf", testEvent());
  assert.deepEqual(
    run.results.map((r) => r.actionRef),
    ["one", "two"],
  );
  assert.ok(run.results.every((r) => r.outcome === "executed"));
  assert.equal(probe.executeCalls, 2);
});

test("a plan with a forward dependency is rejected", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [
      planWorkflow({
        actions: [
          {
            ref: "a",
            connectorId: "probe",
            actionType: "probe.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { value: "a" },
            dependsOn: ["b"], // b appears later — invalid in a sequential plan
          },
          {
            ref: "b",
            connectorId: "probe",
            actionType: "probe.act",
            requestedAutonomy: AutonomyLevel.Autonomous,
            input: { value: "b" },
          },
        ],
      }),
    ],
  );

  await assert.rejects(() => runtime.run("wf", testEvent()), ConfigurationError);
});

test("registering a duplicate workflow id throws", () => {
  const probe = probeConnector();
  const runtime = makeRuntime([probe.connector], []);
  runtime.registerWorkflow(planWorkflow({ id: "dup", actions: [] }));
  assert.throws(
    () => runtime.registerWorkflow(planWorkflow({ id: "dup", actions: [] })),
    ConfigurationError,
  );
});

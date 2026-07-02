import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRuntime,
  defineWorkflow,
  matchSource,
  AutonomyLevel,
  ManualClock,
  type TriggerEvent,
} from "../src/index.js";
import { createEmailConnector, inMemoryTransport } from "../src/connectors/email.js";
import { probeConnector, singleActionWorkflow, testEvent, makeRuntime } from "./helpers.js";

test("the same event id is processed once, even across repeated dispatch", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Autonomous })],
  );

  const [first] = await runtime.dispatch(testEvent());
  const [second] = await runtime.dispatch(testEvent()); // identical id "evt-1"

  assert.equal(first?.id, second?.id, "the second dispatch returns the original run");
  assert.equal(probe.executeCalls, 1, "the effect fired exactly once");
  assert.equal((await runtime.read.listRuns()).length, 1, "only one run was stored");
});

test("concurrent duplicate dispatch coalesces to a single run and one effect", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Autonomous })],
  );

  // Fire the same event twice concurrently — the classic double-webhook race.
  const [a, b] = await Promise.all([runtime.run("wf", testEvent()), runtime.run("wf", testEvent())]);

  assert.equal(a.id, b.id, "both concurrent calls resolve to the same run");
  assert.equal(probe.executeCalls, 1, "the effect fired exactly once");
  assert.equal((await runtime.read.listRuns()).length, 1);
});

test("a distinct event id is a distinct run", async () => {
  const probe = probeConnector();
  const runtime = makeRuntime(
    [probe.connector],
    [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Autonomous })],
  );

  const a = await runtime.run("wf", { ...testEvent(), id: "a" });
  const b = await runtime.run("wf", { ...testEvent(), id: "b" });

  assert.notEqual(a.id, b.id);
  assert.equal(probe.executeCalls, 2);
});

test("effect-level idempotency holds even when ingestion dedup is bypassed", async () => {
  // Two independent runtimes with SEPARATE stores (so ingestion dedup cannot
  // fire) but a SHARED transport — the "same webhook delivered to two workers"
  // case. The stable idempotency key must still keep the effect single.
  const { transport, outbox } = inMemoryTransport();

  function worker() {
    return createRuntime({
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
              input: { to: [event.payload.email], subject: "Welcome", body: "Hi" },
            },
          ],
        }),
      ],
    });
  }

  const event: TriggerEvent = {
    id: "hook-1",
    source: "signup",
    occurredAt: "2020-01-01T00:00:00.000Z",
    payload: { email: "ada@example.com" },
  };

  await worker().run("welcome", event);
  await worker().run("welcome", event);

  assert.equal(outbox.length, 1, "the shared transport deduped the effect by idempotency key");
});

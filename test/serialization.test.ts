import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntime,
  createFileBackend,
  defineConnector,
  defineAction,
  defineWorkflow,
  matchSource,
  AutonomyLevel,
  ManualClock,
  schema as s,
  type Connector,
  type TriggerEvent,
} from "../src/index.js";
import { createSqliteBackend } from "../src/adapters/sqlite.js";
import { safeJsonStringify } from "../src/internal.js";

/** A connector whose execute returns a JSON-hostile value (BigInt) after firing. */
function moneyConnector(counter: { calls: number }): Connector {
  return defineConnector({
    id: "money",
    version: "1.0.0",
    actions: [
      defineAction({
        type: "money.charge",
        input: s.object({}),
        render: () => ({ preview: "charge", payload: {} }),
        execute: () => {
          counter.calls += 1;
          return { output: { amountCents: 500n }, effectRefs: [{ kind: "charge", id: "c1" }] };
        },
      }),
    ],
  });
}

function chargeWorkflow(autonomy: AutonomyLevel) {
  return defineWorkflow({
    id: "charge",
    match: matchSource("order"),
    plan: () => [
      {
        ref: "charge",
        connectorId: "money",
        actionType: "money.charge",
        requestedAutonomy: autonomy,
        input: {},
      },
    ],
  });
}

const order: TriggerEvent = {
  id: "order-1",
  source: "order",
  occurredAt: "2020-01-01T00:00:00.000Z",
  payload: {},
};

test("safeJsonStringify never throws and encodes BigInt as a string", () => {
  assert.equal(JSON.parse(safeJsonStringify({ n: 5n })).n, "5");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.doesNotThrow(() => safeJsonStringify(circular));
});

test("SQLite: a BigInt in execute output does not orphan the run or re-fire on redelivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wfr-ser-"));
  try {
    const counter = { calls: 0 };
    const backend = createSqliteBackend(join(dir, "db.sqlite"));
    const runtime = createRuntime({
      store: backend.store,
      audit: backend.audit,
      approvals: backend.approvals,
      clock: new ManualClock(),
      connectors: [moneyConnector(counter)],
      workflows: [chargeWorkflow(AutonomyLevel.Autonomous)],
    });

    const run = await runtime.run("charge", order);
    assert.equal(run.results[0]?.outcome, "executed", "effect fired and was recorded");

    // The run row is actually persisted (not lost to a JSON.stringify throw).
    const stored = await runtime.read.getRun(run.id);
    assert.ok(stored, "run persisted despite BigInt output");
    const output = stored?.results[0]?.output as { amountCents?: string } | undefined;
    assert.equal(output?.amountCents, "500", "BigInt encoded as string");

    // Redelivery must dedup — the dedup key was committed with the run.
    const again = await runtime.run("charge", order);
    assert.equal(again.id, run.id);
    assert.equal(counter.calls, 1, "effect did NOT fire a second time");
    backend.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("File store: a BigInt in execute output persists the run and dedups on redelivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wfr-ser2-"));
  try {
    const counter = { calls: 0 };
    const runtime = createRuntime({
      ...createFileBackend(dir),
      clock: new ManualClock(),
      connectors: [moneyConnector(counter)],
      workflows: [chargeWorkflow(AutonomyLevel.Autonomous)],
    });

    const run = await runtime.run("charge", order);
    assert.equal(run.results[0]?.outcome, "executed");
    assert.ok(await runtime.read.getRun(run.id), "run persisted");

    await runtime.run("charge", order);
    assert.equal(counter.calls, 1, "no re-fire on redelivery");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite draft→approve with BigInt output records executed, not failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wfr-ser3-"));
  try {
    const counter = { calls: 0 };
    const backend = createSqliteBackend(join(dir, "db.sqlite"));
    const runtime = createRuntime({
      store: backend.store,
      audit: backend.audit,
      approvals: backend.approvals,
      clock: new ManualClock(),
      connectors: [moneyConnector(counter)],
      workflows: [chargeWorkflow(AutonomyLevel.Draft)],
    });

    const run = await runtime.run("charge", order);
    const approvalId = run.results[0]?.approvalId as string;
    const result = await runtime.resolveApproval(approvalId, { approved: true, decidedBy: "ops" });

    assert.equal(result.outcome, "executed", "a succeeded effect is not mislabeled failed");
    const stored = await runtime.read.getResult(run.id, "charge");
    assert.equal(stored?.outcome, "executed");
    backend.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

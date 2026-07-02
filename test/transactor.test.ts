import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntime,
  AutonomyLevel,
  ManualClock,
  type Approval,
  type ExecutionResult,
  type RunRecord,
  type TriggerEvent
} from "../src/index.js";
import { createSqliteBackend, SqliteStore, SqliteTransactor, openDatabase } from "../src/adapters/sqlite.js";
import { probeConnector, singleActionWorkflow } from "./helpers.js";

async function withDbFile(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wfr-tx-"));
  try {
    await fn(join(dir, "db.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const draftEvent: TriggerEvent = {
  id: "evt-1",
  source: "test",
  occurredAt: "2020-01-01T00:00:00.000Z",
  payload: {}
};

test("resolving an approval commits approval + result consistently (SQLite transactor)", async () => {
  await withDbFile(async (path) => {
    const probe = probeConnector();
    const backend = createSqliteBackend(path);
    const runtime = createRuntime({
      store: backend.store,
      audit: backend.audit,
      approvals: backend.approvals,
      transactor: backend.transactor,
      clock: new ManualClock(),
      connectors: [probe.connector],
      workflows: [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Draft })]
    });

    const run = await runtime.run("wf", draftEvent);
    const approvalId = run.results[0]?.approvalId as string;
    await runtime.resolveApproval(approvalId, { approved: true, decidedBy: "ops" });

    // Both sides of the transition are present and agree.
    const approval = await runtime.read.getApproval(approvalId);
    const result = await runtime.read.getResult(run.id, "a1");
    assert.equal(approval?.status, "approved");
    assert.equal(result?.outcome, "executed");

    // The decision + result audit landed together.
    const events = (await runtime.read.getAuditTrail(run.id)).map((r) => r.event);
    assert.ok(events.includes("approval.decided"));
    assert.ok(events.includes("execute.succeeded"));
    assert.ok(events.includes("result.recorded"));
    backend.close();
  });
});

test("a failing commit rolls back entirely — no partial write", async () => {
  await withDbFile(async (path) => {
    const db = openDatabase(path);
    const store = new SqliteStore(db);
    const transactor = new SqliteTransactor(db);

    // Seed a run with one drafted result.
    const drafted: ExecutionResult = {
      runId: "run-1",
      workflowId: "wf",
      actionRef: "a1",
      connectorId: "probe",
      actionType: "probe.act",
      requestedAutonomy: AutonomyLevel.Draft,
      effectiveAutonomy: AutonomyLevel.Draft,
      outcome: "drafted",
      startedAt: "2020-01-01T00:00:00.000Z",
      finishedAt: "2020-01-01T00:00:00.000Z"
    };
    const run: RunRecord = {
      id: "run-1",
      workflowId: "wf",
      event: draftEvent,
      status: "completed",
      results: [drafted],
      startedAt: "2020-01-01T00:00:00.000Z",
      finishedAt: "2020-01-01T00:00:00.000Z"
    };
    await store.saveRun(run);

    // A commit whose result update is valid but whose approval violates the
    // NOT NULL status column — the whole transaction must roll back.
    const executed: ExecutionResult = { ...drafted, outcome: "executed" };
    const badApproval = {
      id: "apr-1",
      status: undefined as unknown as Approval["status"],
      runId: "run-1",
      workflowId: "wf",
      actionRef: "a1",
      connectorId: "probe",
      actionType: "probe.act",
      requestedAutonomy: AutonomyLevel.Draft,
      idempotencyKey: "k",
      rendered: { preview: "x", payload: {} },
      createdAt: "2020-01-01T00:00:00.000Z"
    } as Approval;

    await assert.rejects(() => transactor.commit({ result: executed, approval: badApproval }));

    // The result update was rolled back — still `drafted`, not `executed`.
    const after = await store.getResult("run-1", "a1");
    assert.equal(after?.outcome, "drafted", "result change was rolled back with the failed approval");
    db.close();
  });
});

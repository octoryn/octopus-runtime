import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntime,
  defineWorkflow,
  matchSource,
  AutonomyLevel,
  ManualClock,
  type Runtime,
  type RunRecord,
  type TriggerEvent,
} from "../src/index.js";
import { createSqliteBackend, SqliteStore, openDatabase } from "../src/adapters/sqlite.js";
import { createEmailConnector, type EmailMessage, type SentEmail } from "../src/connectors/email.js";

async function withDbFile(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wfr-sqlite-"));
  try {
    await fn(join(dir, "runtime.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Transport writing to a caller-owned outbox that outlives runtime instances. */
function sharedTransport(outbox: SentEmail[]) {
  let counter = 0;
  const seen = new Map<string, string>();
  return {
    async deliver(message: EmailMessage, options: { idempotencyKey: string }) {
      const existing = seen.get(options.idempotencyKey);
      if (existing !== undefined) return { messageId: existing };
      const messageId = `msg_${++counter}`;
      seen.set(options.idempotencyKey, messageId);
      outbox.push({ ...message, messageId, idempotencyKey: options.idempotencyKey });
      return { messageId };
    },
  };
}

function signup(id: string): TriggerEvent {
  return {
    id,
    source: "signup",
    occurredAt: "2020-01-01T00:00:00.000Z",
    payload: { email: "ada@example.com" },
  };
}

function runtimeOn(
  path: string,
  autonomy: AutonomyLevel,
  outbox: SentEmail[],
  transport = sharedTransport(outbox),
) {
  const backend = createSqliteBackend(path);
  const runtime: Runtime = createRuntime({
    store: backend.store,
    audit: backend.audit,
    approvals: backend.approvals,
    transactor: backend.transactor,
    clock: new ManualClock(),
    connectors: [createEmailConnector(transport)],
    workflows: [
      defineWorkflow<{ email: string }>({
        id: "welcome",
        match: matchSource("signup"),
        plan: ({ event }) => [
          {
            ref: "send",
            connectorId: "email",
            actionType: "email.send",
            requestedAutonomy: autonomy,
            input: { to: [event.payload.email], subject: "Welcome", body: "Hi" },
          },
        ],
      }),
    ],
  });
  return { runtime, close: backend.close };
}

test("run and dedup key are one atomic row — a second run for the same event is rejected", async () => {
  await withDbFile(async (path) => {
    const db = openDatabase(path);
    const store = new SqliteStore(db);

    const base: Omit<RunRecord, "id"> = {
      workflowId: "welcome",
      event: signup("evt-1"),
      status: "completed",
      results: [],
      startedAt: "2020-01-01T00:00:00.000Z",
      finishedAt: "2020-01-01T00:00:00.000Z",
    };

    await store.saveRun({ ...base, id: "run-1" });
    // A different run id for the same (workflow, event) must not be storable —
    // the UNIQUE constraint makes "one event → one run" a storage guarantee.
    await assert.rejects(() => store.saveRun({ ...base, id: "run-2" }));
    // Re-saving the SAME run id is fine (idempotent update).
    await store.saveRun({ ...base, id: "run-1" });

    assert.equal((await store.findRunByEvent("welcome", "evt-1"))?.id, "run-1");
    db.close();
  });
});

test("a Draft approval survives a restart and executes (SQLite)", async () => {
  await withDbFile(async (path) => {
    const outbox: SentEmail[] = [];

    const first = runtimeOn(path, AutonomyLevel.Draft, outbox);
    const run = await first.runtime.run("welcome", signup("evt-1"));
    const approvalId = run.results[0]?.approvalId as string;
    assert.ok(approvalId);
    assert.equal(outbox.length, 0);
    first.close(); // simulate shutdown

    const second = runtimeOn(path, AutonomyLevel.Draft, outbox);
    const pending = await second.runtime.read.listPendingApprovals();
    assert.equal(pending.length, 1, "approval reloaded from the database");
    assert.equal(pending[0]?.id, approvalId);

    const executed = await second.runtime.resolveApproval(approvalId, {
      approved: true,
      decidedBy: "ops",
    });
    assert.equal(executed.outcome, "executed");
    assert.equal(outbox.length, 1);
    second.close();
  });
});

test("a redelivered event does not re-run after restart (atomic dedup)", async () => {
  await withDbFile(async (path) => {
    const outbox: SentEmail[] = [];

    const first = runtimeOn(path, AutonomyLevel.Autonomous, outbox);
    const runA = await first.runtime.run("welcome", signup("dup-1"));
    assert.equal(outbox.length, 1);
    first.close();

    const second = runtimeOn(path, AutonomyLevel.Autonomous, outbox);
    const runB = await second.runtime.run("welcome", signup("dup-1"));
    assert.equal(runB.id, runA.id, "same run returned");
    assert.equal(outbox.length, 1, "effect fired exactly once across restart");
    second.close();
  });
});

test("two runtimes sharing one database can't double-run the same event", async () => {
  await withDbFile(async (path) => {
    const outbox: SentEmail[] = [];
    // Separate runtimes = separate in-flight guards (the cross-process case),
    // one shared database enforcing unique ingestion, and one shared downstream
    // (transport) that dedupes on the stable idempotency key — as a real
    // external system would.
    const downstream = sharedTransport(outbox);
    const a = runtimeOn(path, AutonomyLevel.Autonomous, outbox, downstream);
    const b = runtimeOn(path, AutonomyLevel.Autonomous, outbox, downstream);

    const [ra, rb] = await Promise.all([
      a.runtime.run("welcome", signup("race-1")),
      b.runtime.run("welcome", signup("race-1")),
    ]);

    assert.equal(ra.id, rb.id, "both resolve to the one canonical run");
    assert.equal(outbox.length, 1, "the effect fired exactly once");
    const store = createSqliteBackend(path);
    assert.equal((await store.store.listRuns()).length, 1, "exactly one run row");
    store.close();
    a.close();
    b.close();
  });
});

test("runs and audit persist across restart (SQLite)", async () => {
  await withDbFile(async (path) => {
    const outbox: SentEmail[] = [];
    const first = runtimeOn(path, AutonomyLevel.Autonomous, outbox);
    const run = await first.runtime.run("welcome", signup("evt-2"));
    first.close();

    const second = runtimeOn(path, AutonomyLevel.Autonomous, outbox);
    const reloaded = await second.runtime.read.getRun(run.id);
    assert.equal(reloaded?.results[0]?.outcome, "executed");
    const trail = await second.runtime.read.getAuditTrail(run.id);
    assert.ok(trail.some((r) => r.event === "execute.succeeded"));
    assert.deepEqual(
      trail.map((r) => r.event).slice(0, 3),
      ["trigger.received", "condition.evaluated", "plan.created"],
      "audit order preserved by seq",
    );
    second.close();
  });
});

test("approval TTL works over the SQLite backend", async () => {
  await withDbFile(async (path) => {
    const outbox: SentEmail[] = [];
    const backend = createSqliteBackend(path);
    const clock = new ManualClock();
    const runtime = createRuntime({
      store: backend.store,
      audit: backend.audit,
      approvals: backend.approvals,
      clock,
      approvalTtlMs: 100_000,
      connectors: [createEmailConnector(sharedTransport(outbox))],
      workflows: [
        defineWorkflow<{ email: string }>({
          id: "welcome",
          match: matchSource("signup"),
          plan: ({ event }) => [
            {
              ref: "send",
              connectorId: "email",
              actionType: "email.send",
              requestedAutonomy: AutonomyLevel.Draft,
              input: { to: [event.payload.email], subject: "Welcome", body: "Hi" },
            },
          ],
        }),
      ],
    });

    await runtime.run("welcome", signup("evt-1"));
    clock.advance(200_000);
    const expired = await runtime.sweepExpiredApprovals();

    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.outcome, "expired");
    assert.equal(outbox.length, 0, "expired approval never executed");
    backend.close();
  });
});

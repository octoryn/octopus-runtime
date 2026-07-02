import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntime,
  createFileBackend,
  defineWorkflow,
  matchSource,
  AutonomyLevel,
  ManualClock,
  type Runtime,
  type TriggerEvent,
} from "../src/index.js";
import { createEmailConnector, type EmailMessage, type SentEmail } from "../src/connectors/email.js";

/** A fresh temp directory, removed when `fn` settles. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wfr-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A transport that appends to a caller-owned outbox and dedupes by idempotency
 * key. The outbox lives outside the runtime, so it survives the runtime being
 * discarded and recreated (our stand-in for a process restart).
 */
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

/** Build a runtime over a durable backend dir with a shared email transport. */
function durableRuntime(dir: string, autonomy: AutonomyLevel, outbox: SentEmail[]): Runtime {
  return createRuntime({
    ...createFileBackend(dir),
    clock: new ManualClock(),
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
            requestedAutonomy: autonomy,
            input: { to: [event.payload.email], subject: "Welcome", body: "Hi" },
          },
        ],
      }),
    ],
  });
}

test("a Draft approval survives a process restart and then executes", async () => {
  await withTempDir(async (dir) => {
    const outbox: SentEmail[] = [];

    // Process 1: create the draft, then discard the runtime (simulated crash).
    const first = durableRuntime(dir, AutonomyLevel.Draft, outbox);
    const run = await first.run("welcome", signup("evt-1"));
    const approvalId = run.results[0]?.approvalId as string;
    assert.ok(approvalId);
    assert.equal(outbox.length, 0, "draft sent nothing");

    // Process 2: a brand-new runtime over the same directory.
    const second = durableRuntime(dir, AutonomyLevel.Draft, outbox);
    const pending = await second.read.listPendingApprovals();
    assert.equal(pending.length, 1, "the pending approval was reloaded from disk");
    assert.equal(pending[0]?.id, approvalId);

    const executed = await second.resolveApproval(approvalId, {
      approved: true,
      decidedBy: "ops",
    });
    assert.equal(executed.outcome, "executed");
    assert.equal(outbox.length, 1, "approval after restart delivered the email");
  });
});

test("runs and audit trail are readable after restart", async () => {
  await withTempDir(async (dir) => {
    const outbox: SentEmail[] = [];
    const first = durableRuntime(dir, AutonomyLevel.Autonomous, outbox);
    const run = await first.run("welcome", signup("evt-2"));
    assert.equal(run.results[0]?.outcome, "executed");

    const second = durableRuntime(dir, AutonomyLevel.Autonomous, outbox);
    const reloaded = await second.read.getRun(run.id);
    assert.equal(reloaded?.id, run.id);
    assert.equal(reloaded?.results[0]?.outcome, "executed");

    const trail = await second.read.getAuditTrail(run.id);
    assert.ok(trail.some((r) => r.event === "execute.succeeded"), "audit persisted");
  });
});

test("a redelivered event does not run the workflow twice (dedup across restart)", async () => {
  await withTempDir(async (dir) => {
    const outbox: SentEmail[] = [];
    const first = durableRuntime(dir, AutonomyLevel.Autonomous, outbox);
    const runA = await first.run("welcome", signup("dup-1"));
    assert.equal(outbox.length, 1);

    // The same event id arrives again, even after a restart.
    const second = durableRuntime(dir, AutonomyLevel.Autonomous, outbox);
    const runB = await second.run("welcome", signup("dup-1"));

    assert.equal(runB.id, runA.id, "returns the original run");
    assert.equal(outbox.length, 1, "the effect fired exactly once");

    const trail = await second.read.getAuditTrail(runA.id);
    assert.ok(trail.some((r) => r.event === "trigger.deduplicated"), "dedup audited");
  });
});

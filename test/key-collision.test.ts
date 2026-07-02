import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compositeKey, MemoryStore, FileStore, type RunRecord } from "../src/index.js";

test("compositeKey is injective across separator-containing parts", () => {
  // The classic separator-injection collision must NOT occur.
  assert.notEqual(compositeKey("a", "b:c"), compositeKey("a:b", "c"));
  assert.notEqual(compositeKey("wf", "x::y"), compositeKey("wf::x", "y"));
  // Identical tuples still map to identical keys.
  assert.equal(compositeKey("wf", "evt", "a1"), compositeKey("wf", "evt", "a1"));
});

function runFor(workflowId: string, eventId: string): RunRecord {
  return {
    id: `run-${workflowId}-${eventId}`,
    workflowId,
    event: { id: eventId, source: "s", occurredAt: "2020-01-01T00:00:00.000Z", payload: {} },
    status: "completed",
    results: [],
    startedAt: "2020-01-01T00:00:00.000Z",
    finishedAt: "2020-01-01T00:00:00.000Z"
  };
}

test("MemoryStore.findRunByEvent does not confuse colliding tuples", async () => {
  const store = new MemoryStore();
  await store.saveRun(runFor("a", "x::y"));

  assert.equal((await store.findRunByEvent("a", "x::y"))?.id, "run-a-x::y");
  // A different (workflowId, eventId) that would collide under a naive join.
  assert.equal(await store.findRunByEvent("a::x", "y"), undefined);
});

test("FileStore.findRunByEvent does not confuse colliding tuples", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wfr-key-"));
  try {
    const store = new FileStore(dir);
    await store.saveRun(runFor("a", "x::y"));

    assert.equal((await store.findRunByEvent("a", "x::y"))?.id, "run-a-x::y");
    assert.equal(await store.findRunByEvent("a::x", "y"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

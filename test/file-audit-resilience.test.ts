import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileAuditSink, type AuditRecord } from "../src/index.js";

function record(id: string): AuditRecord {
  return { id, at: "2020-01-01T00:00:00.000Z", boundary: "trigger", event: "trigger.received" };
}

test("a torn final audit line does not make the whole trail unreadable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wfr-audit-"));
  try {
    const audit = new FileAuditSink(dir);
    await audit.append(record("aud-1"));
    await audit.append(record("aud-2"));

    // Simulate a crash mid-append: a truncated JSON line at the tail.
    appendFileSync(join(dir, "audit.jsonl"), '{"id":"aud-3","at":"2020', "utf8");

    const all = await audit.query();
    assert.equal(all.length, 2, "the two intact records are still readable");
    assert.deepEqual(
      all.map((r) => r.id),
      ["aud-1", "aud-2"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

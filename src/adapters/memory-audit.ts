/**
 * In-memory {@link AuditSink}. Append-only; preserves insertion order, which is
 * also emission order because the engine awaits each append in sequence.
 */

import type { AuditSink } from "../ports.js";
import type { AuditRecord } from "../types.js";

export class MemoryAuditSink implements AuditSink {
  readonly #records: AuditRecord[] = [];

  async append(record: AuditRecord): Promise<void> {
    this.#records.push(structuredClone(record));
  }

  async query(filter?: { runId?: string }): Promise<AuditRecord[]> {
    const all = this.#records.map((r) => structuredClone(r));
    if (filter?.runId === undefined) return all;
    return all.filter((r) => r.runId === filter.runId);
  }
}

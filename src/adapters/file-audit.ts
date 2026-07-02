/**
 * Durable, file-backed {@link AuditSink}. Appends one JSON object per line to
 * `audit.jsonl` (JSON Lines), which survives restarts and is trivially
 * greppable. Appends are serialized so lines never interleave.
 */

import { mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditSink } from "../ports.js";
import type { AuditRecord } from "../types.js";

export class FileAuditSink implements AuditSink {
  readonly #file: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.#file = join(dir, "audit.jsonl");
  }

  append(record: AuditRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const next = this.#queue.then(() => appendFile(this.#file, line, "utf8"));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async query(filter?: { runId?: string }): Promise<AuditRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: AuditRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      try {
        records.push(JSON.parse(line) as AuditRecord);
      } catch {
        // A crash mid-append can only truncate the final line (appends are
        // serialized). Skip an unparseable line rather than failing the whole
        // query — a torn tail must not make the entire trail unreadable.
      }
    }
    if (filter?.runId === undefined) return records;
    return records.filter((r) => r.runId === filter.runId);
  }
}

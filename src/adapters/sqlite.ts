/**
 * Durable, transactional SQLite backend — the production-grade persistence
 * adapter.
 *
 * Its defining property over the file backend: **atomic ingestion dedup**. A run
 * and its `(workflow_id, event_id)` dedup key are the *same row*, protected by a
 * `UNIQUE` constraint and written in one atomic commit. There is no two-write
 * crash window — after a crash, either the whole run (with its dedup key) is
 * durable, or none of it is. A redelivered event therefore cannot re-run after a
 * restart, and at most one run *row* can ever exist per event, even across
 * processes.
 *
 * Note the scope: this guarantees a single canonical run *record*. It does not
 * by itself prevent two processes that race the *same* event from each running
 * `execute` before either commits (the row uniqueness resolves the loser only at
 * save time). Exactly-once *effects* across that race rely on the connector
 * honoring the stable `idempotencyKey`, as everywhere else in the runtime.
 *
 * Backed by `better-sqlite3`, which is a **peer dependency**: install it
 * yourself (`npm i better-sqlite3`) to use this adapter. The runtime core has no
 * dependency on it — importing the main entry point never loads it.
 *
 * ```ts
 * import { createSqliteBackend } from "@octopus/workflow-runtime/adapters/sqlite";
 * const backend = createSqliteBackend("./runtime.db");
 * const runtime = createRuntime({ ...backend, connectors, workflows });
 * // …later: backend.close();
 * ```
 */

import Database from "better-sqlite3";
import type { Store, AuditSink, ApprovalGateway, Transactor, StateChange } from "../ports.js";
import type { AuditRecord, ExecutionResult, RunRecord } from "../types.js";
import type { Approval, ApprovalStatus } from "../approvals.js";
import { safeJsonStringify } from "../internal.js";

/** A better-sqlite3 database handle. */
type DB = Database.Database;

/** Open a database (file path or `:memory:`) and ensure the schema exists. */
export function openDatabase(target: string | DB): DB {
  const db = typeof target === "string" ? new Database(target) : target;
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  data        TEXT NOT NULL,
  UNIQUE (workflow_id, event_id)
);
CREATE TABLE IF NOT EXISTS approvals (
  id     TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  data   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  data   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_run ON audit (run_id);
`;

/** Transactional SQLite {@link Store}. */
export class SqliteStore implements Store {
  readonly #db: DB;

  constructor(db: DB) {
    this.#db = db;
  }

  async saveRun(run: RunRecord): Promise<void> {
    // The run row and its dedup key are one atomic insert. Re-saving the same
    // run id updates it; a *different* run id for an already-seen
    // (workflow, event) violates the UNIQUE constraint — a storage-level
    // guarantee that one event maps to at most one run.
    this.#db
      .prepare(
        `INSERT INTO runs (id, workflow_id, event_id, data) VALUES (@id, @workflowId, @eventId, @data)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      )
      .run({
        id: run.id,
        workflowId: run.workflowId,
        eventId: run.event.id,
        data: safeJsonStringify(run)
      });
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const row = this.#db.prepare(`SELECT data FROM runs WHERE id = ?`).get(runId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as RunRecord) : undefined;
  }

  async listRuns(): Promise<RunRecord[]> {
    const rows = this.#db.prepare(`SELECT data FROM runs`).all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as RunRecord);
  }

  async saveResult(result: ExecutionResult): Promise<void> {
    // Atomic read-modify-write of the embedded results array.
    const update = this.#db.transaction((res: ExecutionResult) => {
      const row = this.#db.prepare(`SELECT data FROM runs WHERE id = ?`).get(res.runId) as { data: string } | undefined;
      if (!row) return;
      const run = JSON.parse(row.data) as RunRecord;
      const idx = run.results.findIndex((r) => r.actionRef === res.actionRef);
      if (idx >= 0) run.results[idx] = res;
      else run.results.push(res);
      this.#db.prepare(`UPDATE runs SET data = ? WHERE id = ?`).run(safeJsonStringify(run), res.runId);
    });
    update(result);
  }

  async getResult(runId: string, actionRef: string): Promise<ExecutionResult | undefined> {
    const run = await this.getRun(runId);
    return run?.results.find((r) => r.actionRef === actionRef);
  }

  async findRunByEvent(workflowId: string, eventId: string): Promise<RunRecord | undefined> {
    const row = this.#db
      .prepare(`SELECT data FROM runs WHERE workflow_id = ? AND event_id = ?`)
      .get(workflowId, eventId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as RunRecord) : undefined;
  }
}

/** Append-only SQLite {@link AuditSink}; `seq` preserves emission order. */
export class SqliteAuditSink implements AuditSink {
  readonly #db: DB;

  constructor(db: DB) {
    this.#db = db;
  }

  async append(record: AuditRecord): Promise<void> {
    this.#db
      .prepare(`INSERT INTO audit (run_id, data) VALUES (?, ?)`)
      .run(record.runId ?? null, safeJsonStringify(record));
  }

  async query(filter?: { runId?: string }): Promise<AuditRecord[]> {
    const rows =
      filter?.runId === undefined
        ? (this.#db.prepare(`SELECT data FROM audit ORDER BY seq`).all() as { data: string }[])
        : (this.#db.prepare(`SELECT data FROM audit WHERE run_id = ? ORDER BY seq`).all(filter.runId) as {
            data: string;
          }[]);
    return rows.map((r) => JSON.parse(r.data) as AuditRecord);
  }
}

/** SQLite {@link ApprovalGateway}. */
export class SqliteApprovalGateway implements ApprovalGateway {
  readonly #db: DB;

  constructor(db: DB) {
    this.#db = db;
  }

  create(approval: Approval): Promise<void> {
    return this.#write(approval);
  }

  save(approval: Approval): Promise<void> {
    return this.#write(approval);
  }

  async get(approvalId: string): Promise<Approval | undefined> {
    const row = this.#db.prepare(`SELECT data FROM approvals WHERE id = ?`).get(approvalId) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Approval) : undefined;
  }

  async list(filter?: { status?: ApprovalStatus }): Promise<Approval[]> {
    const rows =
      filter?.status === undefined
        ? (this.#db.prepare(`SELECT data FROM approvals`).all() as { data: string }[])
        : (this.#db.prepare(`SELECT data FROM approvals WHERE status = ?`).all(filter.status) as { data: string }[]);
    return rows.map((r) => JSON.parse(r.data) as Approval);
  }

  async #write(approval: Approval): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO approvals (id, status, data) VALUES (@id, @status, @data)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`
      )
      .run({ id: approval.id, status: approval.status, data: safeJsonStringify(approval) });
  }
}

/**
 * Atomic {@link Transactor}: commits a run result, approval, and audit records
 * in a single SQLite transaction (BEGIN/COMMIT), so the engine's multi-write
 * state transitions are crash-consistent. Rolls back entirely on any failure.
 */
export class SqliteTransactor implements Transactor {
  readonly #db: DB;

  constructor(db: DB) {
    this.#db = db;
  }

  async commit(change: StateChange): Promise<void> {
    const getRun = this.#db.prepare(`SELECT data FROM runs WHERE id = ?`);
    const updateRun = this.#db.prepare(`UPDATE runs SET data = ? WHERE id = ?`);
    const upsertApproval = this.#db.prepare(
      `INSERT INTO approvals (id, status, data) VALUES (@id, @status, @data)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`
    );
    const insertAudit = this.#db.prepare(`INSERT INTO audit (run_id, data) VALUES (?, ?)`);

    const apply = this.#db.transaction((c: StateChange) => {
      const res = c.result;
      if (res) {
        const row = getRun.get(res.runId) as { data: string } | undefined;
        if (row) {
          const run = JSON.parse(row.data) as RunRecord;
          const idx = run.results.findIndex((r) => r.actionRef === res.actionRef);
          if (idx >= 0) run.results[idx] = res;
          else run.results.push(res);
          updateRun.run(safeJsonStringify(run), res.runId);
        }
      }
      if (c.approval) {
        upsertApproval.run({
          id: c.approval.id,
          status: c.approval.status,
          data: safeJsonStringify(c.approval)
        });
      }
      for (const record of c.audit ?? []) {
        insertAudit.run(record.runId ?? null, safeJsonStringify(record));
      }
    });

    apply(change);
  }
}

/** A durable SQLite backend: store, audit, approvals, and transactor over one database. */
export interface SqliteBackend {
  store: Store;
  audit: AuditSink;
  approvals: ApprovalGateway;
  /** Atomic multi-write commits (approval + result + audit as one transaction). */
  transactor: Transactor;
  /** The underlying database handle, for advanced use. */
  db: DB;
  /** Close the database. Call on shutdown. */
  close(): void;
}

/**
 * Create a durable SQLite backend. Pass a file path (created if absent),
 * `:memory:`, or an existing `better-sqlite3` database. Spread the result into
 * `createRuntime` to persist runs, audit, and approvals in one database file.
 */
export function createSqliteBackend(target: string | DB): SqliteBackend {
  const db = openDatabase(target);
  return {
    store: new SqliteStore(db),
    audit: new SqliteAuditSink(db),
    approvals: new SqliteApprovalGateway(db),
    transactor: new SqliteTransactor(db),
    db,
    close: () => db.close()
  };
}

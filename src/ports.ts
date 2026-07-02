/**
 * Ports — the interfaces the runtime core depends on instead of concrete
 * infrastructure. Every port ships a zero-config in-memory adapter (see
 * `src/adapters`), so the runtime runs locally with nothing installed. An outer
 * operating system substitutes real adapters without touching the core.
 *
 * Dependency arrows always point inward: the core depends on these interfaces;
 * adapters depend on the core. The core never imports an adapter.
 */

import type { AuditRecord, ExecutionResult, RunRecord } from "./types.js";
import type { Approval, ApprovalStatus } from "./approvals.js";

/** Source of time. Injectable so runs are deterministic under test. */
export interface Clock {
  /** Current instant. */
  now(): Date;
}

/** Read/write persistence for runs and their results. */
export interface Store {
  saveRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  listRuns(): Promise<RunRecord[]>;
  /** Persist or replace a single action result (used when a draft later executes). */
  saveResult(result: ExecutionResult): Promise<void>;
  getResult(runId: string, actionRef: string): Promise<ExecutionResult | undefined>;
  /**
   * Find an existing run for a given workflow + trigger event id, if any. Used
   * to make ingestion idempotent so a redelivered event (e.g. a duplicate
   * webhook) does not run the same workflow twice.
   */
  findRunByEvent(workflowId: string, eventId: string): Promise<RunRecord | undefined>;
}

/** Append-only sink for audit records. Emitted at every pipeline boundary. */
export interface AuditSink {
  append(record: AuditRecord): Promise<void>;
  /** Query recorded audit entries, optionally scoped to a run. */
  query(filter?: { runId?: string }): Promise<AuditRecord[]>;
}

/**
 * Persists approvals and their decisions for Draft actions. Surfacing approvals
 * to a human and collecting their decision is the outer OS layer's concern;
 * this port only stores and retrieves the records.
 */
export interface ApprovalGateway {
  create(approval: Approval): Promise<void>;
  get(approvalId: string): Promise<Approval | undefined>;
  list(filter?: { status?: ApprovalStatus }): Promise<Approval[]>;
  /** Replace an approval record (e.g. after a decision). */
  save(approval: Approval): Promise<void>;
}

/** Supplies connector credentials. Connectors are stateless; secrets live here. */
export interface SecretProvider {
  get(key: string): string | undefined;
  require(key: string): string;
}

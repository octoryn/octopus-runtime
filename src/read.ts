/**
 * Read APIs — a thin, read-only projection over the runtime's stored state.
 * These never mutate anything; they are the query surface for runs, per-action
 * results, approvals, and the audit trail.
 */

import type { Store, AuditSink, ApprovalGateway } from "./ports.js";
import type { AuditRecord, ExecutionResult, RunRecord } from "./types.js";
import type { Approval, ApprovalStatus } from "./approvals.js";

export interface ReadApiDeps {
  store: Store;
  audit: AuditSink;
  approvals: ApprovalGateway;
}

/** Query surface over stored runtime state. */
export class ReadApi {
  readonly #deps: ReadApiDeps;

  constructor(deps: ReadApiDeps) {
    this.#deps = deps;
  }

  /** Fetch a single run by id. */
  getRun(runId: string): Promise<RunRecord | undefined> {
    return this.#deps.store.getRun(runId);
  }

  /** List all runs. */
  listRuns(): Promise<RunRecord[]> {
    return this.#deps.store.listRuns();
  }

  /** The per-action results of a run (empty if the run halted or is unknown). */
  async getRunResults(runId: string): Promise<ExecutionResult[]> {
    const run = await this.#deps.store.getRun(runId);
    return run?.results ?? [];
  }

  /** Fetch a single action result by run and action ref. */
  getResult(runId: string, actionRef: string): Promise<ExecutionResult | undefined> {
    return this.#deps.store.getResult(runId, actionRef);
  }

  /** The audit trail, optionally scoped to one run, in insertion order. */
  getAuditTrail(runId?: string): Promise<AuditRecord[]> {
    return runId === undefined ? this.#deps.audit.query() : this.#deps.audit.query({ runId });
  }

  /** Fetch a single approval by id. */
  getApproval(approvalId: string): Promise<Approval | undefined> {
    return this.#deps.approvals.get(approvalId);
  }

  /** List approvals, optionally filtered by status. */
  listApprovals(status?: ApprovalStatus): Promise<Approval[]> {
    return status === undefined ? this.#deps.approvals.list() : this.#deps.approvals.list({ status });
  }

  /** Convenience: approvals still awaiting a decision. */
  listPendingApprovals(): Promise<Approval[]> {
    return this.#deps.approvals.list({ status: "pending" });
  }
}

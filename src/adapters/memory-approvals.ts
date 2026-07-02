/**
 * In-memory {@link ApprovalGateway}. Stores approval records and their
 * decisions. Surfacing approvals to a human is the outer OS layer's job; this
 * adapter only persists and retrieves.
 */

import type { ApprovalGateway } from "../ports.js";
import type { Approval, ApprovalStatus } from "../approvals.js";

export class MemoryApprovalGateway implements ApprovalGateway {
  readonly #approvals = new Map<string, Approval>();

  async create(approval: Approval): Promise<void> {
    this.#approvals.set(approval.id, structuredClone(approval));
  }

  async get(approvalId: string): Promise<Approval | undefined> {
    const approval = this.#approvals.get(approvalId);
    return approval ? structuredClone(approval) : undefined;
  }

  async list(filter?: { status?: ApprovalStatus }): Promise<Approval[]> {
    const all = [...this.#approvals.values()].map((a) => structuredClone(a));
    if (filter?.status === undefined) return all;
    return all.filter((a) => a.status === filter.status);
  }

  async save(approval: Approval): Promise<void> {
    this.#approvals.set(approval.id, structuredClone(approval));
  }
}

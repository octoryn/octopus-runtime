/**
 * Durable, file-backed {@link ApprovalGateway}. One JSON file per approval,
 * written atomically. This is what lets a Draft outlive a process restart: an
 * approval created before a restart is still pending (and resolvable) after it.
 */

import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import type { ApprovalGateway } from "../ports.js";
import type { Approval, ApprovalStatus } from "../approvals.js";
import { readJson, writeJsonAtomic, KeyedLock } from "./fs-util.js";

export class FileApprovalGateway implements ApprovalGateway {
  readonly #dir: string;
  readonly #locks = new KeyedLock();

  constructor(dir: string) {
    this.#dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  create(approval: Approval): Promise<void> {
    return this.#write(approval);
  }

  save(approval: Approval): Promise<void> {
    return this.#write(approval);
  }

  get(approvalId: string): Promise<Approval | undefined> {
    return readJson<Approval>(this.#path(approvalId));
  }

  async list(filter?: { status?: ApprovalStatus }): Promise<Approval[]> {
    const files = await readdir(this.#dir).catch(() => [] as string[]);
    const approvals: Approval[] = [];
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      const approval = await readJson<Approval>(join(this.#dir, file));
      if (approval && (filter?.status === undefined || approval.status === filter.status)) {
        approvals.push(approval);
      }
    }
    return approvals;
  }

  #write(approval: Approval): Promise<void> {
    return this.#locks.run(approval.id, () => writeJsonAtomic(this.#path(approval.id), approval));
  }

  #path(approvalId: string): string {
    return join(this.#dir, `${Buffer.from(approvalId).toString("base64url")}.json`);
  }
}

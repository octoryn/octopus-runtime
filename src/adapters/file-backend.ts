/**
 * Durable file-backed backend: a {@link FileStore}, {@link FileAuditSink}, and
 * {@link FileApprovalGateway} rooted under one directory. Pass the result
 * straight into `createRuntime` to get a runtime whose runs, audit trail, and
 * approvals all survive a process restart.
 *
 * ```ts
 * const backend = createFileBackend("./data");
 * const runtime = createRuntime({ ...backend, connectors, workflows });
 * ```
 */

import { join } from "node:path";
import type { Store, AuditSink, ApprovalGateway } from "../ports.js";
import { FileStore } from "./file-store.js";
import { FileAuditSink } from "./file-audit.js";
import { FileApprovalGateway } from "./file-approvals.js";

export interface FileBackend {
  store: Store;
  audit: AuditSink;
  approvals: ApprovalGateway;
}

/** Create durable file-backed ports under `dir` (created if absent). */
export function createFileBackend(dir: string): FileBackend {
  return {
    store: new FileStore(join(dir, "store")),
    audit: new FileAuditSink(join(dir, "audit")),
    approvals: new FileApprovalGateway(join(dir, "approvals"))
  };
}

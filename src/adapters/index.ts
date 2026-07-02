/**
 * Built-in adapters for every port. All are in-memory / local by default, so
 * the runtime runs with nothing installed. An outer operating system can
 * substitute durable or networked adapters without touching the core.
 */

export { MemoryStore } from "./memory-store.js";
export { MemoryAuditSink } from "./memory-audit.js";
export { MemoryApprovalGateway } from "./memory-approvals.js";
export { SystemClock, ManualClock } from "./clock.js";
export { StaticSecretProvider, EnvSecretProvider } from "./secrets.js";

// Durable, file-backed adapters (survive process restarts; zero dependencies).
export { FileStore } from "./file-store.js";
export { FileAuditSink } from "./file-audit.js";
export { FileApprovalGateway } from "./file-approvals.js";
export { createFileBackend } from "./file-backend.js";
export type { FileBackend } from "./file-backend.js";

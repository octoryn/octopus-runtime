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

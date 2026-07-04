/**
 * Workflow Runtime — a standalone, governed execution runtime.
 *
 * It carries work from trigger to result across autonomy, policy, approval,
 * connector, execution, and audit boundaries. Its only job is governed
 * execution; it has no compile-time dependency on any surrounding system.
 *
 * @packageDocumentation
 */

// --- Runtime facade ------------------------------------------------------
export { Runtime, createRuntime } from "./runtime.js";
export type { RuntimeOptions } from "./runtime.js";

// --- Engine (advanced: bring-your-own ports) -----------------------------
export { Engine } from "./engine.js";
export type { EngineDeps } from "./engine.js";
export { ReadApi } from "./read.js";
export type { ReadApiDeps } from "./read.js";

// --- Autonomy ------------------------------------------------------------
export {
  AutonomyLevel,
  ALL_AUTONOMY_LEVELS,
  autonomyRank,
  autonomyAtLeast,
  minAutonomy,
  mostRestrictive
} from "./autonomy.js";

// --- Workflow / conditions / policy / gate -------------------------------
export { defineWorkflow, matchSource, validatePlan } from "./workflow.js";
export type { Workflow, WorkflowContext } from "./workflow.js";
export { evaluateConditions } from "./conditions.js";
export type { Condition, ConditionContext, ConditionEvaluation, ConditionResult } from "./conditions.js";
export { decide } from "./policy.js";
export type { Policy, PolicyContext, PolicyRuling, PolicyDecision, AppliedConstraint } from "./policy.js";
export { routeFor, routeRenders, routeExecutes } from "./gate.js";
export type { GateRoute } from "./gate.js";

// --- Tool adapter (govern an existing tool) ------------------------------
export { governTool } from "./tool.js";
export type { GovernToolOptions, GovernedResult } from "./tool.js";

// --- Decision evidence (verifiable audit trail of a routing decision) -----
// Built on the first-party octopus-evidence primitive: turns an autonomy
// routing decision into a tamper-evident, verifiable Evidence.
export { decisionEvidence } from "./decision-evidence.js";
export type { RoutingDecision, DecisionEvidenceOptions } from "./decision-evidence.js";
export { verifyEvidence } from "octopus-evidence";
export type { Evidence, Ref, Provenance, EvidenceKind, JsonValue } from "octopus-evidence";

// --- Connectors ----------------------------------------------------------
export { defineConnector, defineAction, ConnectorRegistry } from "./connector.js";
export type { Connector, ActionDefinition, ConnectorContext, ExecuteOutcome } from "./connector.js";

// --- Approvals -----------------------------------------------------------
export type { Approval, ApprovalDecision, ApprovalStatus } from "./approvals.js";

// --- Ports ---------------------------------------------------------------
export type { Clock, Store, AuditSink, ApprovalGateway, SecretProvider, Transactor, StateChange } from "./ports.js";

// --- Identity & authorization ports (open seams the commercial edition adapts) -
// Additive: `who may act`, orthogonal to autonomy (`how far`). The defaults
// preserve today's single-user behaviour exactly — an SSO/RBAC adapter swaps in
// without touching the core.
export type { Principal, IdentityProvider, Authorizer } from "./ports.js";
export { localIdentity, allowAll, LOCAL_PRINCIPAL } from "./ports.js";

// --- Adapters (in-memory / local defaults) -------------------------------
export {
  MemoryStore,
  MemoryAuditSink,
  MemoryApprovalGateway,
  SystemClock,
  ManualClock,
  StaticSecretProvider,
  EnvSecretProvider,
  FileStore,
  FileAuditSink,
  FileApprovalGateway,
  createFileBackend
} from "./adapters/index.js";
export type { FileBackend } from "./adapters/index.js";

// --- Domain types --------------------------------------------------------
export type {
  TriggerEvent,
  Correlation,
  PlannedAction,
  RenderedAction,
  EffectRef,
  ErrorInfo,
  Outcome,
  ExecutionResult,
  RunStatus,
  RunRecord,
  Boundary,
  AuditRecord
} from "./types.js";

// --- Ids -----------------------------------------------------------------
export { newId, idempotencyKey, compositeKey } from "./ids.js";

// --- Errors --------------------------------------------------------------
export {
  RuntimeError,
  ValidationError,
  ConfigurationError,
  NotFoundError,
  AuthorizationError,
  TimeoutError
} from "./errors.js";

// --- Schema (zero-dependency; any `Schema<T>` such as Zod also works) -----
export * as schema from "./schema.js";
export type { Schema, Infer } from "./schema.js";

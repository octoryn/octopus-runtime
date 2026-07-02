/**
 * Core domain types shared across the runtime.
 *
 * The pipeline these describe:
 *
 * ```
 * Trigger → Conditions → Policies → Action Plan → Autonomy Gate
 *        → Approval Gate → Connector Render/Execute → Result → Audit Record
 * ```
 */

import type { AutonomyLevel } from "./autonomy.js";

/**
 * Optional keys linking runtime activity back to external entities. These are
 * opaque to the runtime; they exist so an outer operating system can correlate
 * predictions and effects with the world without the runtime knowing what that
 * world is.
 */
export type Correlation = Record<string, string>;

/** A normalized inbound event. The only way work enters the runtime. */
export interface TriggerEvent<Payload = unknown> {
  /** Stable, unique id. Used to derive idempotency keys. */
  id: string;
  /** Logical source, e.g. `"github.pull_request"`, `"cron.daily"`, `"manual"`. */
  source: string;
  /** ISO-8601 timestamp of when the event occurred. */
  occurredAt: string;
  /**
   * Event body. Opaque to the core; typed by the workflow that consumes it.
   * Must be structured-cloneable (plain data) so it can be persisted and audited.
   */
  payload: Payload;
  /** Optional correlation keys for the outer OS layer. */
  correlation?: Correlation;
}

/**
 * A declaratively planned action. Produced by a workflow's planner without any
 * side effects. Dependencies are expressed by `ref`, so ordering and (later)
 * parallelism can be derived without changing the action shape.
 */
export interface PlannedAction<Input = unknown> {
  /** Stable id for this action *within its run*. Referenced by `dependsOn`. */
  ref: string;
  /** Which connector performs this action. */
  connectorId: string;
  /** The connector action type, e.g. `"email.send"`. */
  actionType: string;
  /** Raw input; validated against the action's schema before render. */
  input: Input;
  /** The autonomy level this action requests. Capped by policy, never raised. */
  requestedAutonomy: AutonomyLevel;
  /** Refs of actions in the same run that must succeed first (fail-closed). */
  dependsOn?: string[];
}

/**
 * The concrete, side-effect-free product of a connector's `render`. This is
 * what Shadow records as a prediction and what Draft holds for approval.
 */
export interface RenderedAction {
  /** Human-readable summary of the effect that would occur. */
  preview: string;
  /**
   * Machine payload handed to `execute` (never mutated by the engine). Must be
   * structured-cloneable plain data — it is persisted for Draft approval.
   */
  payload: unknown;
}

/** A reference to something changed in the outside world, for audit. */
export interface EffectRef {
  /** Kind of external artifact, e.g. `"email.message"`, `"github.comment"`. */
  kind: string;
  /** External id of the artifact. */
  id: string;
  /** Optional URL or locator. */
  url?: string;
}

/** Structured error information recorded on a failed result. */
export interface ErrorInfo {
  name: string;
  message: string;
}

/**
 * The terminal state of a single planned action.
 *
 * - `observed`  — Observe: recorded; nothing rendered or executed.
 * - `predicted` — Shadow: rendered a prediction; not executed.
 * - `drafted`   — Draft: rendered and an approval was created; awaiting decision.
 * - `executed`  — Autonomous or approved Draft: the effect was performed.
 * - `rejected`  — a Draft approval was rejected.
 * - `expired`   — a Draft approval passed its TTL before a decision (fail-closed).
 * - `denied`    — policy denied the action outright.
 * - `skipped`   — a dependency was not satisfied (fail-closed).
 * - `failed`    — render or execute threw, or a connector call timed out.
 */
export type Outcome =
  | "observed"
  | "predicted"
  | "drafted"
  | "executed"
  | "rejected"
  | "expired"
  | "denied"
  | "skipped"
  | "failed";

/** The record produced for every planned action, at every autonomy level. */
export interface ExecutionResult {
  runId: string;
  workflowId: string;
  /** The planned action's `ref`. */
  actionRef: string;
  connectorId: string;
  actionType: string;
  /** Autonomy the action requested. */
  requestedAutonomy: AutonomyLevel;
  /** Autonomy actually applied after policy = min(requested, all policies). */
  effectiveAutonomy: AutonomyLevel;
  outcome: Outcome;
  /** Present from Shadow onward (whenever render ran). */
  rendered?: RenderedAction;
  /** Present when `execute` ran and returned. */
  output?: unknown;
  /** External artifacts touched, for audit. */
  effectRefs?: EffectRef[];
  /** Id of the approval created for a Draft action. */
  approvalId?: string;
  /** Populated for `denied`, `skipped`, `rejected`, and `failed`. */
  reason?: string;
  error?: ErrorInfo;
  startedAt: string;
  finishedAt: string;
}

/** Status of a whole workflow run. */
export type RunStatus = "completed" | "halted";

/** The record of a single workflow execution over one event. */
export interface RunRecord {
  id: string;
  workflowId: string;
  event: TriggerEvent;
  status: RunStatus;
  /** Set when `status === "halted"` (e.g. a condition was not met). */
  haltedReason?: string;
  results: ExecutionResult[];
  startedAt: string;
  finishedAt: string;
}

/** The pipeline boundary an audit record was emitted at. */
export type Boundary =
  | "trigger"
  | "condition"
  | "policy"
  | "plan"
  | "autonomy_gate"
  | "approval_gate"
  | "connector_render"
  | "connector_execute"
  | "result"
  | "approval_decision";

/** An append-only audit entry. Emitted at every boundary the pipeline crosses. */
export interface AuditRecord {
  id: string;
  at: string;
  boundary: Boundary;
  /** Short machine code, e.g. `"trigger.received"`, `"gate.routed"`. */
  event: string;
  runId?: string;
  workflowId?: string;
  actionRef?: string;
  /** Structured, boundary-specific detail. */
  detail?: Record<string, unknown>;
}

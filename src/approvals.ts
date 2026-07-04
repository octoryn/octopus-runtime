/**
 * Approvals — the artifact produced by Draft-mode actions.
 *
 * A Draft action renders its effect and creates a `pending` approval. Execution
 * is impossible until the approval is granted. Resolving an approval is a
 * distinct, explicit step (see `Runtime.resolveApproval`), which guarantees no
 * effect occurs without a recorded human decision.
 */

import type { AutonomyLevel } from "./autonomy.js";
import type { RenderedAction } from "./types.js";
import type { Principal } from "./ports.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/** A request for human approval of a rendered (but not executed) action. */
export interface Approval {
  id: string;
  status: ApprovalStatus;
  runId: string;
  workflowId: string;
  actionRef: string;
  connectorId: string;
  actionType: string;
  /** The autonomy the action requested. */
  requestedAutonomy: AutonomyLevel;
  /** Stable idempotency key for the eventual execute (survives redelivery). */
  idempotencyKey: string;
  /** The concrete, side-effect-free render awaiting approval. */
  rendered: RenderedAction;
  createdAt: string;
  /**
   * Wall-clock deadline (ISO-8601) after which a still-pending approval is
   * expired, fail-closed. Absent means the approval never expires.
   */
  expiresAt?: string;
  /** Set once resolved (approved/rejected) or expired. */
  decidedAt?: string;
  /** Identifier of whoever decided; opaque to the runtime. */
  decidedBy?: string;
  /** Optional free-text note captured with the decision. */
  note?: string;
}

/** A decision applied to a pending approval. */
export interface ApprovalDecision {
  approved: boolean;
  /**
   * Who made the decision — unverified free-text, opaque to the runtime. It is
   * the recorded attribution **only when no {@link principal} is supplied**. When
   * a verified principal is present, that principal's `id` is the authoritative
   * attribution written to the approval and audit trail, and this field is
   * ignored for attribution — so a caller cannot record a decision under an
   * identity they were not authenticated as.
   */
  decidedBy: string;
  note?: string;
  /**
   * The verified actor making this decision. Obtain it from an
   * {@link IdentityProvider}; never build it from unverified request input on a
   * trusted path. Its `id` becomes the recorded attribution (in the approval's
   * `decidedBy` and the `approval.decided` audit record) whenever it is present.
   * Required when an {@link Authorizer} is configured — it is the subject of the
   * `"approval.decide"` check and a decision without it fails closed. Purely
   * additive: existing callers that pass no principal are attributed by
   * `decidedBy` exactly as before.
   */
  principal?: Principal;
}

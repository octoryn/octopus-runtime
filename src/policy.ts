/**
 * Policies — the governance layer that decides how far an action may go.
 *
 * The defining invariant is **monotonicity**: a policy may only lower the
 * effective autonomy, force approval, add constraints, or deny — it can never
 * raise autonomy above what the action requested. The effective autonomy is
 * therefore `min(requested, every policy's cap)`, and combining more policies
 * can only make the system more restrictive. This is what makes adding a policy
 * always safe.
 */

import { AutonomyLevel, minAutonomy } from "./autonomy.js";
import type { PlannedAction, TriggerEvent } from "./types.js";
import type { Clock } from "./ports.js";

/**
 * A recorded, audit-only annotation describing a constraint a policy applied.
 * Enforcement lives in the policy itself (which returns `deny`/`cap` when a
 * limit is exceeded); this is the durable trace of what was applied and why.
 */
export interface AppliedConstraint {
  /** Constraint kind, e.g. `"rate_limit"`, `"recipient_allowlist"`. */
  type: string;
  detail?: Record<string, unknown>;
}

/** What a single policy returns for one action. */
export interface PolicyRuling {
  /**
   * Cap the effective autonomy at this level or lower. Values above the current
   * effective level are ignored (a policy cannot raise autonomy).
   */
  cap?: AutonomyLevel;
  /** Force human approval before any execution (downgrades Autonomous to Draft). */
  requireApproval?: boolean;
  /** Deny the action outright with this reason. */
  deny?: string;
  /** Audit annotations for constraints this policy applied. */
  constraints?: AppliedConstraint[];
}

/** Context a policy evaluates against. */
export interface PolicyContext<Payload = unknown> {
  event: TriggerEvent<Payload>;
  action: PlannedAction;
  runId: string;
  workflowId: string;
  clock: Clock;
}

/** A named governance rule. */
export interface Policy<Payload = unknown> {
  /** Stable id, recorded in the audit trail. */
  id: string;
  evaluate(ctx: PolicyContext<Payload>): PolicyRuling | Promise<PolicyRuling>;
}

/** The combined decision across all policies for one action. */
export interface PolicyDecision {
  requestedAutonomy: AutonomyLevel;
  /** `min(requested, all caps)` — always ≤ requested. */
  effectiveAutonomy: AutonomyLevel;
  /** True if approval is required before execution. */
  requiresApproval: boolean;
  /** Set when any policy denied the action; the run records `denied`. */
  denied?: string;
  constraints: AppliedConstraint[];
  /** Ids of policies that actually contributed a restriction. */
  appliedPolicies: string[];
}

/**
 * Combine every policy's ruling into a single monotonic decision.
 *
 * Guarantees:
 * - `effectiveAutonomy` starts at `requested` and only ever decreases.
 * - A `cap` above the current effective level contributes nothing.
 * - The first `deny` wins and is recorded.
 */
export async function decide<Payload>(
  policies: readonly Policy<Payload>[],
  ctx: PolicyContext<Payload>
): Promise<PolicyDecision> {
  const requested = ctx.action.requestedAutonomy;
  let effective = requested;
  let requiresApproval = false;
  let denied: string | undefined;
  const constraints: AppliedConstraint[] = [];
  const appliedPolicies: string[] = [];

  for (const policy of policies) {
    let ruling: PolicyRuling;
    try {
      ruling = await policy.evaluate(ctx);
    } catch (err) {
      // Fail-closed, exactly like conditions/render/execute: a policy that
      // throws denies the action rather than aborting the whole run. The
      // effect never fires and the outcome is still recorded and audited.
      const message = err instanceof Error ? err.message : String(err);
      if (denied === undefined) denied = `policy_evaluation_failed: ${message}`;
      appliedPolicies.push(policy.id);
      continue;
    }
    let contributed = false;

    if (ruling.cap !== undefined) {
      const capped = minAutonomy(effective, ruling.cap);
      if (capped !== effective) {
        effective = capped;
        contributed = true;
      }
    }
    if (ruling.requireApproval === true && !requiresApproval) {
      requiresApproval = true;
      contributed = true;
    }
    if (ruling.deny !== undefined && denied === undefined) {
      denied = ruling.deny;
      contributed = true;
    }
    if (ruling.constraints && ruling.constraints.length > 0) {
      constraints.push(...ruling.constraints);
      contributed = true;
    }

    if (contributed) appliedPolicies.push(policy.id);
  }

  const decision: PolicyDecision = {
    requestedAutonomy: requested,
    effectiveAutonomy: effective,
    requiresApproval,
    constraints,
    appliedPolicies
  };
  if (denied !== undefined) decision.denied = denied;
  return decision;
}

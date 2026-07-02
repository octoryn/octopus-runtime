/**
 * The gate — translates a {@link PolicyDecision} into the single route an
 * action takes. This is the point where the autonomy and approval gates are
 * resolved into one decision the engine acts on.
 *
 * The routing is total and side-effect free, which makes the core safety
 * property directly testable: `autonomous` is reachable only when the effective
 * autonomy is Autonomous *and* no policy required approval.
 */

import { AutonomyLevel } from "./autonomy.js";
import type { PolicyDecision } from "./policy.js";

/**
 * Where an action goes after governance:
 * - `denied`     — a policy blocked it; no render, no execute.
 * - `observe`    — record only; no render, no execute.
 * - `shadow`     — render a prediction; never execute.
 * - `draft`      — render and create an approval; execute only once approved.
 * - `autonomous` — render and execute now.
 */
export type GateRoute = "denied" | "observe" | "shadow" | "draft" | "autonomous";

/** Resolve the single route for an action from its policy decision. */
export function routeFor(decision: PolicyDecision): GateRoute {
  if (decision.denied !== undefined) return "denied";

  switch (decision.effectiveAutonomy) {
    case AutonomyLevel.Observe:
      return "observe";
    case AutonomyLevel.Shadow:
      return "shadow";
    case AutonomyLevel.Draft:
      return "draft";
    case AutonomyLevel.Autonomous:
      // A required approval downgrades autonomous execution to a draft. This is
      // still monotonic: it only ever lowers what happens, never raises it.
      return decision.requiresApproval ? "draft" : "autonomous";
  }
}

/** Whether a given route will call the connector's pure `render`. */
export function routeRenders(route: GateRoute): boolean {
  return route === "shadow" || route === "draft" || route === "autonomous";
}

/** Whether a given route will call the connector's side-effectful `execute`. */
export function routeExecutes(route: GateRoute): boolean {
  return route === "autonomous";
}

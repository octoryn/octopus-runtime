/**
 * Conditions — pure predicates that decide whether a workflow proceeds.
 *
 * Conditions must be side-effect free and deterministic: they gate whether a
 * run happens, never *how far* an action goes (that is autonomy's job). Purity
 * is what keeps runs reproducible and Shadow predictions meaningful. A
 * condition that throws is treated as failed — the run halts, fail-closed.
 */

import type { ErrorInfo, TriggerEvent } from "./types.js";
import { toErrorInfo } from "./internal.js";

/** Read-only context handed to each condition. */
export interface ConditionContext<Payload = unknown> {
  event: TriggerEvent<Payload>;
  runId: string;
  workflowId: string;
}

/** A named, pure predicate over the triggering event. */
export interface Condition<Payload = unknown> {
  /** Stable id, recorded in the audit trail. */
  id: string;
  test(ctx: ConditionContext<Payload>): boolean;
}

/** The evaluation of one condition. */
export interface ConditionEvaluation {
  conditionId: string;
  passed: boolean;
  /** Present when the condition threw (counts as not passed). */
  error?: ErrorInfo;
}

/** Aggregate result of evaluating a workflow's conditions in order. */
export interface ConditionResult {
  passed: boolean;
  evaluations: ConditionEvaluation[];
}

/**
 * Evaluate conditions in order, short-circuiting on the first failure. A throw
 * is caught and recorded as a failed condition (fail-closed).
 */
export function evaluateConditions<Payload>(
  conditions: readonly Condition<Payload>[],
  ctx: ConditionContext<Payload>,
): ConditionResult {
  const evaluations: ConditionEvaluation[] = [];
  for (const condition of conditions) {
    try {
      const passed = condition.test(ctx);
      evaluations.push({ conditionId: condition.id, passed });
      if (!passed) return { passed: false, evaluations };
    } catch (err) {
      evaluations.push({
        conditionId: condition.id,
        passed: false,
        error: toErrorInfo(err),
      });
      return { passed: false, evaluations };
    }
  }
  return { passed: true, evaluations };
}

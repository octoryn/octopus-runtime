/**
 * Workflow definition — binds triggers, conditions, policies, and an action
 * planner together. A workflow owns *what* work to do; the engine owns *how*
 * safely it happens.
 */

import type { Condition } from "./conditions.js";
import type { Policy } from "./policy.js";
import type { PlannedAction, TriggerEvent } from "./types.js";
import { ConfigurationError } from "./errors.js";

/** Context handed to a workflow's planner. */
export interface WorkflowContext<Payload = unknown> {
  event: TriggerEvent<Payload>;
  runId: string;
  workflowId: string;
}

/** A governed unit of work. */
export interface Workflow<Payload = unknown> {
  /** Stable, unique workflow id. */
  id: string;
  name?: string;
  /** Returns true for events this workflow should handle. */
  match(event: TriggerEvent<Payload>): boolean;
  /** Pure predicates gating whether the run proceeds. */
  conditions?: Condition<Payload>[];
  /** Governance rules applied to every planned action. */
  policies?: Policy<Payload>[];
  /**
   * Produce the actions to perform, declaratively and without side effects.
   * Dependencies between actions are expressed via `dependsOn` referencing
   * earlier actions' `ref`s.
   */
  plan(ctx: WorkflowContext<Payload>): PlannedAction[] | Promise<PlannedAction[]>;
}

/** Define a workflow with payload-type inference across its members. */
export function defineWorkflow<Payload = unknown>(
  workflow: Workflow<Payload>,
): Workflow<Payload> {
  return workflow;
}

/** A `match` predicate that accepts events from any of the given sources. */
export function matchSource(...sources: string[]): (event: TriggerEvent) => boolean {
  const set = new Set(sources);
  return (event) => set.has(event.source);
}

/**
 * Validate a planned action list for a sequential (v0) run: unique refs, and
 * every `dependsOn` must reference an action appearing earlier in the list.
 * Throws {@link ConfigurationError} on violation.
 */
export function validatePlan(workflowId: string, actions: readonly PlannedAction[]): void {
  const seen = new Set<string>();
  for (const action of actions) {
    if (seen.has(action.ref)) {
      throw new ConfigurationError(
        `workflow "${workflowId}" planned duplicate action ref "${action.ref}"`,
      );
    }
    for (const dep of action.dependsOn ?? []) {
      if (!seen.has(dep)) {
        throw new ConfigurationError(
          `workflow "${workflowId}" action "${action.ref}" depends on "${dep}", ` +
            `which must appear earlier in a sequential plan`,
        );
      }
    }
    seen.add(action.ref);
  }
}

/**
 * Govern an existing tool.
 *
 * `governTool` wraps any async tool function — a LangChain tool's `func`, a
 * CrewAI/agent tool, a plain `(input) => output` — so its side effect passes
 * through the same autonomy gate the runtime uses. You do **not** rewrite the
 * agent: you wrap the tool it already calls.
 *
 * The structural guarantee is preserved by construction: the wrapped `fn` is
 * invoked **only** on the `autonomous` route, or on a `draft` route after an
 * explicit approval. At `observe` / `shadow` / `denied` (or an un-approved
 * `draft`) the side effect is unreachable — it is never called. Routing is
 * delegated to the runtime's real {@link routeFor} gate, not reimplemented, so
 * `min(requested, ceiling)` and "approval downgrades autonomous to draft" hold
 * exactly as they do inside the engine.
 *
 * This is the ergonomic, single-tool entry point. For full policy evaluation,
 * connectors, and an audit trail, define the effect as a runtime connector and
 * run it through {@link Engine} instead.
 */
import { AutonomyLevel, minAutonomy } from "./autonomy.js";
import { routeFor, routeRenders, type GateRoute } from "./gate.js";
import type { PolicyDecision } from "./policy.js";

export interface GovernToolOptions<Input> {
  /** Requested autonomy for this tool's effect. */
  readonly autonomy: AutonomyLevel;
  /**
   * A cap on autonomy (e.g. from a policy or per-environment ceiling). The
   * effective level is `min(autonomy, ceiling)` — adding a ceiling can only ever
   * lower what happens, never raise it.
   */
  readonly ceiling?: AutonomyLevel;
  /** Require an approval before executing (downgrades `autonomous` to `draft`). */
  readonly requiresApproval?: boolean;
  /**
   * A pure preview of the effect, shown at `shadow` / `draft` without running it
   * (e.g. "would POST to /users with {…}"). Never has a side effect.
   */
  readonly render?: (input: Input) => unknown;
  /**
   * Approve (or decline) a drafted effect. Called only on the `draft` route;
   * return `true` to allow execution. Absent ⇒ drafts are never executed.
   */
  readonly approve?: (request: { input: Input; preview: unknown; level: AutonomyLevel }) => boolean | Promise<boolean>;
  /** Optional name, echoed on the result for logging. */
  readonly name?: string;
}

/** The outcome of a governed tool invocation. */
export type GovernedResult<Output> =
  | {
      readonly executed: true;
      readonly route: "autonomous" | "draft";
      readonly level: AutonomyLevel;
      readonly output: Output;
      readonly preview?: unknown;
      readonly name?: string;
    }
  | {
      readonly executed: false;
      readonly route: GateRoute;
      readonly level: AutonomyLevel;
      readonly preview?: unknown;
      readonly name?: string;
    };

/**
 * Wrap `fn` so its side effect only fires under governed autonomy. Returns a
 * function with the same input that resolves to a {@link GovernedResult}.
 */
export function governTool<Input, Output>(
  fn: (input: Input) => Output | Promise<Output>,
  options: GovernToolOptions<Input>
): (input: Input) => Promise<GovernedResult<Output>> {
  const effective = options.ceiling !== undefined ? minAutonomy(options.autonomy, options.ceiling) : options.autonomy;

  return async (input: Input): Promise<GovernedResult<Output>> => {
    // A minimal decision fed to the runtime's real gate — same routing the
    // engine uses, so the structural safety property is shared, not copied.
    const decision: PolicyDecision = {
      requestedAutonomy: options.autonomy,
      effectiveAutonomy: effective,
      requiresApproval: options.requiresApproval ?? false,
      constraints: [],
      appliedPolicies: []
    };
    const route = routeFor(decision);
    const preview = routeRenders(route) && options.render !== undefined ? options.render(input) : undefined;
    const base = {
      level: effective,
      ...(preview !== undefined ? { preview } : {}),
      ...(options.name !== undefined ? { name: options.name } : {})
    };

    if (route === "autonomous") {
      return { executed: true, route, output: await fn(input), ...base };
    }
    if (route === "draft") {
      const approved =
        options.approve !== undefined ? await options.approve({ input, preview, level: effective }) : false;
      if (approved) {
        return { executed: true, route, output: await fn(input), ...base };
      }
    }
    // observe / shadow / denied / un-approved draft — fn is never called.
    return { executed: false, route, ...base };
  };
}

/**
 * Turn an autonomy **routing decision** into a tamper-evident, verifiable
 * {@link Evidence} — an audit trail of *why* the agent was (or was not) allowed
 * to act.
 *
 * A {@link GovernedResult} answers "what happened": which route the action took
 * and whether its effect ran. This module lifts that answer into the shared
 * `octopus-evidence` primitive so the decision becomes a canonical, hashable,
 * attributable record — the EU AI Act Art. 12 "automatic logging of decisions"
 * story in code. Anyone can recompute the hash and confirm the record has not
 * been altered after the fact; with an `integritySecret` the whole record (kind,
 * subject, actor, content, provenance) is bound under a keyed HMAC so no field
 * can be forged without the key.
 *
 * This is a *pure mapping*: it changes no routing behavior, no autonomy
 * semantics, and no `governTool` result shape. It only reads a decision that was
 * already made and writes down a verifiable trace of it.
 */

import { createEvidence, type Evidence, type JsonValue, type Ref } from "octopus-evidence";
import type { AutonomyLevel } from "./autonomy.js";
import type { GateRoute } from "./gate.js";
import type { GovernedResult } from "./tool.js";
import type { Clock } from "./ports.js";

/**
 * The routing decision `decisionEvidence` records. A {@link GovernedResult} —
 * the value {@link governTool} returns — is the canonical input: it carries the
 * resolved `route`, whether the effect `executed`, the effective `level`, and
 * any `preview`. It is the one shape in the runtime that holds the full routing
 * outcome, so it is what we attest.
 */
export type RoutingDecision<Output = unknown> = GovernedResult<Output>;

export interface DecisionEvidenceOptions {
  /**
   * Source of time. Injected so evidence is deterministic under test and so we
   * never call `Date.now()` at module scope. Defaults to the system clock only
   * when neither a clock nor an explicit `at` is supplied.
   */
  readonly clock?: Clock;
  /**
   * Explicit RFC 3339 production timestamp. Takes precedence over `clock`. Supply
   * this (or a fixed `clock`) to get byte-identical evidence for identical
   * decisions.
   */
  readonly at?: string;
  /**
   * The tool/action identifier this decision is about. When omitted, the
   * decision's own `name` is used; when that is also absent the subject is empty.
   */
  readonly subject?: string;
  /** The agent/actor the decision is attributed to, if any. */
  readonly actor?: Ref;
  /** The autonomy this action requested, before any ceiling or policy cap. */
  readonly requestedAutonomy?: AutonomyLevel;
  /** The ceiling (per-environment or policy cap) applied to the request, if any. */
  readonly ceiling?: AutonomyLevel;
  /** A human-readable rationale, e.g. a denial reason or an approval note. */
  readonly reason?: string;
  /**
   * Key the integrity hash (HMAC) so no field of the evidence can be forged or
   * altered without the secret. Passed straight through to `createEvidence`.
   */
  readonly integritySecret?: string;
}

/** The evidence `kind` for a routing decision on a given route. */
function kindFor(route: GateRoute): string {
  return `governed-decision:${route}`;
}

/**
 * Coerce an arbitrary rendered `preview` into a guaranteed-canonicalizable
 * {@link JsonValue}, so recording a decision **never throws on the display
 * value**. A `preview` comes from a caller-supplied `render` and can hold
 * anything — `undefined` from an optional field, `NaN`/`Infinity` from a
 * computed ratio, a `bigint`, a function, even a cycle. An audit record must
 * survive all of them: losing the whole decision because its human-facing
 * preview isn't JSON-clean would defeat the point. So we coerce lossily —
 * dropping `undefined`/functions/symbols, stringifying `bigint`, nulling
 * non-finite numbers, and breaking cycles — rather than dereferencing blindly.
 * Returns `undefined` when nothing is representable (caller omits the field).
 */
function toJsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonValue | undefined {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return value.toString();
    case "object": {
      if (value === null) return null;
      if (seen.has(value)) return undefined; // ancestor cycle → not representable
      seen.add(value);
      let result: JsonValue;
      if (Array.isArray(value)) {
        // Holes / undefined / unrepresentable become null to preserve length.
        result = value.map((el) => toJsonSafe(el, seen) ?? null);
      } else {
        const out: Record<string, JsonValue> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          const safe = toJsonSafe(v, seen);
          if (safe !== undefined) out[k] = safe;
        }
        result = out;
      }
      seen.delete(value); // backtrack so shared (non-cyclic) refs aren't dropped
      return result;
    }
    default:
      // undefined, function, symbol → not representable
      return undefined;
  }
}

/**
 * Map a routing decision to a canonical, verifiable {@link Evidence}.
 *
 * - `kind`       — `governed-decision:${route}` (e.g. `governed-decision:autonomous`).
 * - `subject`    — the tool/action as a `Ref` (`{ type: "tool", id: name }`), if named.
 * - `actor`      — the agent/actor, when the decision carries one via options.
 * - `content`    — the decision detail: requested autonomy, ceiling, resolved
 *                  route, `executed`, and reason/preview, as canonical JSON.
 * - `provenance` — `{ source: "octopus-runtime", method: "autonomy-gate", at }`,
 *                  where `at` comes from `options.at` or the injected clock.
 *
 * The result verifies with {@link verifyEvidence}; two identical decisions at the
 * same `at` produce byte-identical evidence.
 */
export function decisionEvidence<Output>(
  decision: RoutingDecision<Output>,
  options: DecisionEvidenceOptions = {}
): Evidence {
  const at = options.at ?? (options.clock ?? { now: (): Date => new Date() }).now().toISOString();

  const subjectId = options.subject ?? decision.name;
  const subject: Ref[] = subjectId !== undefined ? [{ type: "tool", id: subjectId }] : [];

  const content: Record<string, JsonValue> = {
    route: decision.route,
    effectiveAutonomy: decision.level,
    executed: decision.executed
  };
  if (options.requestedAutonomy !== undefined) content.requestedAutonomy = options.requestedAutonomy;
  if (options.ceiling !== undefined) content.ceiling = options.ceiling;
  if (options.reason !== undefined) content.reason = options.reason;
  // `preview` is `unknown` on the result and comes from a caller `render`, so
  // coerce it to a canonical JsonValue rather than casting — a non-JSON preview
  // must never crash the audit record (see `toJsonSafe`).
  if (decision.preview !== undefined) {
    const safePreview = toJsonSafe(decision.preview);
    if (safePreview !== undefined) content.preview = safePreview;
  }

  return createEvidence(
    {
      kind: kindFor(decision.route),
      subject,
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
      content,
      provenance: { source: "octopus-runtime", method: "autonomy-gate", at }
    },
    options.integritySecret !== undefined ? { integritySecret: options.integritySecret } : undefined
  );
}

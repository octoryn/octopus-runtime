/**
 * Id generation.
 *
 * Ids combine a prefix with a UUID so they are globally unique and greppable
 * by kind (`run_…`, `res_…`, `apr_…`, `aud_…`, `evt_…`). Timestamps come from
 * the injected {@link Clock}, not from ids, so runs stay deterministic under a
 * fake clock even though ids do not.
 */

import { randomUUID } from "node:crypto";

export type IdPrefix = "run" | "res" | "apr" | "aud" | "evt";

/** Generate a unique id with the given kind prefix. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Compose an injective key from parts. Each part is percent-encoded before
 * joining, so no part can contain the separator — `("a", "b:c")` and
 * `("a:b", "c")` therefore map to distinct keys. Used wherever a composite
 * identity is built from caller- or event-supplied strings, so an id containing
 * a separator can never collide with a different tuple.
 */
export function compositeKey(...parts: string[]): string {
  return parts.map(encodeURIComponent).join(":");
}

/**
 * Deterministic idempotency key for an action. Derived from the workflow, the
 * trigger event id, and the action ref — NOT the run id — so it is stable across
 * retries *and* across a redelivered event that produces a new run. A connector
 * that dedupes on this key therefore fires an effect at most once per
 * (workflow, event, action), even if ingestion-level dedup is bypassed.
 */
export function idempotencyKey(workflowId: string, eventId: string, actionRef: string): string {
  return compositeKey(workflowId, eventId, actionRef);
}

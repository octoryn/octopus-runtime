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
 * Deterministic idempotency key for an action within a run. Stable across
 * retries so a connector can dedupe repeated `execute` calls.
 */
export function idempotencyKey(runId: string, actionRef: string): string {
  return `${runId}:${actionRef}`;
}

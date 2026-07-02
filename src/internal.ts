/**
 * Small internal helpers shared across the engine. Not part of the public API.
 */

import type { ErrorInfo } from "./types.js";
import type { Clock } from "./ports.js";

/** Normalize any thrown value into a structured {@link ErrorInfo}. */
export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: "Error", message: String(err) };
}

/** ISO-8601 timestamp from the injected clock. */
export function nowIso(clock: Clock): string {
  return clock.now().toISOString();
}

/**
 * Coerce arbitrary connector output into something a store can persist. Output
 * is `unknown` and may contain non-serializable values (functions, class
 * instances); those would otherwise throw when the store clones the run record,
 * losing the record of an effect that already fired. If the value cannot be
 * structured-cloned, we replace it with a marker so the effect stays recorded.
 */
export function toRecordable(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    structuredClone(value);
    return value;
  } catch {
    return { unrecordable: true, reason: "execute output is not structured-cloneable" };
  }
}

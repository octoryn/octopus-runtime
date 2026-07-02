/**
 * Small internal helpers shared across the engine. Not part of the public API.
 */

import type { ErrorInfo } from "./types.js";
import type { Clock } from "./ports.js";
import { TimeoutError } from "./errors.js";

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

/**
 * Private brand marking a timeout raised by {@link withTimeout} itself, so the
 * engine can distinguish its own timeout from a {@link TimeoutError} a connector
 * happens to throw (the class is public). Not exported.
 */
const ENGINE_TIMEOUT = Symbol("engineTimeout");

/** True only for a timeout the engine itself imposed via {@link withTimeout}. */
export function isEngineTimeout(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<symbol, unknown>)[ENGINE_TIMEOUT] === true
  );
}

/**
 * Race a promise against a wall-clock timeout. If the timeout fires first, the
 * returned promise rejects with {@link TimeoutError}. The underlying work is not
 * cancelled — a timed-out `execute` may still complete its effect — so the
 * timeout bounds how long the runtime *waits*, not the effect itself. This is
 * why connector effects must be idempotent (see `idempotencyKey`).
 *
 * Uses real timers (not the injected Clock), because it bounds actual latency.
 * A non-positive `timeoutMs` disables the timeout.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!(timeoutMs > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new TimeoutError(`${label} exceeded ${timeoutMs}ms timeout`, timeoutMs);
      (err as unknown as Record<symbol, unknown>)[ENGINE_TIMEOUT] = true;
      reject(err);
    }, timeoutMs);
    // Do not keep the event loop alive solely for this timer.
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

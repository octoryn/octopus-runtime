/**
 * Clock adapters.
 *
 * - {@link SystemClock} reads wall-clock time; the production default.
 * - {@link ManualClock} advances only when told to, making runs fully
 *   deterministic under test (stable timestamps and audit ordering).
 */

import type { Clock } from "../ports.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock the caller advances explicitly. Each `now()` reads the current instant. */
export class ManualClock implements Clock {
  #current: number;
  readonly #stepMs: number;

  /**
   * @param start   Initial instant (default: 2020-01-01T00:00:00Z).
   * @param stepMs  Amount every `now()` auto-advances, so successive reads are
   *                strictly increasing (default: 1ms). Set to 0 to freeze time.
   */
  constructor(start: Date = new Date("2020-01-01T00:00:00.000Z"), stepMs = 1) {
    this.#current = start.getTime();
    this.#stepMs = stepMs;
  }

  now(): Date {
    const at = new Date(this.#current);
    this.#current += this.#stepMs;
    return at;
  }

  /** Advance the clock by an explicit number of milliseconds. */
  advance(ms: number): void {
    this.#current += ms;
  }
}

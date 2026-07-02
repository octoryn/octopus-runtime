/**
 * Error types raised by the runtime.
 *
 * Note: policy denials, approval rejections, and connector failures are *not*
 * exceptions — they are recorded outcomes on an {@link ExecutionResult}. These
 * error classes cover programmer/configuration mistakes and input validation.
 */

/** Base class for all runtime errors. */
export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when input fails schema validation at a boundary. */
export class ValidationError extends RuntimeError {
  constructor(
    message: string,
    /** Dotted path to the offending field, or `""` for the root value. */
    readonly path: string,
  ) {
    super(message);
  }
}

/** Thrown when configuration is invalid (unknown connector, duplicate id, …). */
export class ConfigurationError extends RuntimeError {}

/** Thrown when an operation references something that does not exist. */
export class NotFoundError extends RuntimeError {}

/** Thrown when a connector call exceeds its configured wall-clock timeout. */
export class TimeoutError extends RuntimeError {
  constructor(
    message: string,
    /** Timeout in milliseconds that was exceeded. */
    readonly timeoutMs: number,
  ) {
    super(message);
  }
}

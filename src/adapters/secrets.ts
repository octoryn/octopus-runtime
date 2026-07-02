/**
 * Secret provider adapters.
 *
 * - {@link StaticSecretProvider} serves secrets from an in-memory map; useful
 *   for tests and local wiring.
 * - {@link EnvSecretProvider} reads from `process.env`.
 */

import type { SecretProvider } from "../ports.js";
import { ConfigurationError } from "../errors.js";

export class StaticSecretProvider implements SecretProvider {
  readonly #values: Record<string, string>;

  constructor(values: Record<string, string> = {}) {
    this.#values = { ...values };
  }

  get(key: string): string | undefined {
    return this.#values[key];
  }

  require(key: string): string {
    return requireOrThrow(key, this.get(key));
  }
}

export class EnvSecretProvider implements SecretProvider {
  readonly #env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#env = env;
  }

  get(key: string): string | undefined {
    return this.#env[key];
  }

  require(key: string): string {
    return requireOrThrow(key, this.get(key));
  }
}

function requireOrThrow(key: string, value: string | undefined): string {
  if (value === undefined) {
    throw new ConfigurationError(`required secret "${key}" is not set`);
  }
  return value;
}

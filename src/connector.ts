/**
 * The connector contract — the runtime's most important extension point.
 *
 * A connector is stateless and isolated. Each action it exposes splits into two
 * functions, and that split *is* the autonomy mechanism:
 *
 * - `render` is **pure**: it produces the concrete payload/preview of the
 *   effect and must have no side effects. It runs in Shadow (to record a
 *   prediction) and Draft (to hold for approval).
 * - `execute` is **side-effectful**: it performs the effect. The engine calls
 *   it *only* on the Autonomous path or after a Draft approval is granted.
 *
 * Because the engine — not the connector — decides which function runs, a
 * connector author writes both once and gets Observe/Shadow/Draft/Autonomous
 * for free, and no effect can outrun its autonomy level.
 */

import type { Schema, Infer } from "./schema.js";
import type { EffectRef, RenderedAction } from "./types.js";
import type { Clock, SecretProvider } from "./ports.js";
import { ConfigurationError } from "./errors.js";

/** Context passed to a connector's `render` and `execute`. */
export interface ConnectorContext {
  runId: string;
  workflowId: string;
  /** The planned action's ref within the run. */
  actionRef: string;
  /** Stable key for deduping repeated `execute` calls across retries. */
  idempotencyKey: string;
  /** Credentials source. Connectors must read secrets from here, not module state. */
  secrets: SecretProvider;
  clock: Clock;
}

/** What a connector's `execute` returns after performing an effect. */
export interface ExecuteOutcome {
  /**
   * Arbitrary machine output from the external system. Prefer plain data; if it
   * is not structured-cloneable the runtime records a marker in its place so the
   * effect is never left unrecorded.
   */
  output?: unknown;
  /** External artifacts touched, recorded for audit. */
  effectRefs?: EffectRef[];
}

/** One action a connector can perform. */
export interface ActionDefinition<Input = unknown> {
  /** Canonical action type, e.g. `"email.send"`. Must be unique per connector. */
  type: string;
  /** Schema that validates raw input before `render` is ever called. */
  input: Schema<Input>;
  /** PURE. Produce the concrete effect. No side effects. */
  render(input: Input, ctx: ConnectorContext): RenderedAction | Promise<RenderedAction>;
  /** SIDE-EFFECTFUL. Perform the effect. Called only when the gate permits. */
  execute(rendered: RenderedAction, ctx: ConnectorContext): ExecuteOutcome | Promise<ExecuteOutcome>;
}

/** A stateless adapter to an external system, exposing one or more actions. */
export interface Connector {
  /** Stable connector id, e.g. `"email"`. */
  id: string;
  /** Semver of the connector implementation. */
  version: string;
  /** The actions this connector exposes. */
  actions: ActionDefinition[];
}

/**
 * Define a single action with full input-type inference from its schema.
 * `render` and `execute` receive the parsed `Input` type automatically.
 */
export function defineAction<S extends Schema<unknown>>(def: {
  type: string;
  input: S;
  render(input: Infer<S>, ctx: ConnectorContext): RenderedAction | Promise<RenderedAction>;
  execute(rendered: RenderedAction, ctx: ConnectorContext): ExecuteOutcome | Promise<ExecuteOutcome>;
}): ActionDefinition<Infer<S>> {
  return def as ActionDefinition<Infer<S>>;
}

/** Define a connector, validating that its action types are unique. */
export function defineConnector(def: { id: string; version: string; actions: ActionDefinition[] }): Connector {
  const seen = new Set<string>();
  for (const action of def.actions) {
    if (seen.has(action.type)) {
      throw new ConfigurationError(`connector "${def.id}" declares duplicate action type "${action.type}"`);
    }
    seen.add(action.type);
  }
  return { id: def.id, version: def.version, actions: def.actions };
}

/**
 * In-memory registry mapping `(connectorId, actionType)` to its definition.
 * Owned by the runtime; connectors are registered at wiring time.
 */
export class ConnectorRegistry {
  readonly #connectors = new Map<string, Connector>();
  readonly #actions = new Map<string, ActionDefinition>();

  /** Register a connector. Throws on duplicate connector id. */
  register(connector: Connector): void {
    if (this.#connectors.has(connector.id)) {
      throw new ConfigurationError(`connector "${connector.id}" is already registered`);
    }
    this.#connectors.set(connector.id, connector);
    for (const action of connector.actions) {
      this.#actions.set(actionKey(connector.id, action.type), action);
    }
  }

  /** True if a connector with this id is registered. */
  has(connectorId: string): boolean {
    return this.#connectors.has(connectorId);
  }

  /** Resolve an action definition, throwing a clear error if absent. */
  resolve(connectorId: string, actionType: string): ActionDefinition {
    const action = this.#actions.get(actionKey(connectorId, actionType));
    if (!action) {
      if (!this.#connectors.has(connectorId)) {
        throw new ConfigurationError(`unknown connector "${connectorId}"`);
      }
      throw new ConfigurationError(`connector "${connectorId}" has no action "${actionType}"`);
    }
    return action;
  }

  /** All registered connectors. */
  list(): Connector[] {
    return [...this.#connectors.values()];
  }
}

function actionKey(connectorId: string, actionType: string): string {
  return `${connectorId}::${actionType}`;
}

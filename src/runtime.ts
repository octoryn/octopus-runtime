/**
 * The public runtime facade. Wires ports (defaulting to in-memory adapters),
 * registers connectors and workflows, and exposes the execution and read APIs.
 *
 * ```ts
 * const runtime = createRuntime({ connectors: [email], workflows: [welcome] });
 * await runtime.dispatch({ id, source: "signup", occurredAt, payload });
 * ```
 */

import type {
  Clock,
  Store,
  AuditSink,
  ApprovalGateway,
  SecretProvider,
  Transactor,
} from "./ports.js";
import type { Connector } from "./connector.js";
import { ConnectorRegistry } from "./connector.js";
import type { Workflow } from "./workflow.js";
import type { ApprovalDecision } from "./approvals.js";
import type { ExecutionResult, RunRecord, TriggerEvent } from "./types.js";
import { Engine } from "./engine.js";
import { ReadApi } from "./read.js";
import { ConfigurationError, NotFoundError } from "./errors.js";
import {
  MemoryStore,
  MemoryAuditSink,
  MemoryApprovalGateway,
  SystemClock,
  StaticSecretProvider,
} from "./adapters/index.js";

/** Options for constructing a {@link Runtime}. All ports default to in-memory. */
export interface RuntimeOptions {
  workflows?: Workflow[];
  connectors?: Connector[];
  clock?: Clock;
  store?: Store;
  audit?: AuditSink;
  approvals?: ApprovalGateway;
  secrets?: SecretProvider;
  /**
   * Optional atomic-commit capability. When provided (e.g. from
   * `createSqliteBackend`), resolving an approval commits its status, result,
   * and audit records in one transaction. Without it, those writes are applied
   * sequentially.
   */
  transactor?: Transactor;
  /**
   * Wall-clock timeout (ms) applied to each connector `render`/`execute`. A
   * timed-out call fails closed. Omit or set `<= 0` to disable.
   */
  connectorTimeoutMs?: number;
  /**
   * Time-to-live (ms) for Draft approvals. A pending approval past its TTL
   * expires fail-closed (call {@link Runtime.sweepExpiredApprovals} to sweep, or
   * it is enforced lazily when the approval is resolved). Omit to never expire.
   */
  approvalTtlMs?: number;
}

export class Runtime {
  /** Read-only query surface over runs, results, approvals, and audit. */
  readonly read: ReadApi;

  readonly #registry = new ConnectorRegistry();
  readonly #workflows: Workflow[] = [];
  readonly #engine: Engine;

  constructor(options: RuntimeOptions = {}) {
    const store = options.store ?? new MemoryStore();
    const audit = options.audit ?? new MemoryAuditSink();
    const approvals = options.approvals ?? new MemoryApprovalGateway();
    const clock = options.clock ?? new SystemClock();
    const secrets = options.secrets ?? new StaticSecretProvider();

    for (const connector of options.connectors ?? []) {
      this.#registry.register(connector);
    }
    for (const workflow of options.workflows ?? []) {
      this.registerWorkflow(workflow);
    }

    const engineDeps: ConstructorParameters<typeof Engine>[0] = {
      clock,
      store,
      audit,
      approvals,
      secrets,
      registry: this.#registry,
    };
    if (options.transactor !== undefined) {
      engineDeps.transactor = options.transactor;
    }
    if (options.connectorTimeoutMs !== undefined) {
      engineDeps.connectorTimeoutMs = options.connectorTimeoutMs;
    }
    if (options.approvalTtlMs !== undefined) {
      engineDeps.approvalTtlMs = options.approvalTtlMs;
    }
    this.#engine = new Engine(engineDeps, this.#workflows);
    this.read = new ReadApi({ store, audit, approvals });
  }

  /** Register a connector. Throws on duplicate connector id. */
  registerConnector(connector: Connector): void {
    this.#registry.register(connector);
  }

  /** Register a workflow. Throws on duplicate workflow id. */
  registerWorkflow(workflow: Workflow): void {
    if (this.#workflows.some((w) => w.id === workflow.id)) {
      throw new ConfigurationError(`workflow "${workflow.id}" is already registered`);
    }
    this.#workflows.push(workflow);
  }

  /** Run every workflow whose `match` accepts the event; returns one run each. */
  dispatch(event: TriggerEvent): Promise<RunRecord[]> {
    return this.#engine.dispatch(event);
  }

  /** Run one named workflow against an event. Throws if the id is unknown. */
  run(workflowId: string, event: TriggerEvent): Promise<RunRecord> {
    const workflow = this.#workflows.find((w) => w.id === workflowId);
    if (!workflow) throw new NotFoundError(`unknown workflow "${workflowId}"`);
    return this.#engine.runWorkflow(workflow, event);
  }

  /** Apply a decision to a pending approval; executes the effect iff approved. */
  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<ExecutionResult> {
    return this.#engine.resolveApproval(approvalId, decision);
  }

  /**
   * Expire any pending approvals past their TTL, fail-closed. Returns the
   * `expired` results. A host scheduler typically calls this periodically.
   */
  sweepExpiredApprovals(): Promise<ExecutionResult[]> {
    return this.#engine.sweepExpiredApprovals();
  }
}

/** Convenience factory for {@link Runtime}. */
export function createRuntime(options?: RuntimeOptions): Runtime {
  return new Runtime(options);
}

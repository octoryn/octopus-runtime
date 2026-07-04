/**
 * The execution engine — the deterministic pipeline that carries an event from
 * trigger to audited result:
 *
 * ```
 * Trigger → Conditions → Policies → Action Plan → Autonomy Gate
 *        → Approval Gate → Connector Render/Execute → Result → Audit Record
 * ```
 *
 * The engine, not connectors or workflows, decides whether `render` and
 * `execute` run, and it emits an audit record at every boundary it crosses.
 * v0 runs an action plan sequentially; dependencies are expressed via `ref`s so
 * parallelism can be added later without changing the action shape.
 */

import type {
  AuditRecord,
  Boundary,
  EffectRef,
  ExecutionResult,
  Outcome,
  PlannedAction,
  RenderedAction,
  RunRecord,
  TriggerEvent
} from "./types.js";
import type {
  Clock,
  Store,
  AuditSink,
  ApprovalGateway,
  SecretProvider,
  Transactor,
  StateChange,
  Authorizer
} from "./ports.js";
import type { Approval, ApprovalDecision } from "./approvals.js";
import type { ConnectorContext, ConnectorRegistry } from "./connector.js";
import type { Workflow } from "./workflow.js";
import { AutonomyLevel } from "./autonomy.js";
import { decide } from "./policy.js";
import { evaluateConditions } from "./conditions.js";
import { routeFor } from "./gate.js";
import { validatePlan } from "./workflow.js";
import { newId, idempotencyKey, compositeKey } from "./ids.js";
import { toErrorInfo, nowIso, toRecordable, withTimeout, isEngineTimeout } from "./internal.js";
import { AuthorizationError, ConfigurationError, NotFoundError } from "./errors.js";

/** Fully-resolved dependencies the engine runs against. */
export interface EngineDeps {
  clock: Clock;
  store: Store;
  audit: AuditSink;
  approvals: ApprovalGateway;
  secrets: SecretProvider;
  registry: ConnectorRegistry;
  /**
   * Optional authorization decision point for actions where *who may act*
   * matters — today, resolving an approval (`"approval.decide"`). When present,
   * a decision must carry a verified {@link Principal} and the authorizer must
   * allow it, or the resolve fails closed with an {@link AuthorizationError}
   * before any effect or record. When absent (the default), no check runs and
   * behaviour is byte-identical to before this port existed. This is orthogonal
   * to autonomy: it gates the actor, not how far the action may go.
   */
  authorizer?: Authorizer;
  /**
   * Optional atomic-commit capability. When present, multi-write state
   * transitions (resolving an approval: status + result + audit) commit as one
   * unit. When absent, the engine applies the writes sequentially through the
   * individual ports.
   */
  transactor?: Transactor;
  /**
   * Wall-clock timeout (ms) applied to each connector `render` and `execute`.
   * A timed-out call fails closed. `undefined` or `<= 0` disables it.
   */
  connectorTimeoutMs?: number;
  /**
   * Time-to-live (ms) for Draft approvals. A still-pending approval past its TTL
   * expires fail-closed. `undefined` disables expiry (approvals never expire).
   */
  approvalTtlMs?: number;
}

/** Outcomes that satisfy a downstream dependency; anything else fails closed. */
const SATISFYING_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["observed", "predicted", "drafted", "executed"]);

export class Engine {
  readonly #deps: EngineDeps;
  readonly #workflows: Workflow[];
  /** Approval ids currently being resolved, to serialize concurrent decisions. */
  readonly #resolving = new Set<string>();
  /** In-flight runs keyed by the (workflow, event) composite, to coalesce duplicates. */
  readonly #inflight = new Map<string, Promise<RunRecord>>();

  constructor(deps: EngineDeps, workflows: Workflow[]) {
    this.#deps = deps;
    this.#workflows = workflows;
  }

  /** Run every workflow whose `match` accepts the event; one run each. */
  async dispatch(event: TriggerEvent): Promise<RunRecord[]> {
    const matched = this.#workflows.filter((wf) => wf.match(event));
    const runs: RunRecord[] = [];
    for (const workflow of matched) {
      runs.push(await this.runWorkflow(workflow, event));
    }
    return runs;
  }

  /**
   * Run a single workflow against an event, end to end.
   *
   * Ingestion is idempotent even under concurrency: an in-flight run for the
   * same (workflow, event) is shared rather than started twice, and a completed
   * one is returned from the store. Both a redelivered *and* a concurrently
   * redelivered event resolve to a single run.
   */
  runWorkflow(workflow: Workflow, event: TriggerEvent): Promise<RunRecord> {
    const key = compositeKey(workflow.id, event.id);
    // Synchronous check-and-set (no await between) makes this atomic in JS's
    // single-threaded model, so concurrent duplicates coalesce onto one run.
    const inflight = this.#inflight.get(key);
    if (inflight) return inflight;

    const promise = this.#runOnce(workflow, event);
    this.#inflight.set(key, promise);
    return promise.finally(() => {
      if (this.#inflight.get(key) === promise) this.#inflight.delete(key);
    });
  }

  async #runOnce(workflow: Workflow, event: TriggerEvent): Promise<RunRecord> {
    // Idempotent ingestion: a redelivered event (duplicate webhook) returns the
    // existing run untouched rather than executing the workflow again.
    const existing = await this.#deps.store.findRunByEvent(workflow.id, event.id);
    if (existing) {
      await this.#auditEmitter(existing.id, workflow.id)("trigger", "trigger.deduplicated", {
        eventId: event.id
      });
      return existing;
    }

    const runId = newId("run");
    const startedAt = nowIso(this.#deps.clock);
    const workflowId = workflow.id;
    const emit = this.#auditEmitter(runId, workflowId);

    await emit("trigger", "trigger.received", {
      eventId: event.id,
      source: event.source
    });

    // --- Conditions ------------------------------------------------------
    const conditionResult = evaluateConditions(workflow.conditions ?? [], {
      event,
      runId,
      workflowId
    });
    await emit("condition", "condition.evaluated", {
      passed: conditionResult.passed,
      evaluations: conditionResult.evaluations
    });
    if (!conditionResult.passed) {
      const run: RunRecord = {
        id: runId,
        workflowId,
        event,
        status: "halted",
        haltedReason: "condition_not_met",
        results: [],
        startedAt,
        finishedAt: nowIso(this.#deps.clock)
      };
      await this.#deps.store.saveRun(run);
      return run;
    }

    // --- Plan ------------------------------------------------------------
    const planned = await workflow.plan({ event, runId, workflowId });
    validatePlan(workflowId, planned);
    await emit("plan", "plan.created", {
      actions: planned.map((a) => ({
        ref: a.ref,
        connectorId: a.connectorId,
        actionType: a.actionType,
        requestedAutonomy: a.requestedAutonomy,
        dependsOn: a.dependsOn ?? []
      }))
    });

    // --- Sequential execution -------------------------------------------
    const results: ExecutionResult[] = [];
    const byRef = new Map<string, ExecutionResult>();
    for (const action of planned) {
      const result = await this.#processAction(workflow, event, runId, action, byRef);
      results.push(result);
      byRef.set(action.ref, result);
    }

    const run: RunRecord = {
      id: runId,
      workflowId,
      event,
      status: "completed",
      results,
      startedAt,
      finishedAt: nowIso(this.#deps.clock)
    };
    try {
      await this.#deps.store.saveRun(run);
    } catch (err) {
      // A store that enforces unique ingestion (e.g. SQLite's UNIQUE(workflow,
      // event)) rejects a second run for the same event — the cross-process
      // race the in-process #inflight guard cannot cover. If another run won,
      // it is canonical and the effect was deduped by the stable idempotency
      // key; return the winner rather than surfacing a storage error.
      const winner = await this.#deps.store.findRunByEvent(workflowId, event.id);
      if (winner && winner.id !== run.id) {
        // This run lost the race and has no persisted row. Its audit trail is
        // already written under `runId`; mark it superseded so that orphaned
        // trail is self-describing rather than silently dangling.
        await emit("trigger", "run.superseded", { supersededBy: winner.id, eventId: event.id });
        return winner;
      }
      throw err;
    }
    return run;
  }

  async #processAction(
    workflow: Workflow,
    event: TriggerEvent,
    runId: string,
    action: PlannedAction,
    byRef: Map<string, ExecutionResult>
  ): Promise<ExecutionResult> {
    const startedAt = nowIso(this.#deps.clock);
    const emit = this.#auditEmitter(runId, workflow.id, action.ref);
    const base = {
      runId,
      workflowId: workflow.id,
      actionRef: action.ref,
      connectorId: action.connectorId,
      actionType: action.actionType,
      requestedAutonomy: action.requestedAutonomy
    } as const;

    // Fail-closed: a dependency that did not reach a satisfying outcome blocks
    // this action before any governance or connector work happens.
    const unmet = (action.dependsOn ?? []).filter((dep) => {
      const depResult = byRef.get(dep);
      return !depResult || !SATISFYING_OUTCOMES.has(depResult.outcome);
    });
    if (unmet.length > 0) {
      const reason = `dependency_unsatisfied: ${unmet.join(", ")}`;
      await emit("autonomy_gate", "action.skipped", { reason });
      return this.#finish(emit, {
        ...base,
        effectiveAutonomy: action.requestedAutonomy,
        outcome: "skipped",
        reason,
        startedAt
      });
    }

    // --- Policy ----------------------------------------------------------
    const decision = await decide(workflow.policies ?? [], {
      event,
      action,
      runId,
      workflowId: workflow.id,
      clock: this.#deps.clock
    });
    await emit("policy", "policy.decided", {
      requestedAutonomy: decision.requestedAutonomy,
      effectiveAutonomy: decision.effectiveAutonomy,
      requiresApproval: decision.requiresApproval,
      denied: decision.denied ?? null,
      appliedPolicies: decision.appliedPolicies,
      constraints: decision.constraints
    });

    const route = routeFor(decision);
    await emit("autonomy_gate", "gate.routed", {
      route,
      effectiveAutonomy: decision.effectiveAutonomy
    });

    const common = {
      ...base,
      effectiveAutonomy: decision.effectiveAutonomy,
      startedAt
    };

    if (route === "denied") {
      return this.#finish(emit, {
        ...common,
        outcome: "denied",
        reason: decision.denied ?? "denied_by_policy"
      });
    }

    if (route === "observe") {
      return this.#finish(emit, { ...common, outcome: "observed" });
    }

    // Everything below renders, so resolve the connector and validate input.
    const definition = this.#deps.registry.resolve(action.connectorId, action.actionType);
    const idemKey = idempotencyKey(workflow.id, event.id, action.ref);
    const cctx = this.#connectorContext(runId, workflow.id, action.ref, idemKey);

    let parsedInput: unknown;
    try {
      parsedInput = definition.input.parse(action.input);
    } catch (err) {
      await emit("connector_render", "input.invalid", { error: toErrorInfo(err) });
      return this.#finish(emit, {
        ...common,
        outcome: "failed",
        reason: "input_validation_failed",
        error: toErrorInfo(err)
      });
    }

    let rendered: RenderedAction;
    try {
      rendered = await this.#withTimeout(definition.render(parsedInput, cctx), "render");
      await emit("connector_render", "render.succeeded", { preview: rendered.preview });
    } catch (err) {
      const timedOut = isEngineTimeout(err);
      await emit("connector_render", timedOut ? "render.timed_out" : "render.failed", {
        error: toErrorInfo(err)
      });
      return this.#finish(emit, {
        ...common,
        outcome: "failed",
        reason: timedOut ? "render_timeout" : "render_failed",
        error: toErrorInfo(err)
      });
    }

    if (route === "shadow") {
      return this.#finish(emit, { ...common, outcome: "predicted", rendered });
    }

    if (route === "draft") {
      const approval = this.#createApprovalRecord(runId, workflow.id, action, idemKey, rendered);
      await this.#deps.approvals.create(approval);
      await emit("approval_gate", "approval.created", { approvalId: approval.id });
      return this.#finish(emit, {
        ...common,
        outcome: "drafted",
        rendered,
        approvalId: approval.id
      });
    }

    // route === "autonomous"
    try {
      const outcome = await this.#withTimeout(definition.execute(rendered, cctx), "execute");
      await emit("connector_execute", "execute.succeeded", {
        effectRefs: outcome.effectRefs ?? []
      });
      return this.#finish(emit, {
        ...common,
        outcome: "executed",
        rendered,
        output: toRecordable(outcome.output),
        effectRefs: outcome.effectRefs
      });
    } catch (err) {
      const timedOut = isEngineTimeout(err);
      await emit("connector_execute", timedOut ? "execute.timed_out" : "execute.failed", {
        error: toErrorInfo(err)
      });
      return this.#finish(emit, {
        ...common,
        outcome: "failed",
        reason: timedOut ? "execute_timeout" : "execute_failed",
        rendered,
        error: toErrorInfo(err)
      });
    }
  }

  /**
   * Apply a human decision to a pending approval. On approval, and only then,
   * the drafted action's rendered effect is executed. On rejection, no effect
   * occurs. Either way the outcome is audited.
   *
   * Concurrent calls for the same approval id are serialized so an approval can
   * never be resolved — or executed — twice, independent of the gateway adapter.
   */
  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<ExecutionResult> {
    if (this.#resolving.has(approvalId)) {
      throw new ConfigurationError(`approval "${approvalId}" is already being resolved`);
    }
    this.#resolving.add(approvalId);
    try {
      return await this.#applyApprovalDecision(approvalId, decision);
    } finally {
      this.#resolving.delete(approvalId);
    }
  }

  /**
   * Enforce the opt-in authorization gate for deciding an approval. No-op unless
   * an {@link Authorizer} is configured. When one is, the decision must carry a
   * verified {@link Principal} (a missing principal fails closed) and the
   * authorizer must permit `"approval.decide"` on this approval, or an
   * {@link AuthorizationError} is thrown before any state changes.
   */
  async #authorizeDecision(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const authorizer = this.#deps.authorizer;
    if (!authorizer) return;
    if (!decision.principal) {
      throw new AuthorizationError(`deciding approval "${approvalId}" requires an authenticated principal`);
    }
    const allowed = await authorizer.can(decision.principal, "approval.decide", {
      type: "approval",
      id: approvalId
    });
    if (!allowed) {
      throw new AuthorizationError(`principal "${decision.principal.id}" may not decide approval "${approvalId}"`);
    }
  }

  async #applyApprovalDecision(approvalId: string, decision: ApprovalDecision): Promise<ExecutionResult> {
    const approval = await this.#deps.approvals.get(approvalId);
    if (!approval) throw new NotFoundError(`unknown approval "${approvalId}"`);
    if (approval.status !== "pending") {
      throw new ConfigurationError(`approval "${approvalId}" is already ${approval.status}`);
    }

    // Authorization gate (opt-in): with an authorizer configured, only a
    // permitted principal may decide this approval — checked before any effect
    // or record, so a denial changes nothing. Absent an authorizer this is a
    // no-op and behaviour is unchanged.
    await this.#authorizeDecision(approvalId, decision);

    // Fail-closed on TTL: an approval decided after its deadline never executes.
    if (this.#isExpired(approval)) {
      return this.#expire(approval);
    }

    const prior = await this.#deps.store.getResult(approval.runId, approval.actionRef);
    const common = {
      runId: approval.runId,
      workflowId: approval.workflowId,
      actionRef: approval.actionRef,
      connectorId: approval.connectorId,
      actionType: approval.actionType,
      requestedAutonomy: approval.requestedAutonomy,
      effectiveAutonomy: AutonomyLevel.Draft,
      rendered: approval.rendered,
      approvalId,
      startedAt: prior?.startedAt ?? nowIso(this.#deps.clock)
    };

    // --- Rejected: no effect. Flip the approval and record the result as one
    //     atomic unit. ---
    if (!decision.approved) {
      const result = this.#finishData({ ...common, outcome: "rejected", reason: "approval_rejected" });
      await this.#commit({
        approval: this.#decide(approval, "rejected", decision),
        result,
        audit: [
          this.#decisionRecord(approval, { approved: false, decidedBy: this.#attribution(decision) }),
          this.#resultRecord(approval, result.outcome)
        ]
      });
      return result;
    }

    // --- Approved: perform the effect FIRST (outside any transaction — an
    //     external effect cannot be rolled back), then commit the decision +
    //     result + audit as ONE atomic unit. The approval stays `pending` until
    //     that commit, so a crash mid-effect leaves it re-resolvable and the
    //     effect is deduped by its stable idempotencyKey. ---
    const definition = this.#deps.registry.resolve(approval.connectorId, approval.actionType);
    const cctx = this.#connectorContext(
      approval.runId,
      approval.workflowId,
      approval.actionRef,
      approval.idempotencyKey
    );

    // Build the decision + its audit record BEFORE executing, so audit `at`
    // timestamps run in logical order: decision → execute → result. (The
    // approval only actually flips to `approved` when the commit lands, after
    // the effect.)
    const resolvedApproval = this.#decide(approval, "approved", decision);
    const audit: AuditRecord[] = [
      this.#decisionRecord(approval, { approved: true, decidedBy: this.#attribution(decision) })
    ];
    let result: ExecutionResult;
    try {
      const outcome = await this.#withTimeout(definition.execute(approval.rendered, cctx), "execute");
      audit.push(
        this.#record(
          "connector_execute",
          "execute.succeeded",
          approval.runId,
          approval.workflowId,
          approval.actionRef,
          {
            effectRefs: outcome.effectRefs ?? []
          }
        )
      );
      result = this.#finishData({
        ...common,
        outcome: "executed",
        output: toRecordable(outcome.output),
        effectRefs: outcome.effectRefs
      });
    } catch (err) {
      const timedOut = isEngineTimeout(err);
      audit.push(
        this.#record(
          "connector_execute",
          timedOut ? "execute.timed_out" : "execute.failed",
          approval.runId,
          approval.workflowId,
          approval.actionRef,
          {
            error: toErrorInfo(err)
          }
        )
      );
      result = this.#finishData({
        ...common,
        outcome: "failed",
        reason: timedOut ? "execute_timeout" : "execute_failed",
        error: toErrorInfo(err)
      });
    }
    audit.push(this.#resultRecord(approval, result.outcome));

    await this.#commit({ approval: resolvedApproval, result, audit });
    return result;
  }

  /**
   * Expire any pending approvals whose TTL has elapsed. Each becomes a fail-
   * closed `expired` result; the effect never fires. Intended to be called
   * periodically by a host scheduler. Returns the results for expired approvals.
   */
  async sweepExpiredApprovals(): Promise<ExecutionResult[]> {
    const pending = await this.#deps.approvals.list({ status: "pending" });
    const expired: ExecutionResult[] = [];
    for (const approval of pending) {
      if (!this.#isExpired(approval)) continue;
      if (this.#resolving.has(approval.id)) continue; // being decided right now
      this.#resolving.add(approval.id);
      try {
        expired.push(await this.#expire(approval));
      } finally {
        this.#resolving.delete(approval.id);
      }
    }
    return expired;
  }

  // --- helpers -----------------------------------------------------------

  #connectorContext(runId: string, workflowId: string, actionRef: string, idemKey: string): ConnectorContext {
    return {
      runId,
      workflowId,
      actionRef,
      idempotencyKey: idemKey,
      secrets: this.#deps.secrets,
      clock: this.#deps.clock
    };
  }

  #createApprovalRecord(
    runId: string,
    workflowId: string,
    action: PlannedAction,
    idemKey: string,
    rendered: RenderedAction
  ): Approval {
    const now = this.#deps.clock.now();
    const approval: Approval = {
      id: newId("apr"),
      status: "pending",
      runId,
      workflowId,
      actionRef: action.ref,
      connectorId: action.connectorId,
      actionType: action.actionType,
      requestedAutonomy: action.requestedAutonomy,
      idempotencyKey: idemKey,
      rendered,
      createdAt: now.toISOString()
    };
    const ttl = this.#deps.approvalTtlMs;
    if (ttl !== undefined && ttl > 0) {
      approval.expiresAt = new Date(now.getTime() + ttl).toISOString();
    }
    return approval;
  }

  /** True if a pending approval has passed its TTL deadline (by the clock). */
  #isExpired(approval: Approval): boolean {
    if (approval.expiresAt === undefined) return false;
    return this.#deps.clock.now().getTime() >= new Date(approval.expiresAt).getTime();
  }

  /** Mark an approval expired and record the fail-closed `expired` result atomically. */
  async #expire(approval: Approval): Promise<ExecutionResult> {
    const decidedAt = nowIso(this.#deps.clock);
    const prior = await this.#deps.store.getResult(approval.runId, approval.actionRef);
    const result = this.#finishData({
      runId: approval.runId,
      workflowId: approval.workflowId,
      actionRef: approval.actionRef,
      connectorId: approval.connectorId,
      actionType: approval.actionType,
      requestedAutonomy: approval.requestedAutonomy,
      effectiveAutonomy: AutonomyLevel.Draft,
      rendered: approval.rendered,
      approvalId: approval.id,
      outcome: "expired",
      reason: "approval_expired",
      startedAt: prior?.startedAt ?? decidedAt
    });
    await this.#commit({
      approval: { ...approval, status: "expired", decidedAt },
      result,
      audit: [
        this.#record("approval_decision", "approval.expired", approval.runId, approval.workflowId, approval.actionRef, {
          approvalId: approval.id
        }),
        this.#resultRecord(approval, result.outcome)
      ]
    });
    return result;
  }

  /** Commit a batch of state changes atomically if a transactor is available,
   *  else apply them in turn through the individual ports. */
  async #commit(change: StateChange): Promise<void> {
    if (this.#deps.transactor) {
      await this.#deps.transactor.commit(change);
      return;
    }
    if (change.approval) await this.#deps.approvals.save(change.approval);
    if (change.result) await this.#deps.store.saveResult(change.result);
    for (const record of change.audit ?? []) await this.#deps.audit.append(record);
  }

  /** Produce the resolved approval for a decision (approved/rejected). */
  /**
   * The identity attributed to a decision in durable records. When the decision
   * carries a verified {@link Principal}, that principal's `id` is authoritative
   * — it is what an {@link Authorizer} actually authorized, so the audit trail
   * must attribute the decision to it, not to the caller-supplied free-text
   * `decidedBy` (which an actor could set to anyone). With no principal (the
   * default path), `decidedBy` is the attribution exactly as before — behaviour
   * is unchanged for callers who never adopt identity.
   */
  #attribution(decision: ApprovalDecision): string {
    return decision.principal?.id ?? decision.decidedBy;
  }

  #decide(approval: Approval, status: "approved" | "rejected", decision: ApprovalDecision): Approval {
    const resolved: Approval = {
      ...approval,
      status,
      decidedAt: nowIso(this.#deps.clock),
      decidedBy: this.#attribution(decision)
    };
    if (decision.note !== undefined) resolved.note = decision.note;
    return resolved;
  }

  #decisionRecord(approval: Approval, detail: { approved: boolean; decidedBy: string }): AuditRecord {
    return this.#record(
      "approval_decision",
      "approval.decided",
      approval.runId,
      approval.workflowId,
      approval.actionRef,
      {
        approvalId: approval.id,
        ...detail
      }
    );
  }

  #resultRecord(approval: Approval, outcome: string): AuditRecord {
    return this.#record("result", "result.recorded", approval.runId, approval.workflowId, approval.actionRef, {
      outcome
    });
  }

  /** Apply the configured connector timeout (if any) to a connector call. */
  #withTimeout<T>(value: T | Promise<T>, label: string): Promise<T> {
    const promise = Promise.resolve(value);
    const ms = this.#deps.connectorTimeoutMs;
    return ms !== undefined && ms > 0 ? withTimeout(promise, ms, label) : promise;
  }

  /** Build a result, emit its terminal `result.recorded` audit, and return it. */
  async #finish(emit: AuditEmitter, data: Omit<ExecutionResult, "finishedAt">): Promise<ExecutionResult> {
    const result = this.#finishData(data);
    await emit("result", "result.recorded", { outcome: result.outcome });
    return result;
  }

  #finishData(data: Omit<ExecutionResult, "finishedAt">): ExecutionResult {
    return { ...data, finishedAt: nowIso(this.#deps.clock) };
  }

  #auditEmitter(runId: string, workflowId: string, actionRef?: string): AuditEmitter {
    return async (boundary, event, detail) => {
      await this.#deps.audit.append(this.#record(boundary, event, runId, workflowId, actionRef, detail));
    };
  }

  /** Build an audit record without appending it (for inclusion in an atomic commit). */
  #record(
    boundary: Boundary,
    event: string,
    runId: string,
    workflowId: string,
    actionRef?: string,
    detail?: Record<string, unknown>
  ): AuditRecord {
    const record: AuditRecord = {
      id: newId("aud"),
      at: nowIso(this.#deps.clock),
      boundary,
      event,
      runId,
      workflowId
    };
    if (actionRef !== undefined) record.actionRef = actionRef;
    if (detail !== undefined) record.detail = detail;
    return record;
  }
}

type AuditEmitter = (boundary: Boundary, event: string, detail?: Record<string, unknown>) => Promise<void>;

// Re-export for convenience when only the effect-ref type is needed.
export type { EffectRef };

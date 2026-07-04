/**
 * Ports — the interfaces the runtime core depends on instead of concrete
 * infrastructure. Every port ships a zero-config in-memory adapter (see
 * `src/adapters`), so the runtime runs locally with nothing installed. An outer
 * operating system substitutes real adapters without touching the core.
 *
 * Dependency arrows always point inward: the core depends on these interfaces;
 * adapters depend on the core. The core never imports an adapter.
 */

import type { AuditRecord, ExecutionResult, RunRecord } from "./types.js";
import type { Approval, ApprovalStatus } from "./approvals.js";

/** Source of time. Injectable so runs are deterministic under test. */
export interface Clock {
  /** Current instant. */
  now(): Date;
}

/** Read/write persistence for runs and their results. */
export interface Store {
  saveRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  listRuns(): Promise<RunRecord[]>;
  /** Persist or replace a single action result (used when a draft later executes). */
  saveResult(result: ExecutionResult): Promise<void>;
  getResult(runId: string, actionRef: string): Promise<ExecutionResult | undefined>;
  /**
   * Find an existing run for a given workflow + trigger event id, if any. Used
   * to make ingestion idempotent so a redelivered event (e.g. a duplicate
   * webhook) does not run the same workflow twice.
   */
  findRunByEvent(workflowId: string, eventId: string): Promise<RunRecord | undefined>;
}

/** Append-only sink for audit records. Emitted at every pipeline boundary. */
export interface AuditSink {
  append(record: AuditRecord): Promise<void>;
  /** Query recorded audit entries, optionally scoped to a run. */
  query(filter?: { runId?: string }): Promise<AuditRecord[]>;
}

/**
 * Persists approvals and their decisions for Draft actions. Surfacing approvals
 * to a human and collecting their decision is the outer OS layer's concern;
 * this port only stores and retrieves the records.
 */
export interface ApprovalGateway {
  create(approval: Approval): Promise<void>;
  get(approvalId: string): Promise<Approval | undefined>;
  list(filter?: { status?: ApprovalStatus }): Promise<Approval[]>;
  /** Replace an approval record (e.g. after a decision). */
  save(approval: Approval): Promise<void>;
}

/** Supplies connector credentials. Connectors are stateless; secrets live here. */
export interface SecretProvider {
  get(key: string): string | undefined;
  require(key: string): string;
}

/**
 * A verified, authenticated actor.
 *
 * This is the identity the audit trail already *records* (`decidedBy`, actor
 * refs) but that nothing in the open core has ever *verified*. A `Principal` is
 * the output of an {@link IdentityProvider} — it must only be constructed by a
 * provider that has actually authenticated the caller. Treating a `Principal`
 * built directly from unverified request input as trusted would defeat the whole
 * point of the seam; on a trusted path, obtain it from `authenticate`, never
 * from raw user-supplied JSON.
 *
 * `roles` is opaque to the core — the runtime never interprets it. Only an
 * {@link Authorizer} gives roles meaning. Identity/authorization is orthogonal
 * to autonomy: a `Principal` answers *who* is acting, while an `AutonomyLevel`
 * governs *how far* an action may go. The two never substitute for each other.
 */
export interface Principal {
  /** Stable subject id (e.g. an OIDC `sub`). */
  readonly id: string;
  /** Organisation/tenant scope, when the deployment is multi-tenant. */
  readonly tenantId?: string;
  /** Opaque role labels; interpreted only by an {@link Authorizer}. */
  readonly roles: readonly string[];
  /** How this principal was authenticated: `"local"`, `"oidc"`, `"saml"`, … */
  readonly source: string;
  /** Human-friendly label for display/audit; never used for authorization. */
  readonly displayName?: string;
}

/**
 * Turns a request-scoped credential into a verified {@link Principal}, or
 * `undefined` when the credential is absent/invalid. The credential is `unknown`
 * because its shape is the adapter's concern (a bearer token, an assertion, a
 * session cookie); the core only consumes the resulting `Principal`.
 *
 * Adapters (commercial SSO: OIDC/SAML) implement this; the open default is
 * {@link localIdentity}. Returning `undefined` — not throwing — is how an
 * adapter signals "not authenticated", so callers fail closed by treating the
 * absence of a principal as unauthorized.
 */
export interface IdentityProvider {
  authenticate(credential: unknown): Promise<Principal | undefined>;
}

/** The single-user principal returned by {@link localIdentity}. */
export const LOCAL_PRINCIPAL: Principal = Object.freeze({
  id: "local",
  roles: Object.freeze(["owner"]) as readonly string[],
  source: "local",
  displayName: "Local user"
});

/**
 * Open default identity: the local single user. It authenticates every call to
 * the same {@link LOCAL_PRINCIPAL}, which is exactly today's behaviour — a
 * self-hoster is the sole owner of their box. It is a real, usable provider, not
 * a stub: pair it with {@link allowAll} and the runtime behaves precisely as it
 * did before identity existed. Substitute an SSO adapter to make identity real
 * across an organisation.
 */
export const localIdentity: IdentityProvider = {
  authenticate: (_credential: unknown): Promise<Principal | undefined> => Promise.resolve(LOCAL_PRINCIPAL)
};

/**
 * Authorizes *who may do what* — orthogonal to the autonomy model, which governs
 * *how far* an action may go. Actors are recorded throughout the runtime today
 * but never authorized; this port is the missing decision point.
 *
 * `action` is a stable verb string (e.g. `"approval.decide"`, and later
 * `"policy.change"` / `"evidence.read"`); `resource` optionally names the thing
 * acted upon. `can` may answer synchronously or asynchronously (a remote policy
 * check). It returns a boolean *decision*, never throws for a plain deny —
 * callers turn `false` into a fail-closed refusal at the boundary.
 */
export interface Authorizer {
  can(
    principal: Principal,
    action: string,
    resource?: { readonly type: string; readonly id: string }
  ): boolean | Promise<boolean>;
}

/**
 * Open default authorization: allow everything. This preserves today's
 * behaviour exactly — the runtime has always recorded actors without gating
 * them — so wiring the {@link Authorizer} decision point in with `allowAll` is a
 * true no-op. A commercial RBAC adapter replaces it to make roles binding.
 */
export const allowAll: Authorizer = {
  can: (): boolean => true
};

/**
 * A set of state changes to persist together. Used at points where more than one
 * piece of durable state must move as a unit — chiefly resolving an approval,
 * which flips the approval's status, records the execution result, and appends
 * the decision's audit records.
 */
export interface StateChange {
  /** Upsert this approval (e.g. its status after a decision). */
  approval?: Approval;
  /** Upsert this action result into its run. */
  result?: ExecutionResult;
  /** Append these audit records. */
  audit?: AuditRecord[];
}

/**
 * Optional backend capability: commit a {@link StateChange} atomically — all
 * parts land, or none do. A backend that can provide real transactions (e.g.
 * SQLite) implements this so the engine's multi-write state transitions are
 * crash-consistent. When absent, the engine falls back to applying each write in
 * turn through the individual ports (correct, but not crash-atomic).
 *
 * The transaction covers *durable state only* — never a connector's external
 * effect, which cannot be rolled back. The engine performs the effect first,
 * then commits the record of what happened as one unit.
 */
export interface Transactor {
  commit(change: StateChange): Promise<void>;
}

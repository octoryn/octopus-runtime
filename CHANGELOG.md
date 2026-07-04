**English** | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.7.0] — 2026-07-04

### Added
- **Identity & authorization ports — the open seams for org identity (SSO/RBAC).**
  The runtime has always *recorded* who acted (`decidedBy`, actor refs) but never
  *verified* or *authorized* them. Two additive ports close that gap, so an outer
  operating system (the commercial edition) can adapt SSO/RBAC without forking the
  core:
  - **`Principal`** — a verified actor `{ id, tenantId?, roles, source, displayName? }`.
    `roles` is opaque to the core; only an `Authorizer` interprets it.
  - **`IdentityProvider { authenticate(credential): Promise<Principal | undefined> }`**
    with a real default **`localIdentity`** that yields the single-user
    **`LOCAL_PRINCIPAL`** (`source: "local"`) — today's behaviour, unchanged.
  - **`Authorizer { can(principal, action, resource?): boolean | Promise<boolean> }`**
    with a default **`allowAll`** that permits everything — a true no-op.
  - The `Authorizer` is wired as an **opt-in** decision point on the one path
    where *who may act* matters today: resolving an approval (action
    `"approval.decide"`). Pass an `authorizer` on `RuntimeOptions`/`EngineDeps`
    and a decision must carry a verified `Principal` and be permitted, or it
    fails closed with the new **`AuthorizationError`** before any effect or
    record. Pass none (the default) and behaviour is byte-identical to before.
  - Authorization is **orthogonal to autonomy**: it gates *who* acts, never *how
    far* an action goes. Autonomy routing is untouched.
  - **Verified attribution.** When a decision carries a `principal`, that
    principal's `id` — the identity actually authenticated and authorized — is
    what the approval record and the `approval.decided` audit entry attribute the
    decision to, not the caller's unverified free-text `decidedBy`. So an actor
    cannot record a decision under an identity they were not authenticated as.
    With no principal (the default), `decidedBy` is the attribution exactly as
    before.
- **Note (out of scope):** OIDC/SAML SSO and RBAC are commercial *adapters* of
  these ports, not part of the open core. A later follow-up will add an optional
  `Authorizer` to observe's `ReadApi` for evidence-read gating.

### Changed
- Strictly additive. All 101 pre-existing tests pass unchanged; `Principal`,
  `AutonomyLevel`, and every frozen record/wire contract are untouched.

## [0.6.0] — 2026-07-03

### Added
- **`decisionEvidence` — attest *why* the agent was (or wasn't) allowed to act.**
  Turns a routing decision (the `GovernedResult` from `governTool`) into a
  tamper-evident, verifiable [`octopus-evidence`](https://github.com/octoryn/octopus-evidence)
  `Evidence`: `kind = governed-decision:<route>`, subject = the tool, content =
  `{ route, effectiveAutonomy, executed, requestedAutonomy?, ceiling?, reason?,
  preview? }`, provenance = `{ source: "octopus-runtime", method: "autonomy-gate" }`.
  Anyone can recompute the hash to confirm the decision was not altered after the
  fact — the EU AI Act Art. 12 "automatic logging of decisions" story in code.
  Injectable clock (deterministic; no module-scope `Date.now()`) and an optional
  `integritySecret` for a keyed HMAC. A pure mapping: no routing behavior,
  autonomy semantics, or `governTool` result shape changed.

### Changed
- Now depends on the first-party `octopus-evidence@^0.2.0` — its **only** runtime
  dependency (still zero third-party deps).

### Fixed
- **`decisionEvidence` never throws on a non-JSON `preview`.** A caller `render`
  can return anything; a preview holding a non-finite number (e.g. a ratio over
  zero), an `undefined` optional field, a `bigint`, or a cycle used to crash the
  logging call with an uncaught `TypeError` — losing the whole audit record. The
  preview is now coerced to a canonical JSON value (non-finite → `null`, `bigint`
  → string, `undefined`/functions dropped, cycles broken) so the record always
  survives. Found by adversarial review; regression-tested.

## [0.5.0] — 2026-07-03

### Added
- **`governTool` — govern a tool you already have.** Wrap any async tool
  function (a LangChain tool's `func`, a CrewAI/agent tool, a plain
  `(input) => output`) so its side effect passes through the autonomy gate
  without rewriting the agent. The wrapped function is invoked only on the
  `autonomous` route or an approved `draft`; at observe/shadow/denied/un-approved
  draft it is never called. Routing is delegated to the runtime's real `routeFor`
  gate, so `min(requested, ceiling)` and "approval downgrades autonomous to draft"
  hold exactly as in the engine. New exports `governTool`, `GovernToolOptions`,
  `GovernedResult`; runnable `examples/govern-tool.ts`.

## [0.4.0] — 2026-07-03

### Changed
- **License changed from AGPL-3.0-or-later to Apache-2.0.** Runtime is meant to
  be depended on directly as a governed-execution library; a permissive license
  removes the adoption barrier AGPL imposes on downstream (including commercial
  and closed-source) users. The `LICENSE` file, `package.json`, README badges,
  and prose are all updated to Apache-2.0.

## [0.3.2] — 2026-07-02

### Fixed
- The README "License" section still said `MIT` while the `LICENSE` file,
  `package.json`, and badge are AGPL-3.0-or-later. Corrected to
  AGPL-3.0-or-later (EN + zh-CN) so the license is consistent everywhere.

## [0.3.1] — 2026-07-02

### Added
- Tag-driven release workflow (`.github/workflows/release.yml`): pushing a `v*`
  tag publishes to npm with provenance (supply-chain attestation).

### Changed
- Contact addresses moved to the `octopusos.ai` domain (`security@octopusos.ai`,
  `conduct@octopusos.ai`); package author set to `Ran Tao <ran@octopusos.ai>`.

## [0.3.0] — 2026-07-02

### Added
- **Transactional unit of work.** New optional `Transactor` port + `StateChange`
  type. Resolving an approval now commits its status, the execution result, and
  the decision's audit records as one atomic unit. `SqliteTransactor` provides a
  real transaction; without a transactor the writes apply sequentially.
- **HTTP connector** (`octopus-runtime/connectors/http`) — a real,
  zero-dependency connector on the platform `fetch`, attaching an
  `Idempotency-Key` on mutating requests and failing closed on non-2xx.
- `schema.record` for validating objects with arbitrary string keys.
- Release engineering: AGPL-3.0-or-later `LICENSE`, GitHub Actions CI,
  ESLint + Prettier, `.editorconfig`/`.nvmrc`, bilingual docs, and community
  health files (`CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`).

### Changed
- The external effect now runs *before and outside* the approval transaction;
  the approval flips to `approved` only when the record commits, so a crash
  mid-effect leaves the approval re-resolvable (deduped by its idempotency key).
- Package renamed to `octopus-runtime` and licensed **AGPL-3.0-or-later**,
  aligning with the Octoryn open-source house style. Minimum Node is now 22.

## [0.2.0] — 2026-07-02

### Added
- **Transactional SQLite backend** (`createSqliteBackend`). A run and its
  `(workflow, event)` dedup key are the same row under a `UNIQUE` constraint,
  committed atomically — closing the file store's two-write crash window.
  `better-sqlite3` is an optional peer dependency, isolated to the
  `/adapters/sqlite` entry point.

### Fixed
- Durable stores serialize with a non-throwing `safeJsonStringify`, so a
  JSON-hostile value (e.g. `BigInt`) in execute output can no longer throw in
  `saveRun` and orphan an already-fired effect.
- `resolveApproval` persists the result outside the execute try/catch, so a
  store error cannot mislabel a succeeded effect as `failed`.

## [0.1.0] — 2026-07-02

### Added
- **Durable file backend** (`createFileBackend`) for runs, audit, and approvals.
- **Idempotent ingestion**: a redelivered event returns the original run;
  concurrent duplicates coalesce onto one in-flight run.
- Connector `idempotencyKey` derived from `(workflow, event, action)` — stable
  across redelivery and restart.
- **Approval TTL** (`approvalTtlMs`, `sweepExpiredApprovals`) and **connector
  timeouts** (`connectorTimeoutMs`), both fail-closed.

## [0.0.1] — 2026-07-02

### Added
- Initial governed execution runtime: triggers → conditions → policies → action
  plan → autonomy gate (Observe/Shadow/Draft/Autonomous) → approval gate →
  connector render/execute → result → audit.
- Structural safety (execute unreachable above its governed level), monotonic
  policy engine, fail-closed error handling, pluggable ports with in-memory
  defaults, example email connector, read APIs, CLI.

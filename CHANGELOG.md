**English** | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

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

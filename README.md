**English** | [简体中文](README.zh-CN.md)

# Octopus Runtime

[![CI](https://github.com/octoryn/octopus-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/octoryn/octopus-runtime/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/octoryn/octopus-runtime?sort=semver)](https://github.com/octoryn/octopus-runtime/releases/latest)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](.nvmrc)

**A standalone, governed execution runtime.** It answers one question:

> How can work safely move from observation to action?

Workflow Runtime carries an event from trigger to result across autonomy,
policy, approval, connector, execution, and audit boundaries. Its only job is
**governed execution**. It has no memory, no dashboards, no planning AI, and no
compile-time dependency on any surrounding system. Think Unix: one
responsibility, done extremely well.

```
Trigger → Conditions → Policies → Action Plan → Autonomy Gate
       → Approval Gate → Connector Render/Execute → Result → Audit Record
```

## The one idea: autonomy levels

Every action carries an **autonomy level** that governs how far it may travel
toward an outward effect:

| Level | What happens | `render` | `execute` |
|---|---|---|---|
| **Observe** | Watch only; record that nothing was done | ✗ | ✗ |
| **Shadow** | Render a faithful prediction of the effect | ✓ | ✗ |
| **Draft** | Prepare the effect and hold it as an approval | ✓ | only after approval |
| **Autonomous** | Execute now, subject to policy | ✓ | ✓ |

The runtime's central safety property is **structural**, not conventional: a
connector's side-effectful `execute` is unreachable except on the Autonomous
path or after a Draft approval — and the effective autonomy is always
`min(requested, every applicable policy)`. Adding a policy can only ever make
the system safer.

## Install

```bash
npm install octopus-runtime
```

Requires Node ≥ 22. The core has **zero runtime dependencies**.

## Quickstart

```ts
import {
  createRuntime,
  defineWorkflow,
  matchSource,
  AutonomyLevel,
} from "octopus-runtime";
import { createEmailConnector, inMemoryTransport } from "octopus-runtime/connectors/email";

const { transport, outbox } = inMemoryTransport();

const runtime = createRuntime({
  connectors: [createEmailConnector(transport)],
  workflows: [
    defineWorkflow<{ email: string }>({
      id: "welcome",
      match: matchSource("signup"),
      conditions: [{ id: "has-email", test: ({ event }) => event.payload.email.includes("@") }],
      plan: ({ event }) => [
        {
          ref: "send-welcome",
          connectorId: "email",
          actionType: "email.send",
          requestedAutonomy: AutonomyLevel.Draft, // prepare, don't send yet
          input: { to: [event.payload.email], subject: "Welcome!", body: "Thanks for joining." },
        },
      ],
    }),
  ],
});

const [run] = await runtime.dispatch({
  id: "evt-1",
  source: "signup",
  occurredAt: new Date().toISOString(),
  payload: { email: "ada@example.com" },
});

// The Draft action rendered an email and created an approval — but sent nothing.
const [pending] = await runtime.read.listPendingApprovals();
await runtime.resolveApproval(pending.id, { approved: true, decidedBy: "ops@example.com" });
// Now, and only now, the email is delivered.
```

Run the bundled example and CLI:

```bash
npm run example
npx octopus-runtime demo autonomous   # or: observe | shadow | draft
```

## Writing a connector

A connector is stateless and isolated. Each action splits into a **pure
`render`** and a **side-effectful `execute`** — and that split *is* the autonomy
mechanism. You write both once; the runtime decides which runs.

```ts
import { defineConnector, defineAction, schema as s } from "octopus-runtime";

export const slack = defineConnector({
  id: "slack",
  version: "1.0.0",
  actions: [
    defineAction({
      type: "slack.postMessage",
      input: s.object({ channel: s.string(), text: s.string() }),
      // PURE — runs in Shadow and Draft. No side effects.
      render: (input) => ({
        preview: `Post to ${input.channel}: ${input.text}`,
        payload: input,
      }),
      // SIDE-EFFECTFUL — runs only on the Autonomous path or after approval.
      execute: async (rendered, ctx) => {
        const token = ctx.secrets.require("SLACK_TOKEN");
        const res = await postToSlack(token, rendered.payload);
        return { output: res, effectRefs: [{ kind: "slack.message", id: res.ts }] };
      },
    }),
  ],
});
```

Input is validated against the schema before `render` is ever called. Any object
satisfying the `Schema<T>` interface works — including a Zod schema — so you are
not tied to the built-in validator.

Two connectors ship in the box: an in-memory `email` (for examples/tests) and a
real, zero-dependency **`http`** connector on the platform `fetch` —
`octopus-runtime/connectors/http`. The HTTP connector attaches an
`Idempotency-Key` derived from the runtime's stable idempotency key on mutating
requests, and fails closed on non-2xx responses.

## Governing with policies

Policies decide how far an action goes. They are **monotonic**: a policy may only
lower autonomy, force approval, add constraints, or deny — never raise autonomy.

```ts
const policies = [
  // Cap a whole class of actions at Draft until you trust them.
  { id: "email-needs-review", evaluate: ({ action }) =>
      action.connectorId === "email" ? { cap: AutonomyLevel.Draft } : {} },
  // Deny outright outside business hours.
  { id: "business-hours", evaluate: ({ clock }) =>
      isBusinessHours(clock.now()) ? {} : { deny: "outside business hours" } },
];
```

## Ports and local-first design

The core depends only on interfaces (**ports**), each with a zero-config
in-memory adapter, so the runtime runs on a laptop with nothing installed:

| Port | Default adapter |
|---|---|
| `Store` | `MemoryStore` · durable `FileStore` · transactional `SqliteStore` |
| `AuditSink` | `MemoryAuditSink` · `FileAuditSink` · `SqliteAuditSink` |
| `ApprovalGateway` | `MemoryApprovalGateway` · `FileApprovalGateway` · `SqliteApprovalGateway` |
| `Transactor` (optional) | — (SQLite provides `SqliteTransactor`) |
| `Clock` | `SystemClock` (`ManualClock` for tests) |
| `SecretProvider` | `StaticSecretProvider` / `EnvSecretProvider` |

An outer operating system substitutes durable or networked adapters — including
ones that bridge to memory, awareness, or signal systems — **without touching
the core**. Dependency arrows always point inward.

## Durability, idempotency, and time limits

For work that must survive real process restarts, duplicate deliveries, approval
delays, and slow connectors, swap in the durable file backend and set two
options — no code changes to workflows or connectors:

```ts
import { createRuntime, createFileBackend } from "octopus-runtime";

const runtime = createRuntime({
  ...createFileBackend("./data"),   // durable Store + AuditSink + ApprovalGateway
  connectors,
  workflows,
  connectorTimeoutMs: 30_000,       // a slow render/execute fails closed
  approvalTtlMs: 24 * 60 * 60_000,  // a pending draft expires after 24h
});
```

Two durable backends ship in the box:

- **`createFileBackend(dir)`** — zero-dependency JSON on disk. Great for local
  and single-process use.
- **`createSqliteBackend(path)`** — transactional SQLite, the production choice.
  A run and its dedup key are the *same row* under a `UNIQUE(workflow, event)`
  constraint, committed atomically — so there is **no two-write crash window**: a
  redelivered event cannot re-run after a crash, and at most one run *row* can
  exist per event, even across processes (effect-level exactly-once still relies
  on the connector idempotency key). Requires the optional peer dependency
  `better-sqlite3` (`npm i better-sqlite3`); import it from
  `octopus-runtime/adapters/sqlite`. The core never loads it.

  ```ts
  import { createSqliteBackend } from "octopus-runtime/adapters/sqlite";
  const backend = createSqliteBackend("./runtime.db");
  const runtime = createRuntime({ ...backend, connectors, workflows });
  ```

### Atomic state transitions (unit of work)

Resolving an approval moves three pieces of durable state at once: the approval's
status, the execution result, and the decision's audit records. With a
`Transactor` (SQLite provides one; spread `...backend` supplies it), those commit
in **one transaction** — a crash can't leave an approval marked `approved` with
no recorded result. The external effect runs *first, outside* the transaction
(it can't be rolled back); the approval flips to `approved` only when the record
of what happened commits, so a crash mid-effect leaves it re-resolvable and the
effect is deduped by its idempotency key. Without a transactor the same writes
apply sequentially — correct, but not crash-atomic.

What both durable backends give you:

- **Survives restart.** Runs, the audit trail, and pending approvals are durable.
  A Draft created before a restart is still resolvable after it.
- **Idempotent ingestion.** A redelivered event (same `id`, same workflow) —
  e.g. a duplicate webhook — returns the original run instead of executing
  again, and the event is audited as `trigger.deduplicated`.
- **Effect-level idempotency.** The `idempotencyKey` handed to connectors is
  derived from `(workflow, event, action)`, so even if ingestion dedup is
  bypassed (two workers, a lost pointer), a connector that dedupes on it fires
  the effect at most once.
- **Approval TTL.** A pending draft past `approvalTtlMs` expires fail-closed —
  it never executes. Call `runtime.sweepExpiredApprovals()` from a scheduler, or
  it is enforced lazily when someone tries to resolve an overdue approval.
- **Connector timeout.** A `render`/`execute` exceeding `connectorTimeoutMs`
  fails closed (`render_timeout` / `execute_timeout`). The timeout bounds how
  long the runtime *waits*; because the underlying call is not cancelled, effects
  must be idempotent — which the stable key above ensures.

## Reading what happened

```ts
await runtime.read.getRun(runId);
await runtime.read.getRunResults(runId);
await runtime.read.getAuditTrail(runId);    // an entry at every boundary crossed
await runtime.read.listPendingApprovals();
```

## Boundary — what this is not

Workflow Runtime is **not** a memory system, an awareness layer, a signal
processor, an experience layer, an observability platform, or a broad agent
orchestrator. It governs outward effects. Everything else belongs to the
operating system that may combine this runtime with those systems — and this
repository never assumes they exist.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test (83 tests)
npm run build       # emit dist/
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## License

MIT

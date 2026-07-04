**English** | [简体中文](README.zh-CN.md)

# Octopus Runtime

[![CI](https://github.com/octoryn/octopus-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/octoryn/octopus-runtime/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/octoryn/octopus-runtime?sort=semver)](https://github.com/octoryn/octopus-runtime/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](.nvmrc)
[![Built on octopus-evidence](https://img.shields.io/badge/built%20on-octopus--evidence-7c9cff.svg)](https://github.com/octoryn/octopus-evidence)

> **Part of [Octopus Core](https://github.com/octoryn) — the open infrastructure stack for governed AI.** One job per repo, along the agent lifecycle: [Scout](https://github.com/octoryn/octopus-scout) · [Observe](https://github.com/octoryn/octopus-observe) · [Experience](https://github.com/octoryn/octopus-experience) · [Blackboard](https://github.com/octoryn/octopus-blackboard) · [Runtime](https://github.com/octoryn/octopus-runtime) · [Replay](https://github.com/octoryn/octopus-replay) — with [Inspect](https://github.com/octoryn/octopus-inspect) governing every stage. The whole stack rides one root primitive, [Evidence](https://github.com/octoryn/octopus-evidence) — the canonical, tamper-evident atom and the root category every stage speaks in.
>
> **This repo — Runtime · Act:** Make unsafe actions structurally impossible.

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

Requires Node ≥ 22. The core has **zero third-party dependencies**: its only
runtime dependency is the first-party
[`octopus-evidence`](https://github.com/octoryn/octopus-evidence) primitive
(itself zero-dependency), which provides the canonical hashing and tamper-evident
Evidence the whole stack shares — the same primitive that turns a routing
decision into a verifiable audit trail (see
[`decisionEvidence`](#decision-evidence)). The runtime is otherwise fully usable
on its own.

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

## Govern a tool you already have

You don't have to rewrite your agent to govern it. `governTool` wraps any async
tool function — a LangChain tool's `func`, a CrewAI/agent tool, a plain
`(input) => output` — so its side effect passes through the same autonomy gate,
enforced by the runtime's real routing (not a copy):

```ts
import { governTool, AutonomyLevel } from "octopus-runtime";

// Your existing tool (e.g. a LangChain DynamicStructuredTool's func).
const sendEmail = async (input: { to: string; subject: string }) => post("/email", input);

const governed = governTool(sendEmail, {
  autonomy: AutonomyLevel.Draft,          // hold effects for approval
  ceiling: AutonomyLevel.Autonomous,      // an env/policy cap: effective = min(requested, ceiling)
  render: (i) => `would send "${i.subject}" to ${i.to}`,   // shown at shadow/draft, no effect
  approve: async ({ preview }) => askHuman(preview),        // called only on the draft route
});

const r = await governed({ to: "a@b.com", subject: "Hi" });
// r.executed is true ONLY on the `autonomous` route or an approved `draft`;
// at observe/shadow/denied/un-approved-draft the real tool is never called.
```

The wrapped function is invoked **only** on the `autonomous` route or a `draft`
after `approve` returns true — the structural guarantee, applied to a tool you
already run. This addresses OWASP Agentic **ASI02** (tool misuse) and **ASI09**
(human-agent trust) by construction. For full policy evaluation, connectors, and
an audit trail, define the effect as a connector and run it through the `Engine`
(below). Runnable: [`examples/govern-tool.ts`](examples/govern-tool.ts).

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

## Identity & authorization (open seams for SSO/RBAC)

The runtime has always *recorded* who acted, but never *verified* or *authorized*
them. Two additive ports — with honest, usable defaults — are the open extension
points an organisation-scale layer (the commercial edition) adapts for SSO and
RBAC, **without forking the core**:

| Port | What it answers | Open default |
|---|---|---|
| `IdentityProvider` → `Principal` | *Who* is acting (verified) | `localIdentity` → the single-user `LOCAL_PRINCIPAL` |
| `Authorizer` | *May* this actor do this? | `allowAll` (permits everything) |

Authorization is **orthogonal to autonomy**: the `Authorizer` gates *who* may
act, while an `AutonomyLevel` governs *how far* an action may go. The defaults
reproduce today's single-user behaviour exactly — wiring them in changes nothing.

The `Authorizer` is an **opt-in** decision point on the one path where "who may
act" matters today: resolving an approval (`"approval.decide"`). Provide one and
a decision must carry a verified `Principal` and be permitted, or it fails closed
before any effect:

```ts
import { createRuntime, type Authorizer } from "octopus-runtime";

// A commercial RBAC adapter shape — the open core only defines the port.
const rbac: Authorizer = {
  can: (principal, action) =>
    action === "approval.decide" && principal.roles.includes("approver"),
};

const runtime = createRuntime({ connectors, workflows, authorizer: rbac });

// Obtain the principal from an IdentityProvider (an OIDC/SAML adapter in the
// commercial edition) — never from raw request input on a trusted path.
await runtime.resolveApproval(approvalId, {
  approved: true,
  decidedBy: "alice",
  principal: { id: "alice", roles: ["approver"], source: "oidc" },
});
```

Omit `authorizer` and behaviour is byte-identical to before the seam existed.
OIDC/SAML SSO and role mapping are commercial **adapters** of these ports, not
part of the open core.

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

[Apache-2.0](LICENSE)

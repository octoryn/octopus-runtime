# Workflow Runtime

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
npm install @octopus/workflow-runtime
```

Requires Node ≥ 20. The core has **zero runtime dependencies**.

## Quickstart

```ts
import {
  createRuntime,
  defineWorkflow,
  matchSource,
  AutonomyLevel,
} from "@octopus/workflow-runtime";
import { createEmailConnector, inMemoryTransport } from "@octopus/workflow-runtime/connectors/email";

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
npx workflow-runtime demo autonomous   # or: observe | shadow | draft
```

## Writing a connector

A connector is stateless and isolated. Each action splits into a **pure
`render`** and a **side-effectful `execute`** — and that split *is* the autonomy
mechanism. You write both once; the runtime decides which runs.

```ts
import { defineConnector, defineAction, schema as s } from "@octopus/workflow-runtime";

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
| `Store` | `MemoryStore` |
| `AuditSink` | `MemoryAuditSink` |
| `ApprovalGateway` | `MemoryApprovalGateway` |
| `Clock` | `SystemClock` (`ManualClock` for tests) |
| `SecretProvider` | `StaticSecretProvider` / `EnvSecretProvider` |

An outer operating system substitutes durable or networked adapters — including
ones that bridge to memory, awareness, or signal systems — **without touching
the core**. Dependency arrows always point inward.

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
npm test            # node --test (39 tests)
npm run build       # emit dist/
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## License

MIT

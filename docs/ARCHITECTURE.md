# Workflow Runtime — Architecture

> **Mission.** How can work safely move from observation to action?
>
> This repository is the *execution runtime* for AI-native organizations. It owns
> execution and nothing else. It has no knowledge of, and no dependency on,
> octopus-blackboard, octopus-experience, or SignalsOS. Integration between
> systems is the operating system's job, not this repo's.
>
> Think Unix. One responsibility. Do it extremely well.

---

## 1. The one idea

Every effect on the outside world passes through a single gate whose position is
governed by an **autonomy level**:

```
Observe  →  Shadow  →  Draft  →  Autonomous
 watch      predict    prepare    execute
```

The runtime's job is to make that gate **structurally safe**: it must be
*impossible* for an action to reach the outside world at a higher autonomy level
than its governing policy permits. Safety is not a convention enforced by
discipline — it is a property enforced by the type system and the engine.

Everything else in this document exists to serve that property.

---

## 2. What the runtime is (and is not)

| In scope | Out of scope (belongs to the OS layer) |
|---|---|
| Triggers, conditions, policies, actions, connectors, results | Organizational memory / Blackboard |
| The autonomy gate (Observe/Shadow/Draft/Autonomous) | Shared awareness across workflows |
| Approvals as artifacts + a port to surface them | Approval **UI** / notification delivery |
| Recording shadow predictions with correlation keys | Diffing predictions against human reality |
| Append-only audit of every decision and effect | Observability platform / dashboards |
| A stateless connector authoring model | Connector credential *storage* (only a port) |
| Local-first, in-memory-by-default execution | Planning AI / cross-repo orchestration |

The runtime never assumes the surrounding systems exist. Where it needs something
from the outside (persistence, secrets, a place to send approvals, a source of
events), it declares a **port** and ships a trivial local adapter. The OS layer
substitutes real adapters.

---

## 3. Domain model

Six nouns, in pipeline order. Each is a plain, serializable value or a small
interface — no framework, no inheritance hierarchies.

```
Trigger → Condition → Policy → Action → Connector → Execution Result
```

### 3.1 Trigger

A source of events. The runtime does not care *how* an event arrives — webhook,
cron, queue, manual invocation, or a poll — only that it produces a normalized
`TriggerEvent`.

```ts
interface TriggerEvent {
  id: string;               // stable, unique — used for idempotency
  source: string;           // "github.pull_request", "cron.daily", "manual"
  occurredAt: string;       // ISO-8601, from the Clock port
  payload: unknown;         // opaque to the core; typed by the workflow
  correlation?: Correlation; // optional keys linking to external entities
}
```

Triggers are the only inbound edge and enter through the **EventSource port**
(§6). The core ships an in-memory event bus; hosts can bridge webhooks/cron.

### 3.2 Condition

A **pure predicate** over `(event, context)`. No side effects, no I/O,
deterministic. Conditions decide whether the workflow proceeds; they never
decide *how far* an action goes — that is autonomy's job, and it is deliberately
kept separate.

```ts
type Condition = (event: TriggerEvent, ctx: ExecutionContext) => boolean;
```

Purity is a hard rule: it makes runs reproducible and makes Shadow meaningful.
A condition that reaches out to a network is a design error.

### 3.3 Policy

Policies **govern autonomy and constrain execution**. Evaluated against
`(event, ctx, intent)`, a policy returns a decision. The critical invariant:

> **Monotonicity of safety.** A policy may only *lower* the effective autonomy
> level or add constraints. It can never raise autonomy above what the action
> requested. When multiple policies apply, the **most restrictive** wins.

```ts
interface PolicyDecision {
  effectiveAutonomy: AutonomyLevel;   // min(requested, every policy's cap)
  requiresApproval: boolean;          // can force Draft even if Autonomous
  denied?: { reason: string };        // hard stop
  constraints: AppliedConstraint[];   // rate limit, time window, allowlist, budget
}
```

This is the single most important safety surface. Because the effective level is
a *minimum* over all policies and can never exceed the request, adding a policy
can only ever make the system safer — never less safe. New policies are always
safe to deploy.

### 3.4 Action

An **action is declarative**: it describes an intended effect, not its
execution. It names an action `type`, carries typed input, and targets a
connector. Producing an action is free of side effects — it yields an
`ActionIntent`.

```ts
interface ActionIntent<Input = unknown> {
  type: string;             // "email.send", "calendar.createEvent"
  connectorId: string;      // which connector performs it
  input: Input;             // validated against the action's schema
  requestedAutonomy: AutonomyLevel;
  idempotencyKey: string;   // derived from (runId, actionId); dedupes retries
}
```

### 3.5 Connector

The adapter that actually touches an external system. **Isolated and stateless
whenever possible.** A connector declares its actions; each action splits cleanly
into two functions — and this split *is* the autonomy mechanism:

```ts
interface ActionDefinition<Input, Output> {
  type: string;
  input: Schema<Input>;   // any validator satisfying `{ parse(v): T }` — built-in or Zod

  /** PURE. Produce the concrete payload/preview. No side effects, ever.
   *  Used by Shadow (prediction) and Draft (what awaits approval). */
  render(input: Input, ctx: ConnectorContext): Promise<RenderedAction>;

  /** SIDE-EFFECTFUL. Perform the effect against the external system.
   *  Called ONLY when the autonomy gate + policy permit execution. */
  execute(rendered: RenderedAction, ctx: ConnectorContext): Promise<Output>;
}
```

Connector authors reason about two questions — *what would I do?* (`render`) and
*do it* (`execute`) — and get the entire Observe/Shadow/Draft/Autonomous
lifecycle for free. The runtime, not the connector, decides whether `execute`
is ever reached. See §8 for the authoring SDK.

### 3.6 Execution Result

The outcome record. Every run produces one per action, at every autonomy level
(even Observe, which records that nothing was done and why).

```ts
interface ExecutionResult {
  runId: string;
  actionId: string;
  autonomy: AutonomyLevel;      // the level it actually ran at
  outcome: "observed" | "predicted" | "drafted" | "executed"
         | "rejected" | "denied" | "failed";
  rendered?: RenderedAction;    // present from Shadow onward
  output?: unknown;             // present when executed
  effectRefs?: EffectRef[];     // external ids (message id, event id) for audit
  error?: ErrorInfo;
  timing: { startedAt: string; finishedAt: string };
}
```

---

## 4. The autonomy gate

Autonomy is a per-action property (defaulted at the workflow level, capped by
policy). The gate decides how far each `ActionIntent` travels down the pipe.

```mermaid
flowchart TD
  I[ActionIntent<br/>requestedAutonomy] --> P{Policy decision<br/>effectiveAutonomy = min(...)}
  P -->|denied| D[Result: denied]
  P -->|Observe| O[Record observation<br/>no render, no execute]
  P -->|Shadow| S[render → store prediction<br/>+ correlation keys]
  P -->|Draft| DR[render → create Approval<br/>hold]
  P -->|Autonomous| A[render → execute]
  DR -->|approved| A
  DR -->|rejected / expired| RJ[Result: rejected]
  A --> R[Result: executed<br/>effectRefs]
  O --> AU[(Audit sink)]
  S --> AU
  DR --> AU
  RJ --> AU
  R --> AU
```

Guarantees the engine enforces:

| Level | `render` called? | `execute` called? | Human in loop |
|---|---|---|---|
| **Observe** | No | No | — |
| **Shadow** | Yes | **No** | Human still acts; prediction recorded as evidence |
| **Draft** | Yes | Only after approval | Approval required before every effect |
| **Autonomous** | Yes | Yes (policy permitting) | Notified/auditable, not blocking |

Because `execute` is reachable *only* through the Autonomous branch (or an
approved Draft), and that branch is guarded by `min(requested, all policies)`,
there is no code path that executes an effect above its permitted level. This is
the structural safety property from §1.

**Shadow and the boundary.** Shadow records a faithful prediction plus
correlation keys and stops. Comparing the prediction against what a human
actually did ("differences become evidence") requires knowing the human's
action — which lives *outside* this repo. The runtime therefore emits the
prediction through the audit/evidence port with correlation metadata and makes
no attempt to observe reality itself. Diffing is an OS-layer concern. Keeping
this line clean is what preserves independence.

---

## 5. Execution pipeline

One run, end to end:

1. **Ingest** — `TriggerEvent` arrives via the EventSource port.
2. **Contextualize** — build an `ExecutionContext` from the event and workflow
   inputs. No external memory is consulted; the context is self-contained.
3. **Evaluate conditions** — pure predicates; halt if any gate fails.
4. **Plan actions** — produce `ActionIntent`s declaratively (no side effects).
5. **Govern** — evaluate policies per intent → `PolicyDecision`
   (`effectiveAutonomy`, approval, constraints, denials).
6. **Gate** — route each intent by effective autonomy (§4).
7. **Render / Execute** — call the connector's `render` and, if permitted,
   `execute`, honoring `idempotencyKey`.
8. **Record** — emit `ExecutionResult` + full decision trail to the audit sink.

The engine is a small deterministic reducer over these steps. Given the same
event, context, and clock, a run is reproducible up to `execute`'s external
effects — which is exactly what makes Shadow trustworthy and tests cheap.

**Idempotency & delivery.** `execute` is at-least-once; connectors use the
`idempotencyKey` to dedupe. Retries never re-render into a *different* payload
(render is pure), so a retry can only repeat the same intended effect.

---

## 6. Ports (hexagonal, local-first)

The core depends only on interfaces. Every port ships a zero-config local
adapter so the runtime runs on a laptop with nothing installed; the OS layer
swaps in real adapters without touching the core.

| Port | Purpose | Default adapter (v0) |
|---|---|---|
| `Clock` | Time (deterministic tests) | `SystemClock` / `ManualClock` |
| `Store` | Runs + results | `MemoryStore` |
| `AuditSink` | Append-only decision + effect log | `MemoryAuditSink` |
| `ApprovalGateway` | Persist Drafts + decisions | `MemoryApprovalGateway` |
| `SecretProvider` | Connector credentials | `StaticSecretProvider` / `EnvSecretProvider` |

Triggers enter by calling `runtime.dispatch(event)` (or `run(workflowId,
event)`) directly, so v0 has no `EventSource` port — a host bridges webhooks/cron
to those calls. `ConnectorRegistry` is a concrete class the runtime owns, not a
port (there is no reason to swap how a `connectorId` resolves to a connector).

No adapter in the core references Blackboard, Experience, or SignalsOS. Those
integrations are *adapters the OS provides*, and they depend on the runtime —
never the reverse. Dependency arrows point inward, always.

---

## 7. Module layout

v0 is a **single package with zero runtime dependencies**. Its modules are
drawn along the boundaries a future package split would follow, so the seams are
already in the right place.

```
src/
  index.ts          # public API barrel
  autonomy.ts       # AutonomyLevel + ordering + min (the safety algebra)
  types.ts          # domain types (TriggerEvent, PlannedAction, ExecutionResult, …)
  schema.ts         # zero-dependency Schema<T> + builders (Zod-compatible interface)
  ports.ts          # Clock / Store / AuditSink / ApprovalGateway / SecretProvider
  connector.ts      # Connector contract + defineConnector/defineAction + registry
  conditions.ts     # pure condition evaluator
  policy.ts         # monotonic policy engine (decide)
  gate.ts           # routeFor: PolicyDecision → GateRoute
  workflow.ts       # Workflow definition + plan validation
  engine.ts         # the pipeline + resolveApproval
  read.ts           # read-only query surface
  runtime.ts        # Runtime facade + createRuntime (wires defaults)
  adapters/         # in-memory / local adapters for every port
  connectors/email.ts   # example connector (in-memory transport)
  cli.ts            # inspection CLI
docs/ARCHITECTURE.md
```

Rules that keep the boundary honest (enforced by review; a future import-graph
CI check makes them mechanical):

- The core (`engine`, `policy`, `gate`, …) imports no connector and no adapter.
- A connector imports only the connector contract + schema.
- Nothing anywhere imports Blackboard / Experience / SignalsOS.

When these modules grow, they lift out into packages — `runtime-core`,
`connector-sdk`, `store-sqlite`, per-connector packages — without moving code
across the seams drawn here.

---

## 8. Connector authoring (the ergonomics bet)

The stated optimization is *connector authoring speed*. The SDK reduces a
connector to schemas plus two functions per action:

```ts
import { defineConnector, defineAction, schema as s } from "@octopus/workflow-runtime";

export const email = defineConnector({
  id: "email",
  version: "1.0.0",
  actions: [
    defineAction({
      type: "email.send",
      input: s.object({
        to: s.array(s.string()),
        subject: s.string(),
        body: s.string(),
      }),
      // PURE — safe to run in Shadow and Draft.
      render: (input) => ({
        preview: `To: ${input.to.join(", ")} — "${input.subject}"`,
        payload: input,
      }),
      // SIDE-EFFECTFUL — only reached when the gate permits.
      execute: async (rendered, ctx) => {
        const token = ctx.secrets.require("SMTP_TOKEN");
        const { messageId } = await deliver(token, rendered.payload);
        return { output: { messageId }, effectRefs: [{ kind: "email.message", id: messageId }] };
      },
    }),
  ],
});
```

What the author gets for free from the runtime:

- Input validation at the boundary (bad intents never reach `render`).
- The full autonomy lifecycle — the same connector works at all four levels
  with no branching in connector code.
- Idempotent execution via `idempotencyKey`.
- Audit of every render, approval, and effect.
- Testability: `render` is pure, so golden-file tests for Shadow are trivial.

Connectors stay stateless: any credential comes from the `SecretProvider` in
`ctx`, never from module state.

---

## 9. Cross-cutting invariants

1. **Independence.** Zero dependency on Blackboard / Experience / SignalsOS.
   Verified by a lint/CI check on the import graph.
2. **Safety monotonicity.** Effective autonomy = `min(requested, all policies)`.
   Adding a policy can only make the system safer.
3. **Render/execute separation.** `execute` is unreachable except through the
   Autonomous branch or an approved Draft. Enforced by the engine, not by
   author discipline.
4. **Everything is auditable.** Every run emits a complete decision trail to the
   `AuditSink`, at every autonomy level — including "observed / did nothing".
5. **Reproducibility.** Same event + context + clock ⇒ same run up to external
   effects. This is what makes Shadow honest and tests fast.
6. **Local-first.** Runs with no external services via default adapters.

---

## 10. Decisions resolved in v0

These were the open questions; v0 resolves them as follows.

1. **Autonomy granularity** — *per-action* is the primitive. Each
   `PlannedAction` carries its own `requestedAutonomy`; a workflow's effective
   autonomy is simply the most restrictive across its actions. No separate
   workflow-level level exists to drift out of sync.
2. **Multi-action runs** — *sequential only* in v0. Dependencies are declared
   via `dependsOn` referencing earlier `ref`s, and validated to be backward-only
   so parallel scheduling can be added later without changing the action shape.
   A dependency is *satisfied* unless it errored — `failed`, `denied`,
   `skipped`, and `rejected` are unsatisfying (dependents are `skipped`,
   fail-closed); `observed`, `predicted`, `drafted`, and `executed` all satisfy.
   Treating `drafted` as satisfying lets a whole Draft-mode workflow render every
   action for review at once. The known caveat: an Autonomous action that
   `dependsOn` a still-pending Draft will execute before that Draft is approved —
   an unusual mixed-level plan the author should avoid. It does not breach the
   core safety property: each action still executes only at its own governed
   level.
3. **Failure behavior** — *fail-closed*, uniformly across every boundary. A
   throwing render/execute yields `failed`; a throwing *policy* denies that
   action (`policy_evaluation_failed`) rather than aborting the run; a
   dependency that did not reach a satisfying outcome yields `skipped`; a
   throwing condition halts the run. Nothing fails open, and a run that fired any
   effect is always persisted with its results — an effect is never orphaned. To
   uphold that, connector `execute` output that is not structured-cloneable is
   replaced with a marker before it enters the run record, so persistence cannot
   throw after an effect has already occurred.
4. **Draft execution** — resolving an approval is a distinct, explicit call.
   Execution is structurally impossible before a recorded decision.
5. **Schema dependency** — the runtime depends on the `Schema<T>` *interface*,
   with a built-in zero-dependency implementation. Zod (or any `{ parse }`) drops
   in unchanged.

Still deferred (not needed for v0, no API impact when added later):

- **Parallel scheduling** across independent `dependsOn` branches.
- **Approval expiry / TTL** semantics (v0 approvals do not expire).
- **Compensation / rollback** for partial failures — likely an OS-layer saga
  concern rather than a connector responsibility.
- **Shadow correlation diffing** — the runtime emits predictions with
  correlation keys; comparing them against reality stays outside this repo.
- **Declarative (data-defined) policy format** — v0 policies are code.

---

## 11. What "done extremely well" looks like

- A new connector is a single file: schemas + `render` + `execute`.
- Flipping a workflow from Shadow to Draft to Autonomous is a policy change,
  never a code change.
- A reviewer can point at the code path and see that no effect can outrun its
  policy.
- The whole thing runs on a laptop with nothing installed, and the same code
  runs in the OS with real adapters bolted on.

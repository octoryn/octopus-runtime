[English](ARCHITECTURE.md) | **简体中文**

# Octopus Runtime — 架构

> **使命。** 工作如何才能安全地从观察走向行动？
>
> 本仓库是面向 AI 原生组织的*执行运行时*。它只负责执行，别无其他。它对
> octopus-blackboard、octopus-experience 或 SignalsOS 一无所知，也不依赖它们。
> 系统之间的集成是操作系统层的职责，而非本仓库的职责。
>
> 想想 Unix。单一职责，把它做到极致。

---

## 1. 唯一的核心理念

对外部世界的每一次作用都必须通过唯一的一道门，而这道门的位置由**自主级别**
（autonomy level）来治理：

```
Observe  →  Shadow  →  Draft  →  Autonomous
 watch      predict    prepare    execute
```

运行时的职责是让这道门具备**结构性安全**（structural safety）：动作*不可能*以高于
其治理策略所允许的自主级别抵达外部世界。安全不是靠纪律来遵守的约定，而是由类型
系统和引擎强制保证的属性。

本文档中的其余一切，都是为服务这一属性而存在。

---

## 2. 运行时是什么（以及不是什么）

| 范围之内 | 范围之外（归属于操作系统层） |
|---|---|
| 触发器、条件、策略、动作、连接器、结果 | 组织记忆 / Blackboard |
| 自主门（Observe/Shadow/Draft/Autonomous） | 跨工作流的共享感知 |
| 作为工件的审批 + 用于呈现它们的端口 | 审批 **UI** / 通知投递 |
| 记录带关联键的影子预测 | 将预测与人类现实进行对比 |
| 对每一次决策与作用的追加式审计 | 可观测性平台 / 仪表盘 |
| 无状态的连接器编写模型 | 连接器凭据的*存储*（仅提供一个端口） |
| 本地优先、默认内存的执行 | 规划 AI / 跨仓库编排 |

运行时从不假设周边系统的存在。当它需要来自外部的某种能力（持久化、密钥、发送审批
的去处、事件来源）时，它会声明一个**端口**，并附带一个极简的本地适配器。操作系统
层负责替换为真实的适配器。

---

## 3. 领域模型

按流水线顺序排列的六个名词。每一个都是普通的可序列化值或一个小接口——没有框架，
没有继承体系。

```
Trigger → Condition → Policy → Action → Connector → Execution Result
```

### 3.1 触发器（Trigger）

事件的来源。运行时并不关心事件*如何*抵达——webhook、cron、队列、手动调用或轮询
——只关心它产出一个规范化的 `TriggerEvent`。

```ts
interface TriggerEvent {
  id: string;               // stable, unique — used for idempotency
  source: string;           // "github.pull_request", "cron.daily", "manual"
  occurredAt: string;       // ISO-8601, from the Clock port
  payload: unknown;         // opaque to the core; typed by the workflow
  correlation?: Correlation; // optional keys linking to external entities
}
```

触发器是唯一的入站边，并通过 **EventSource 端口**（§6）进入。核心自带一个内存事件
总线；宿主可以桥接 webhook/cron。

### 3.2 条件（Condition）

针对 `(event, context)` 的**纯谓词**。无副作用、无 I/O、确定性。条件决定工作流是否
继续执行；它们从不决定动作*走多远*——那是自主性的职责，并且被刻意保持分离。

```ts
type Condition = (event: TriggerEvent, ctx: ExecutionContext) => boolean;
```

纯粹性是一条硬性规则：它使运行可复现，并让 Shadow 有意义。一个访问网络的条件属于
设计错误。

### 3.3 策略（Policy）

策略**治理自主性并约束执行**。针对 `(event, ctx, intent)` 求值，策略返回一个决策。
关键不变量是：

> **安全的单调性。** 策略只能*降低*有效自主级别或增加约束。它绝不能将自主性提升到
> 动作所请求的级别之上。当多个策略同时适用时，**最严格者**胜出。

```ts
interface PolicyDecision {
  effectiveAutonomy: AutonomyLevel;   // min(requested, every policy's cap)
  requiresApproval: boolean;          // can force Draft even if Autonomous
  denied?: { reason: string };        // hard stop
  constraints: AppliedConstraint[];   // rate limit, time window, allowlist, budget
}
```

这是最重要的单一安全界面。由于有效级别是所有策略上的*最小值*，且永远不能超过请求，
因此新增一条策略只可能让系统更安全——绝不会更不安全。新策略部署起来始终是安全的。

### 3.4 动作（Action）

**动作是声明式的**：它描述一个意图中的作用，而非其执行。它给出动作 `type`、携带
带类型的输入，并指向某个连接器。产生一个动作没有副作用——它产出一个 `ActionIntent`。

```ts
interface ActionIntent<Input = unknown> {
  type: string;             // "email.send", "calendar.createEvent"
  connectorId: string;      // which connector performs it
  input: Input;             // validated against the action's schema
  requestedAutonomy: AutonomyLevel;
  idempotencyKey: string;   // derived from (runId, actionId); dedupes retries
}
```

### 3.5 连接器（Connector）

真正触及外部系统的适配器。**尽可能隔离且无状态。** 连接器声明其动作；每个动作都
干净地拆分为两个函数——而这一拆分*本身*就是自主性机制：

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

连接器作者只需思考两个问题——*我会做什么？*（`render`）与*去做它*（`execute`）
——即可免费获得完整的 Observe/Shadow/Draft/Autonomous 生命周期。决定 `execute` 是否
会被触及的是运行时，而非连接器。编写 SDK 详见 §8。

### 3.6 执行结果（Execution Result）

结果记录。每次运行对每个动作都会产生一条，在每个自主级别都是如此（即便是 Observe，
它也会记录什么都没做以及原因）。

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

## 4. 自主门

自主性是逐动作的属性（在工作流层设定默认值，由策略封顶）。这道门决定每个
`ActionIntent` 沿流水线向下走多远。

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

引擎强制保证的约束：

| 级别 | 调用 `render`？ | 调用 `execute`？ | 人在环中 |
|---|---|---|---|
| **Observe** | 否 | 否 | — |
| **Shadow** | 是 | **否** | 人类仍然行动；预测作为证据被记录 |
| **Draft** | 是 | 仅在审批后 | 每次作用前都需审批 |
| **Autonomous** | 是 | 是（策略允许时） | 通知/可审计，不阻塞 |

由于 `execute` *只*能通过 Autonomous 分支（或已审批的 Draft）抵达，而该分支又受
`min(requested, all policies)` 守护，因此不存在任何在超出许可级别的情况下执行作用的
代码路径。这正是 §1 所述的结构性安全属性。

**Shadow 与边界。** Shadow 记录一份忠实的预测外加关联键，然后停止。将该预测与人类
实际所做进行对比（“差异成为证据”）需要知道人类的动作——而它存在于*本仓库之外*。
因此运行时通过审计/证据端口连同关联元数据一起发出预测，并不试图亲自去观察现实。
差异对比是操作系统层的关注点。保持这条界线清晰，正是维持独立性的关键。

---

## 5. 执行流水线

一次运行，端到端：

1. **摄入（Ingest）**——`TriggerEvent` 经由 EventSource 端口抵达。
2. **构建上下文（Contextualize）**——由事件和工作流输入构建一个 `ExecutionContext`。
   不查询任何外部记忆；上下文是自包含的。
3. **求值条件（Evaluate conditions）**——纯谓词；任一门未通过则中止。
4. **规划动作（Plan actions）**——声明式地产出 `ActionIntent`（无副作用）。
5. **治理（Govern）**——对每个 intent 求值策略 → `PolicyDecision`
   （`effectiveAutonomy`、审批、约束、拒绝）。
6. **过门（Gate）**——按有效自主级别为每个 intent 路由（§4）。
7. **渲染 / 执行（Render / Execute）**——调用连接器的 `render`，并在许可时调用
   `execute`，遵循 `idempotencyKey`。
8. **记录（Record）**——向审计接收端发出 `ExecutionResult` + 完整的决策轨迹。

引擎是覆盖这些步骤的一个小型确定性 reducer。给定相同的事件、上下文与时钟，一次运行
在直到 `execute` 的外部作用之前都是可复现的——这正是 Shadow 可信、测试廉价的原因。

**幂等性与投递。** `execute` 采用至少一次（at-least-once）语义；连接器使用
`idempotencyKey` 去重。重试绝不会重新渲染成*不同的*载荷（render 是纯的），因此一次
重试只能重复同一个意图中的作用。

---

## 6. 端口（六边形架构，本地优先）

核心仅依赖接口。每个端口都自带一个零配置的本地适配器，使运行时无需安装任何东西即可
在笔记本上运行；操作系统层可以在不触碰核心的情况下换入真实适配器。

| 端口 | 用途 | 内存默认实现 | 持久化适配器 |
|---|---|---|---|
| `Clock` | 时间（确定性测试） | `SystemClock` / `ManualClock` | — |
| `Store` | 运行 + 结果 + 事件去重 | `MemoryStore` | `FileStore`、`SqliteStore` |
| `AuditSink` | 追加式的决策 + 作用日志 | `MemoryAuditSink` | `FileAuditSink`、`SqliteAuditSink` |
| `ApprovalGateway` | 持久化 Draft + 决策 | `MemoryApprovalGateway` | `FileApprovalGateway`、`SqliteApprovalGateway` |
| `Transactor`（可选） | 原子性的多写提交 | —（顺序回退） | `SqliteTransactor` |
| `SecretProvider` | 连接器凭据 | `StaticSecretProvider` / `EnvSecretProvider` | — |

两种持久化后端，同一套接口，核心无需改动：

- **File**（`createFileBackend(dir)`）——原子写入的 JSON，零依赖。运行及其去重指针是
  两次独立的写入，因此两者之间的崩溃可能让被重投的事件重新运行（通过稳定的幂等键
  缓解）。
- **SQLite**（`createSqliteBackend(path)`）——事务性。运行及其
  `UNIQUE(workflow_id, event_id)` 去重键是**同一行、一次原子提交**，因此两次写入的
  崩溃窗口在构造上即被关闭：崩溃之后，运行及其去重键要么都持久化、要么都不存在，即使
  跨进程也不可能出现重复运行。`better-sqlite3` 是可选的对等依赖（peer dependency），
  仅经由 `/adapters/sqlite` 入口点导入——核心从不加载它。

第二个后端能够无缝接入现有的 `Store`/`AuditSink`/`ApprovalGateway` 接口——引擎无需
改动——正是端口设计带来的回报。

触发器通过直接调用 `runtime.dispatch(event)`（或 `run(workflowId, event)`）进入，
因此 v0 没有 `EventSource` 端口——由宿主将 webhook/cron 桥接到这些调用。
`ConnectorRegistry` 是运行时自己拥有的具体类，而非端口（没有理由去替换 `connectorId`
解析为连接器的方式）。

核心中没有任何适配器引用 Blackboard、Experience 或 SignalsOS。那些集成是*操作系统
提供的适配器*，它们依赖运行时——绝不反过来。依赖箭头始终指向内部。

---

## 7. 模块布局

v0 是一个**零运行时依赖的单一包**。其模块沿着未来拆包会遵循的边界来划分，因此接缝
从一开始就落在正确的位置。

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
  adapters/         # in-memory + durable adapters (file, sqlite) for every port
  connectors/email.ts   # example connector (in-memory transport)
  cli.ts            # inspection CLI
docs/ARCHITECTURE.md
```

维持边界诚实的规则（由代码评审强制执行；未来的 import-graph CI 检查会使其机械化）：

- 核心（`engine`、`policy`、`gate`、……）不导入任何连接器和任何适配器。
- 连接器只导入连接器契约 + schema。
- 任何地方都不导入 Blackboard / Experience / SignalsOS。

当这些模块成长时，它们会被抽取成包——`runtime-core`、`connector-sdk`、
`store-sqlite`、各个连接器包——而无需跨越此处所划分的接缝移动代码。

---

## 8. 连接器编写（人机工程学的赌注）

明确的优化目标是*连接器编写速度*。SDK 将一个连接器精简为若干 schema 加上每个动作
两个函数：

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

作者从运行时免费获得的能力：

- 边界处的输入校验（错误的 intent 永远到不了 `render`）。
- 完整的自主生命周期——同一个连接器在全部四个级别下都可工作，连接器代码中无需任何
  分支。
- 通过 `idempotencyKey` 实现的幂等执行。
- 对每一次 render、审批与作用的审计。
- 可测试性：`render` 是纯的，因此针对 Shadow 的黄金文件（golden-file）测试轻而易举。

连接器保持无状态：任何凭据都来自 `ctx` 中的 `SecretProvider`，绝不来自模块状态。

---

## 9. 横切不变量

1. **独立性。** 对 Blackboard / Experience / SignalsOS 零依赖。由针对 import graph 的
   lint/CI 检查验证。
2. **安全单调性。** 有效自主性 = `min(requested, all policies)`。新增策略只可能让系统
   更安全。
3. **render/execute 分离。** 除了通过 Autonomous 分支或已审批的 Draft，`execute`
   不可达。由引擎强制，而非靠作者的自律。
4. **一切皆可审计。** 每次运行都会向 `AuditSink` 发出一份完整的决策轨迹，在每个自主
   级别都是如此——包括“已观察 / 什么都没做”。
5. **可复现性。** 相同的事件 + 上下文 + 时钟 ⇒ 相同的运行，直到外部作用为止。这正是
   让 Shadow 诚实、测试快速的原因。
6. **本地优先。** 通过默认适配器，无需任何外部服务即可运行。

---

## 10. v0 中已敲定的决策

这些曾是悬而未决的问题；v0 按如下方式敲定它们。

1. **自主性粒度**——*逐动作*是基本单位。每个 `PlannedAction` 携带自己的
   `requestedAutonomy`；一个工作流的有效自主性就是其各动作中最严格的那个。不存在
   独立的工作流级别去与之失同步。
2. **多动作运行**——v0 中*仅顺序执行*。依赖通过 `dependsOn` 引用更早的 `ref` 来声明，
   并被校验为只能向后引用，以便日后可以在不改变动作形态的前提下加入并行调度。一项
   依赖被视为*已满足*，除非它出错——`failed`、`denied`、`skipped` 和 `rejected` 都不
   满足（其依赖方被置为 `skipped`，失败即关闭（fail-closed））；`observed`、
   `predicted`、`drafted` 和 `executed` 全部满足。将 `drafted` 视为满足，可让整个
   Draft 模式的工作流一次性渲染所有动作以供评审。已知的注意点：一个 `dependsOn` 仍
   处于 pending 状态的 Draft 的 Autonomous 动作，会在该 Draft 被审批之前执行——这是一
   种作者应当避免的、不寻常的混合级别计划。它并未破坏核心安全属性：每个动作仍然只在
   其自身被治理的级别下执行。
3. **失败行为**——*失败即关闭（fail-closed）*，在每一条边界上都一致。抛出异常的
   render/execute 产出 `failed`；抛出异常的*策略*会拒绝该动作
   （`policy_evaluation_failed`），而不是中止整个运行；未达到满足性结果的依赖产出
   `skipped`；抛出异常的条件会中止运行。没有任何东西会失败即开启（fail open），并且
   任何已触发过作用的运行总会连同其结果一起被持久化——作用绝不会成为孤儿。为坚守这
   一点，连接器 `execute` 中不可结构化克隆（structured-cloneable）的输出会在进入运行
   记录之前被替换为一个标记，从而使持久化不会在作用已发生之后抛出异常。
4. **Draft 执行**——解析一次审批是一个独立且显式的调用。在有一条已记录的决策之前，
   执行在结构上是不可能的。
5. **Schema 依赖**——运行时依赖 `Schema<T>` *接口*，并附带一个内置的零依赖实现。
   Zod（或任何 `{ parse }`）可原样接入。

v0.1 中新增（持久化与运维安全），全部对 API 而言是纯增量的：

- **持久化文件后端**——`createFileBackend(dir)` 持久化运行、审计与审批，使状态在进程
  重启后仍然存续。
- **幂等摄入**——`Store.findRunByEvent` 使被重投的事件（重复的 webhook）返回原始运行，
  而不是执行两次；该重复事件会被审计为 `trigger.deduplicated`。连接器
  `idempotencyKey` 派生自 `(workflow, event, action)`——而非运行 id——因此即便摄入去重
  被绕过，作用级别的去重仍然有效。
- **审批 TTL**——`approvalTtlMs`；超过其截止时间的待处理 Draft 会失败即关闭地过期
  （`expired`），由 `sweepExpiredApprovals()` 强制执行，或在 resolve 时惰性执行。
- **连接器超时**——`connectorTimeoutMs` 为每次 render/execute 设定上界；超时会失败即
  关闭（`render_timeout` / `execute_timeout`）。调用并不会被取消，因此超时限制的是
  等待，而非作用本身——这正是稳定的幂等键至关重要的原因。

v0.2 中新增：

- **事务性 SQLite 后端**（`createSqliteBackend`）——通过将运行及其去重键做成一行原子
  记录，关闭文件存储的两次写入崩溃窗口。可选的对等依赖，隔离在其自己的入口点中。

v0.3 中新增：

- **工作单元**（`Transactor` 端口）——解析一次审批时，会在一个事务
  （`SqliteTransactor`）中提交其状态、执行结果以及该决策的审计记录，从而消除核心流程
  中最后一处多写不一致。外部作用在事务*之前且之外*运行（它无法被回滚）；审批仅在
  记录提交时才翻转为 `approved`，因此作用进行到一半时的崩溃会让它保持可重新解析，且
  该作用会由其幂等键去重。没有事务器的后端会顺序地施加这些写入——引擎在两种情形下都
  不变。这是未来 saga/回滚/并行工作将在其上构建的边界。

仍被推迟（日后加入时对 API 无影响）：

- **并行调度**——跨相互独立的 `dependsOn` 分支的并行调度，被刻意安排在持久化状态原
  子性之后，因为并行会放大一致性缺陷。
- **跨进程文件协调**——*文件*适配器假定单个运行时独占其目录（仅进程内加锁）。SQLite
  后端在去重/运行原子性方面没有此类限制。
- **面向整次运行的事务范围**——v0.3 使审批*解析*原子化（状态 + 结果 + 审计）。将一次
  提交扩展到覆盖整个多动作运行（以及日后的 saga/回滚），会在同一个 `Transactor`
  边界之上构建。
- **补偿 / 回滚**——针对部分失败的补偿/回滚，很可能是操作系统层的 saga 关注点，而非
  连接器的职责。
- **Shadow 关联差异对比**——运行时发出带关联键的预测；将它们与现实进行对比仍留在本
  仓库之外。
- **声明式（数据定义的）策略格式**——策略目前是代码。

---

## 11. “做到极致”是什么样子

- 一个新连接器就是单个文件：schema + `render` + `execute`。
- 把一个工作流从 Shadow 切到 Draft 再切到 Autonomous 是一次策略变更，绝非代码变更。
- 评审者可以指着代码路径，看到没有任何作用能跑过它的策略。
- 整个系统无需安装任何东西即可在笔记本上运行，而同一份代码在操作系统中接上真实适配
  器后照样运行。

[English](README.md) | **简体中文**

# Octopus Runtime

[![CI](https://github.com/octoryn/octopus-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/octoryn/octopus-runtime/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/octoryn/octopus-runtime?sort=semver)](https://github.com/octoryn/octopus-runtime/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](.nvmrc)
[![Built on octopus-evidence](https://img.shields.io/badge/built%20on-octopus--evidence-7c9cff.svg)](https://github.com/octoryn/octopus-evidence)

> **[Octopus Core](https://github.com/octoryn) 的一部分 —— 受治理 AI 的开源基础设施栈。** 每个仓库只做一件事，沿 agent 生命周期组合：[Scout](https://github.com/octoryn/octopus-scout) · [Observe](https://github.com/octoryn/octopus-observe) · [Experience](https://github.com/octoryn/octopus-experience) · [Blackboard](https://github.com/octoryn/octopus-blackboard) · [Runtime](https://github.com/octoryn/octopus-runtime) · [Replay](https://github.com/octoryn/octopus-replay) —— [Inspect](https://github.com/octoryn/octopus-inspect) 横贯每一环做治理。整个技术栈都构建于同一个根原语 [Evidence](https://github.com/octoryn/octopus-evidence) 之上 —— 那个规范的、防篡改的原子，也是每一环共同言说的根范畴。
>
> **本仓库 —— Runtime · 执行：** 让不安全的操作在结构上不可能。

**一个独立的、受治理的执行运行时。** 它只回答一个问题：

> 工作如何才能安全地从观察走向行动？

Workflow Runtime 负责将一个事件从触发一路带到结果，途中穿越自主级别、
策略、审批、连接器、执行和审计等边界。它唯一的职责就是**受治理的执行**。
它没有记忆、没有仪表盘、没有规划 AI，也不在编译期依赖任何外围系统。
可以类比 Unix：只承担一项职责，并把它做到极致。

```
Trigger → Conditions → Policies → Action Plan → Autonomy Gate
       → Approval Gate → Connector Render/Execute → Result → Audit Record
```

## 核心理念：自主级别

每个动作都携带一个**自主级别（autonomy level）**，用以约束它在通向外部效应
的路上能走多远：

| 级别 | 行为 | `render` | `execute` |
|---|---|---|---|
| **观察（Observe）** | 仅观察；记录“未执行任何操作” | ✗ | ✗ |
| **影子（Shadow）** | 对效应做出忠实的预测渲染 | ✓ | ✗ |
| **草稿（Draft）** | 准备好效应并作为一项审批挂起 | ✓ | 仅在审批通过后 |
| **自主（Autonomous）** | 立即执行，受策略约束 | ✓ | ✓ |

该运行时的核心安全特性是**结构性的**，而非约定俗成的：连接器中具有副作用的
`execute` 除了在自主（Autonomous）路径上，或在草稿（Draft）审批通过之后，
其余情况均不可达——并且有效自主级别始终等于
`min(requested, every applicable policy)`。新增一条策略只会让系统更安全。

## 安装

```bash
npm install octopus-runtime
```

需要 Node ≥ 22。核心库**零第三方依赖**：唯一的运行时依赖是第一方的
[`octopus-evidence`](https://github.com/octoryn/octopus-evidence) 原语（其自身零依赖），
它提供整个技术栈共享的规范化哈希与防篡改 Evidence —— 也正是把一次路由决策变成可验证审计轨迹的同一原语（见
[`decisionEvidence`](#decision-evidence)）。运行时在其他方面仍可完全独立使用。

## 快速上手

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

运行内置的示例和 CLI：

```bash
npm run example
npx octopus-runtime demo autonomous   # or: observe | shadow | draft
```

## 治理你已有的工具

无需重写 agent 即可治理它。`governTool` 包裹任意异步工具函数 —— LangChain 工具的
`func`、CrewAI/agent 工具、普通的 `(input) => output` —— 让其副作用经过同一个自主门,
且由运行时真实的路由(而非副本)强制执行:

```ts
import { governTool, AutonomyLevel } from "octopus-runtime";

// 你已有的工具(例如某个 LangChain DynamicStructuredTool 的 func)。
const sendEmail = async (input: { to: string; subject: string }) => post("/email", input);

const governed = governTool(sendEmail, {
  autonomy: AutonomyLevel.Draft,          // 把副作用暂扣待审批
  ceiling: AutonomyLevel.Autonomous,      // 环境/策略上限:effective = min(requested, ceiling)
  render: (i) => `会向 ${i.to} 发送 "${i.subject}"`,      // shadow/draft 时展示,无副作用
  approve: async ({ preview }) => askHuman(preview),       // 仅在 draft 路由被调用
});

const r = await governed({ to: "a@b.com", subject: "Hi" });
// r.executed 仅在 `autonomous` 路由或已批准的 `draft` 上为 true;
// 在 observe/shadow/denied/未批准 draft 时,真实工具从不被调用。
```

被包裹的函数**只**在 `autonomous` 路由、或 `approve` 返回 true 后的 `draft` 上被调用
—— 把结构性保证作用到你已经在跑的工具上。这按构造对应 OWASP Agentic 的 **ASI02**
(工具滥用)与 **ASI09**(人-机信任)。若需完整策略评估、连接器与审计轨迹,请把副作用
定义为连接器并经由 `Engine` 运行(见下)。可运行:[`examples/govern-tool.ts`](examples/govern-tool.ts)。

## 编写连接器

连接器是无状态且相互隔离的。每个动作都拆分为一个**纯函数 `render`** 和一个
**带副作用的 `execute`**——而这一拆分*本身*就是自主机制。你只需将两者各写
一次；由运行时决定实际运行哪一个。

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

在 `render` 被调用之前，输入会先按 schema 校验。任何满足 `Schema<T>` 接口的
对象都可用——包括 Zod schema——因此你并不会被绑定到内置校验器上。

开箱即带两个连接器：一个内存版 `email`（用于示例/测试），以及一个基于平台
`fetch`、真正零依赖的 **`http`** 连接器——`octopus-runtime/connectors/http`。
HTTP 连接器会在变更类请求上附加一个由运行时稳定幂等键派生出的
`Idempotency-Key`，并在收到非 2xx 响应时失败即关闭（fail-closed）。

## 用策略进行治理

策略决定一个动作能走多远。它们是**单调的**：策略只能降低自主级别、强制审批、
添加约束或直接拒绝——绝不会提升自主级别。

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

## 端口与本地优先设计

核心仅依赖接口（**端口，ports**），每个端口都配有一个零配置的内存适配器，
因此该运行时可以在一台什么都没安装的笔记本电脑上运行：

| 端口 | 默认适配器 |
|---|---|
| `Store` | `MemoryStore` · 持久化的 `FileStore` · 事务型的 `SqliteStore` |
| `AuditSink` | `MemoryAuditSink` · `FileAuditSink` · `SqliteAuditSink` |
| `ApprovalGateway` | `MemoryApprovalGateway` · `FileApprovalGateway` · `SqliteApprovalGateway` |
| `Transactor`（可选） | —（SQLite 提供 `SqliteTransactor`） |
| `Clock` | `SystemClock`（测试用 `ManualClock`） |
| `SecretProvider` | `StaticSecretProvider` / `EnvSecretProvider` |

外层操作系统可以替换为持久化或联网的适配器——包括那些桥接到记忆、感知或信号
系统的适配器——而**无需触碰核心**。依赖箭头始终指向内部。

## 持久化、幂等与时限

对于那些必须能挺过真实进程重启、重复投递、审批延迟和慢速连接器的工作，只需
换上持久化的文件后端，并设置两个选项——工作流和连接器代码无需任何改动：

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

开箱即带两个持久化后端：

- **`createFileBackend(dir)`** —— 落盘的零依赖 JSON。非常适合本地和单进程使用。
- **`createSqliteBackend(path)`** —— 事务型 SQLite，生产环境的首选。一次运行
  及其去重键在 `UNIQUE(workflow, event)` 约束下是*同一行*，并被原子性地提交
  ——因此**不存在两次写入之间的崩溃窗口**：被重新投递的事件无法在崩溃后再次
  运行，且每个事件最多只会存在一个运行*行*，即便跨进程也是如此（效应级别的
  恰好一次仍依赖连接器幂等键）。需要可选的对等依赖 `better-sqlite3`
  （`npm i better-sqlite3`）；请从 `octopus-runtime/adapters/sqlite` 导入。
  核心永远不会加载它。

  ```ts
  import { createSqliteBackend } from "octopus-runtime/adapters/sqlite";
  const backend = createSqliteBackend("./runtime.db");
  const runtime = createRuntime({ ...backend, connectors, workflows });
  ```

### 原子状态转换（工作单元）

解析一次审批会同时移动三份持久化状态：审批的状态、执行结果，以及该决策的审计
记录。借助 `Transactor`（SQLite 提供其一；展开 `...backend` 即可提供它），
这些写入会在**一个事务中**提交——崩溃不会留下一个被标记为 `approved`、却没有
任何已记录结果的审批。外部效应会*先于事务、在事务之外*运行（它无法被回滚）；
只有当“发生了什么”的记录提交之后，审批才会翻转为 `approved`，因此在效应执行
中途发生崩溃时，审批仍可被重新解析，而效应则通过其幂等键去重。没有事务器时，
同样的写入会顺序执行——结果依然正确，只是不具备崩溃原子性。

两个持久化后端都为你提供了以下能力：

- **挺过重启。** 运行记录、审计轨迹和挂起的审批都是持久化的。重启前创建的
  草稿（Draft），重启后仍可解析。
- **幂等摄取。** 被重新投递的事件（相同 `id`、相同工作流）——例如重复的
  webhook——会返回原始运行，而不会再次执行，并且该事件会被审计为
  `trigger.deduplicated`。
- **效应级别的幂等。** 交给连接器的 `idempotencyKey` 由 `(workflow, event, action)`
  派生而来，因此即便摄取去重被绕过（两个 worker、丢失的指针），一个基于它做
  去重的连接器也只会触发效应至多一次。
- **审批 TTL。** 超过 `approvalTtlMs` 的挂起草稿会失败即关闭（fail-closed）地
  过期——它永远不会被执行。可从调度器中调用
  `runtime.sweepExpiredApprovals()`，否则当有人尝试解析一个逾期审批时会被惰性
  强制执行。
- **连接器超时。** 超过 `connectorTimeoutMs` 的 `render`/`execute` 会失败即
  关闭（`render_timeout` / `execute_timeout`）。该超时约束的是运行时*等待*
  多久；由于底层调用不会被取消，效应必须是幂等的——这正是上文的稳定键所保证的。

## 读取已发生的一切

```ts
await runtime.read.getRun(runId);
await runtime.read.getRunResults(runId);
await runtime.read.getAuditTrail(runId);    // an entry at every boundary crossed
await runtime.read.listPendingApprovals();
```

## 边界——它不是什么

Workflow Runtime **不是**记忆系统、感知层、信号处理器、体验层、可观测性平台，
也不是一个宽泛的智能体编排器。它治理的是向外的效应。其余一切都属于那个可能
把本运行时与上述系统组合起来的操作系统——而本仓库从不假设它们存在。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test (83 tests)
npm run build       # emit dist/
```

完整设计参见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可证

[Apache-2.0](LICENSE)

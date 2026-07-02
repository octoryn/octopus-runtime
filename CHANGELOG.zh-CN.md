[English](CHANGELOG.md) | **简体中文**

# 更新日志

本文件记录项目的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/),
版本遵循 [语义化版本(SemVer)](https://semver.org/)。

## [0.3.1] — 2026-07-02

### 新增

- 由 tag 驱动的发布工作流(`.github/workflows/release.yml`):推送 `v*` tag 即以 provenance
  (供应链证明)发布到 npm。

### 变更

- 联系邮箱迁移到 `octopusos.ai` 域名(`security@octopusos.ai`、`conduct@octopusos.ai`);
  包作者设为 `Ran Tao <ran@octopusos.ai>`。

## [0.3.0] — 2026-07-02

### 新增

- **事务性工作单元(unit of work)。** 新增可选的 `Transactor` 端口 + `StateChange` 类型。审批的处理
  现在会把其状态、执行结果、以及该决策的审计记录作为一个原子单元一并提交。`SqliteTransactor` 提供真正的
  事务;没有 transactor 时,这些写入按顺序依次应用。
- **HTTP 连接器**(`octopus-runtime/connectors/http`)—— 一个真实、零依赖、基于平台 `fetch` 的连接器,
  对写操作附加 `Idempotency-Key`,并在非 2xx 时失败即关闭。
- `schema.record`,用于校验键名任意的对象。
- 发布工程:AGPL-3.0-or-later 的 `LICENSE`、GitHub Actions CI、ESLint + Prettier、
  `.editorconfig`/`.nvmrc`、双语文档,以及社区健康文件(`CONTRIBUTING`、`CODE_OF_CONDUCT`、`SECURITY`)。

### 变更

- 外部效果现在在审批事务*之前、之外*执行;审批只有在记录提交时才翻转为 `approved`,因此效果执行中途
  崩溃时该审批仍可重新处理(由其幂等键去重)。
- 包重命名为 `octopus-runtime`,并采用 **AGPL-3.0-or-later** 许可,与 Octoryn 开源家族风格对齐。
  最低 Node 版本现为 22。

## [0.2.0] — 2026-07-02

### 新增

- **事务性 SQLite 后端**(`createSqliteBackend`)。一次运行与其 `(workflow, event)` 去重键是
  `UNIQUE` 约束下的同一行,原子提交 —— 从而关闭了文件存储的"两次写入崩溃窗口"。`better-sqlite3` 是可选
  peer 依赖,隔离在 `/adapters/sqlite` 入口。

### 修复

- 持久化存储改用不会抛异常的 `safeJsonStringify` 序列化,因此 execute 输出中对 JSON 不友好的值
  (例如 `BigInt`)不再会在 `saveRun` 中抛错并遗留一个已经发出的效果。
- `resolveApproval` 在 execute 的 try/catch *之外*持久化结果,因此存储错误不会把一次成功的效果误标为
  `failed`。

## [0.1.0] — 2026-07-02

### 新增

- **持久化文件后端**(`createFileBackend`),用于 运行、审计、审批。
- **幂等接入**:重复投递的事件会返回原有运行;并发重复会合并到同一个进行中的运行上。
- 连接器 `idempotencyKey` 由 `(workflow, event, action)` 派生 —— 跨重复投递与重启保持稳定。
- **审批 TTL**(`approvalTtlMs`、`sweepExpiredApprovals`)与**连接器超时**(`connectorTimeoutMs`),
  二者均失败即关闭。

## [0.0.1] — 2026-07-02

### 新增

- 初始版本的受治理执行运行时:triggers → conditions → policies → action plan →
  autonomy gate(观察/影子/草稿/自主)→ approval gate → 连接器 render/execute → result → audit。
- 结构性安全(execute 不可能在高于其受治理级别处可达)、单调策略引擎、失败即关闭的错误处理、
  带内存默认实现的可插拔端口、示例 email 连接器、读取 API、CLI。

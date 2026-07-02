[English](CONTRIBUTING.md) | **简体中文**

# 为 Octopus Runtime 贡献

感谢你有意贡献。本指南介绍基本流程。

## 开发环境

```bash
npm install
npm run example   # 运行内置演示
```

需要 Node ≥ 22。核心零运行时依赖;`better-sqlite3` 是一个可选的 peer 依赖,仅 SQLite 适配器会用到。

## 提 PR 之前

请在本地跑完整的检查门槛 —— CI 跑的是同一套检查:

```bash
npm run typecheck     # tsc --noEmit,必须干净
npm run lint          # eslint
npm run format:check  # prettier
npm test              # node --test
npm run build         # 产出 dist/
```

- **类型安全:** 项目开启 `strict`。除非不可避免并加注释,否则不允许出现 `any` 逃逸。
- **测试:** 新行为必须有测试。测试必须是**自洽的(hermetic)** —— 不访问外部网络(HTTP 连接器测试针对
  本地 `node:http` 服务器运行)、使用唯一的临时目录并清理干净。
- **零依赖核心:** `src/` 下(除 `adapters/sqlite.ts` 外)不得引入任何运行时依赖。independence 测试会强制
  保证核心永不 import 任何外围系统,且 `package.json` 的 `dependencies` 保持为空。

## 设计不变式(不要侵蚀这些)

运行时的价值在于它的边界。改动必须保持:

- **结构性安全** —— 连接器的 `execute` 仅在 Autonomous 路径上或 Draft 审批之后才可达。
- **策略单调性** —— 有效自主级别 = `min(requested, 所有策略)`;策略只能降低自主级别,绝不能提高。
- **失败即关闭(fail-closed)** —— 抛错的 condition/policy/render/execute、未满足的依赖或超时,
  都绝不会触发或遗留(orphan)任何效果。
- **独立性** —— 对任何外围系统无编译期依赖。

模块结构与完整的不变式清单见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 提交 / PR

- PR 保持聚焦。说明改了什么、为什么。
- 面向用户的改动请更新 `CHANGELOG.md`。
- 改动公共 API 时,请同步更新相关文档(`README.md`、`docs/`)。

## 报告 Bug / 安全问题

普通 bug 请正常提 issue。安全漏洞请遵循 [SECURITY.md](SECURITY.md),不要公开提 issue。

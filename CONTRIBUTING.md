**English** | [简体中文](CONTRIBUTING.zh-CN.md)

# Contributing to Octopus Runtime

Thanks for your interest in contributing. This guide covers the basics.

## Development setup

```bash
npm install
npm run example   # run the bundled demo
```

Requires Node ≥ 22. The core has zero runtime dependencies; `better-sqlite3` is
an optional peer dependency used only by the SQLite adapter.

## Before opening a PR

Run the full local gate — CI runs the same checks:

```bash
npm run typecheck     # tsc --noEmit, must be clean
npm run lint          # eslint
npm run format:check  # prettier
npm test              # node --test
npm run build         # emit dist/
```

- **Type safety:** the project is `strict`. No `any` escapes unless unavoidable
  and commented.
- **Tests:** new behavior needs tests. Tests must be **hermetic** — no external
  network (the HTTP connector tests run against a localhost `node:http` server),
  unique temp dirs, cleaned up.
- **Zero-dependency core:** nothing under `src/` (outside `adapters/sqlite.ts`)
  may add a runtime dependency. The independence test enforces that the core
  never imports a surrounding system and that `package.json` `dependencies` stays
  empty.

## Design invariants (do not erode these)

The runtime's value is its boundaries. Changes must preserve:

- **Structural safety** — a connector's `execute` is unreachable except on the
  Autonomous path or after a Draft approval.
- **Policy monotonicity** — effective autonomy = `min(requested, every policy)`;
  a policy can only lower autonomy, never raise it.
- **Fail-closed** — a thrown condition/policy/render/execute, an unsatisfied
  dependency, or a timeout never fires or orphans an effect.
- **Independence** — no compile-time dependency on any surrounding system.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map and the full
list of invariants.

## Commit / PR

- Keep PRs focused. Describe what changed and why.
- Update `CHANGELOG.md` for user-facing changes.
- Update the relevant docs (`README.md`, `docs/`) when you change the public API.

## Reporting bugs / security issues

File a normal issue for bugs. For security vulnerabilities, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

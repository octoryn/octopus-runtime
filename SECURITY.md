**English** | [简体中文](SECURITY.zh-CN.md)

# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report privately via GitHub Security Advisories ("Report a vulnerability" on the
repository's Security tab) or email **security@octopusos.ai**. Include a
description, reproduction steps, and impact. We aim to acknowledge within a few
business days.

## Scope notes

Octopus Runtime governs how work moves from observation to action, so a few
areas are security-relevant by design:

- **Structural safety is the core guarantee** — a connector's side-effectful
  `execute` must be unreachable except on the Autonomous path or after a Draft
  approval, and effective autonomy is `min(requested, every policy)`. A defect
  that lets an effect run above its governed autonomy level is a security issue;
  report it.
- **Connectors are the trust boundary to the outside world.** The bundled HTTP
  connector requests whatever URL a workflow plans; if any part of that URL
  derives from untrusted input, guard it (restrict hosts/schemes in the planner
  or with a policy) to avoid SSRF. The runtime governs *whether* a request runs,
  not *where* it goes.
- **Secrets** are supplied through the `SecretProvider` port and read by
  connectors at execute time; they are never persisted in run records or audit.
- **Durable stores** persist run/approval/audit data as JSON or SQLite on the
  host you point them at — protect that data directory / database file.

## Supported versions

This project is pre-1.0; only the latest version receives fixes.

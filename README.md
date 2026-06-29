# sdd-platform

[English](README.md) | [中文](README.zh-CN.md)

Shared SDD (Spec-Driven Development) factory, compiler, schemas, templates, and reusable workflows.

This is the shared hub of a two-repo setup:

- **`sdd-platform`** — shared Factory, Compiler, Schemas, Templates, and Workflows (this repo).
- **`demo-product`** — a single-product monorepo that consumes them.

## Structure

```text
sdd-platform/
├── cli/                # `sdd` CLI (planned)
├── factory/            # product / repo bootstrap
├── backlog-compiler/   # spec + plan -> GitHub Issues
├── schemas/            # projects / task / impact JSON schemas
├── templates/          # monorepo-root, spring-boot, web, ios-tuist, android
└── .github/workflows/  # reusable CI workflows (java, web, ios, android)
```

## CLI

> **Not implemented yet.** Until the `sdd` CLI lands, run the equivalent steps via scripts or manual PRs — the artifact formats and gates stay the same.

Planned command set:

```text
sdd product init
sdd product scaffold
sdd validate
sdd impact
sdd backlog compile
sdd backlog publish
sdd sync --check
```

## Reference

Implementation and operations runbook: `docs/sdd/single-repo-implementation-runbook.md` (in the `sdd-agent-starter` repo).

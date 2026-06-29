# sdd-platform

[English](README.md) | [中文](README.zh-CN.md)

共享的 SDD(Spec-Driven Development,规格驱动开发)Factory、Compiler、Schemas、Templates 与可复用 Workflows。

本仓库是双仓库结构中的共享中枢:

- **`sdd-platform`** — 共享 Factory、Compiler、Schemas、Templates、Workflows(本仓库)。
- **`demo-product`** — 消费上述能力的单产品 monorepo。

## 仓库结构

```text
sdd-platform/
├── cli/                # `sdd` CLI(计划中)
├── factory/            # 产品 / 仓库 bootstrap
├── backlog-compiler/   # spec + plan -> GitHub Issues
├── schemas/            # projects / task / impact JSON schema
├── templates/          # monorepo-root、spring-boot、web、ios-tuist、android
└── .github/workflows/  # 可复用 CI workflows(java、web、ios、android)
```

## CLI

> **尚未实现。** 在 `sdd` CLI 落地之前,先通过脚本或人工 PR 执行等价步骤——产物格式和 Gate 保持不变。

计划命令集:

```text
sdd product init
sdd product scaffold
sdd validate
sdd impact
sdd backlog compile
sdd backlog publish
sdd sync --check
```

## 参考

实施与运行手册:`docs/sdd/single-repo-implementation-runbook.md`(位于 `sdd-agent-starter` 仓库)。

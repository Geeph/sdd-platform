# sdd-platform

[English](README.md) | [中文](README.zh-CN.md)

用于创建和运营规格驱动开发（Spec-Driven Development，SDD）项目的共享控制面。

`sdd-platform` 将为生成的产品仓库提供 CLI、仓库 Factory、Backlog Compiler、
Schemas、组件 Templates 和可复用 GitHub Actions Workflows。

> **状态：** 当前处于 bootstrap 阶段。仓库和目标接口已经建立，但下文描述的 CLI
> 与自动化尚未实现。

实施顺序、门禁和验收场景维护在
[单仓库实施操作手册](docs/sdd/single-repo-implementation-runbook.md)中。

## 仓库职责

首个支持的拓扑包含两个活跃仓库：

```text
sdd-platform    共享工具、根/组件模板和自动化（本仓库）
<product-repo>  生成的单产品 monorepo
```

现有 `sdd-agent-starter` 仓库只作为历史参考和可选的人工 GitHub Template；它不是
`sdd-platform` 的运行或生成依赖。

## 规划能力

- 使用固定 `sdd-platform` revision 中的根模板创建产品仓库。
- 配置仓库 labels、CODEOWNERS、environments、rulesets 和 workflows。
- 使用版本化 schemas 校验 `projects.yaml`、task 和 impact 文档。
- 在 Architecture Gate 批准后生成 Backend、Web、iOS 和 Android 组件。
- 将已批准的 spec/design/plan 编译为稳定、按平台划分的 backlog tasks。
- Dry-run 并幂等地把 tasks 发布为 GitHub Issues。
- 检测 spec、design 和 contract 变更，计算受影响的平台与 Issues。
- 提供 Java、Web、iOS 和 Android 的可复用 CI workflows。

## 目标流程

```text
创建根仓库
  -> 批准 Spec
  -> 批准 Architecture 和 projects.yaml
  -> 生成已批准的组件
  -> 需要时批准 Design
  -> 批准 Plan
  -> 编译 backlog（dry-run）
  -> 发布 GitHub Issues
  -> 通过 PR、CI、独立 Review 和人工批准完成实现
```

GitHub Issues 是 backlog 和任务状态的唯一事实来源。生成的报告与 plans 是规划快照，
不能成为第二套任务跟踪系统。

## CLI 目标用法

以下命令定义 MVP 的目标接口。在对应 CLI 里程碑实现并发布前，这些命令会执行失败。

```bash
# 预览产品仓库创建过程，不修改 GitHub 状态。
sdd product init demo --mode monorepo --dry-run

# 只创建根/控制骨架，组件在后续阶段决定。
sdd product init demo --mode monorepo

# 预览并生成 projects.yaml 中已批准的组件。
sdd product scaffold --repo . --projects projects.yaml --dry-run
sdd product scaffold --repo . --projects projects.yaml

# 校验 SDD 产物并计算变更影响。
sdd validate --repo .
sdd impact --base origin/main --head HEAD --format json

# 先编译并审查 dry-run 输出，再发布 backlog。
sdd backlog compile --repo . --version v1 --dry-run
sdd backlog publish --repo . --version v1
```

所有修改状态的命令都必须支持可审查的 dry-run，或者提供等价的预览命令。Backlog
发布必须使用稳定 task IDs，并在失败重试时保持幂等。

## 规划仓库结构

```text
sdd-platform/
├── cli/
├── factory/
├── backlog-compiler/
├── schemas/
│   ├── projects.schema.json
│   ├── task.schema.json
│   └── impact.schema.json
├── templates/
│   ├── monorepo-root/
│   ├── spring-boot/
│   ├── web/
│   ├── ios-tuist/
│   └── android/
└── .github/workflows/
    ├── java.yml
    ├── web.yml
    ├── ios.yml
    └── android.yml
```

根模板和组件模板与 Factory 一起进行版本管理。产品仓库的 `template.lock` 记录生成时
使用的 `sdd-platform` release/commit 和模板 checksums。

## 开发

实现语言、包管理器和本地验证命令将在首个 CLI scaffold 中加入。在此之前，只需克隆
仓库：

```bash
git clone https://github.com/Geeph/sdd-platform.git
cd sdd-platform
```

所有变更都通过小型 Issues 和 Pull Requests 交付。工具链建立后，每个实现 PR 都必须
通过 lint、typecheck、tests 和 build checks。

## 首期范围

首个版本只支持一个产品 monorepo，不包含 multi-repo dispatch、跨仓库 contract
同步、generated SDK registries、自动模板合并、Pact、Terraform 或 Pulumi。

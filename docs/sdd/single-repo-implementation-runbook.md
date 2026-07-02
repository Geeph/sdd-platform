# SDD 单产品 Monorepo 落地操作手册（方案 A）

> 本文是 `sdd-platform` 方案 A 的实施与运行参考，不承担 backlog 状态。实现进度和
> 真实任务状态只存在于 GitHub Issues；本文只维护流程、约束和验收方式。

## 1. 目标与边界

目标是用一个平台仓库和一个产品仓库跑通第一条完整链路：

```text
sdd-platform  # 共享 Factory、Compiler、Schemas、根/组件模板、Workflows
demo-product  # Factory 生成的单产品 monorepo
```

`sdd-platform` 是模板和生成逻辑的唯一权威来源。已有 `sdd-agent-starter` 只作为历史
参考或可选的人工 GitHub Template，不是平台运行或生成链路的依赖。

产品仓库覆盖：

```text
需求 -> Spec -> Architecture -> Design -> Plan -> Backlog
    -> Backend/Web/iOS/Android 实现 -> CI -> Review -> Release
```

本方案不包含：

- 跨仓库 `repository_dispatch`。
- 多仓库合同同步。
- GitHub App fan-out。
- SDK registry 发布。
- 自动跟随上游模板更新。
- 第一阶段引入 Pact、Terraform 或 Pulumi。

## 2. 命令状态说明

本文中的 `sdd ...` 是计划实现的 CLI 接口。CLI 尚未实现时，先通过脚本或人工 PR 执行等价步骤，但产物格式和 Gate 不变。

建议最终命令集合：

```text
sdd product init
sdd product scaffold
sdd validate
sdd impact
sdd backlog compile
sdd backlog publish
sdd sync --check
```

## 3. 前置条件

组织和账号需要具备：

- GitHub Organization 或具备创建仓库权限的账号。
- `gh` CLI 已登录。
- `git` 可用。
- 可运行 Node 或 Python 中选定的 Factory 实现语言。
- iOS CI 需要可用的 GitHub macOS runner。
- Figma 设计流程需要可分享的 Figma 文件权限。

组织层面先确认：

- 是否允许 reusable workflows。
- `main` 是否允许配置 ruleset。
- 需要哪些 CODEOWNERS team。
- CI、preview、release 所需的 environments 和 secrets。

## 4. 一次性建设 `sdd-platform`

### 4.1 创建仓库

创建：

```text
sdd-platform
```

建议结构：

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

Factory 固定到 `sdd-platform` release tag 或 commit，并从同一 revision 读取根模板和
组件模板。生成结果通过 `template.lock` 记录 revision 与内容 checksum。

### 4.2 定义项目拓扑 schema

`projects.yaml` 至少支持：

```yaml
schema_version: 1
product: demo
repository_mode: monorepo

components:
  - id: backend
    path: apps/backend
    template: spring-boot
    template_ref: v1.0.0
    owner: backend-team
    ci: java

  - id: web
    path: apps/web
    template: web
    template_ref: v1.0.0
    owner: web-team
    ci: web

  - id: ios
    path: apps/ios
    template: ios-tuist
    template_ref: v1.0.0
    owner: ios-team
    ci: ios

  - id: android
    path: apps/android
    template: android
    template_ref: v1.0.0
    owner: android-team
    ci: android
```

`projects.yaml` 是 desired topology；目录树是实现结果；`template.lock` 记录实际解析到的模板 commit。

### 4.3 定义 task schema

平台 strategy 统一输出：

```yaml
id: ios.auth.login-screen
platform: ios
track: code
title: Implement login screen

scope:
  - Build the SwiftUI login flow

acceptance:
  - Matches design screen SCR-LOGIN
  - Supports loading, error and offline states
  - VoiceOver checks pass

references:
  requirements:
    - REQ-AUTH-001
  screens:
    - SCR-LOGIN
  operations:
    - loginUser

depends_on:
  - common.contract.login
  - backend.auth.login-api
```

### 4.4 实现一个 Compiler

MVP 不拆多个 agent/service：

```text
compiler
├── common strategy
├── backend strategy
├── web strategy
├── ios strategy
├── android strategy
└── dependency reconciliation pass
```

Compiler 必须：

- 对同一输入产生稳定 task ID。
- 检查重复任务和循环依赖。
- 生成 dry-run，不直接修改 GitHub。
- Plan Gate 后才允许 publish。
- 重复 publish 保持幂等。

### 4.5 实现 Issue upsert

发布 Issue 时写入：

```html
<!-- sdd-task-id: ios.auth.login-screen -->
<!-- sdd-source-revision: abc123 -->
```

处理规则：

```text
找不到 marker          -> create
未开始且内容变化       -> 生成 update diff，确认后更新
In Progress            -> 创建 Change Issue
已完成                 -> 创建 Change/Migration Issue
相同 revision 重复运行 -> no-op
```

### 4.6 模板生命周期

技术模板只做一次性脚手架：

- 生成后业务代码归产品仓库。
- 不自动把模板新版本覆盖进 `apps/*`。
- `template.lock` 用于审计，不用于自动 merge。
- 公共 CI 使用 reusable workflows 升级。
- AGENTS、安全规则等通过显式同步 PR 更新。

## 5. 创建第一个产品仓库

### 5.1 Dry-run

目标接口：

```bash
sdd product init demo \
  --mode monorepo \
  --dry-run
```

Dry-run 必须显示：

- 将创建的仓库。
- 将从固定 `sdd-platform` revision 的 `templates/monorepo-root` 写入的目录和文件。
- 根模板 ref 和 commit。
- 将配置的 labels、ruleset、workflows、CODEOWNERS。
- 缺少的 owner、secret、environment。
- 明确显示 `components: []`，本步骤不生成 `apps/*`。
- 不执行任何 GitHub 写操作。

### 5.2 创建和初始化

```bash
sdd product init demo \
  --mode monorepo
```

`init` 只创建产品控制骨架，不决定技术平台。首个 Architecture Gate 批准
`projects.yaml` 后，才允许生成 `apps/*`。

真实 bootstrap 顺序：

1. Factory 解析并固定 `sdd-platform` release tag 或 commit，校验根模板 checksum。
2. Factory 创建空的 `demo-product`，再通过 Git Data/Contents API 将
   `templates/monorepo-root` 快照写成
   初始 commit 并建立 `main`。这是建仓 bootstrap，不是 agent 或开发者直接 push。
3. Factory 通过 GitHub API 配置 labels、teams、environments 和初始 ruleset。初始
   ruleset 禁止普通用户直接 push，并要求 PR/approval，但暂不配置 required checks。
4. Factory 创建 Bootstrap PR，写入产品名、owner 映射、`CODEOWNERS` 和仓库级配置。
5. Bootstrap PR 上运行根目录 CI 和 `PR hygiene`，人工批准后合并。
6. 确认 `CI Gate`、`PR hygiene` 的 check context 已真实产生且为绿，再把它们加入
   ruleset 的 required checks。

初始快照写入只负责 Git 内容，不配置 labels、rulesets、branch protection、
environments 或 secrets；这些设置必须由 Factory 另行配置。`template.lock` 必须记录
实际使用的 platform repository、ref、resolved commit、template path 和内容 checksum。

初始结构：

```text
demo-product/
├── specs/_template/
├── contracts/
├── design/tokens/
├── projects.yaml
├── template.lock
├── AGENTS.md
└── .github/
```

初始 `projects.yaml` 不包含预设平台：

```yaml
schema_version: 1
product: demo
repository_mode: monorepo
components: []
```

### 5.3 配置 GitHub

创建 labels：

```text
platform:backend
platform:web
platform:ios
platform:android
track:spec
track:design
track:contract
track:code
type:epic
type:task
type:change
status:blocked
```

配置最终 ruleset：

- 禁止直接 push `main`。
- 要求一个人工 approval。
- 要求 `CI Gate`。
- 要求 `PR hygiene`。
- 要求 review threads resolved。

配置 CODEOWNERS：

```text
/specs/         @product-team
/contracts/     @api-owners
/design/        @design-team
/apps/backend/  @backend-team
/apps/web/      @web-team
/apps/ios/      @ios-team
/apps/android/  @android-team
```

Bootstrap PR 合并后，确认根骨架 CI 为绿，再按 §5.2 的顺序启用 required checks。

## 6. 日常需求操作流程

### 6.1 Intake

所有新需求先创建 Intake Issue，至少包含：

- 问题和目标。
- 用户和场景。
- 明确范围和排除项。
- 平台范围。
- 合规、安全、性能约束。
- 未决问题。

此阶段只创建需求梳理和研究任务，不生成生产实现 backlog。

### 6.2 Spec Gate

Commander 从 Intake 创建 Spec PR：

```text
specs/v1/spec.md
```

Spec 必须包括：

- 稳定 requirement IDs，例如 `REQ-AUTH-001`。
- 功能需求和验收标准。
- 非功能需求。
- In/Out scope。
- 风险和未决问题。

人工批准并合并后，记录批准 commit。后续 architecture/design/plan 都引用该 commit。

### 6.3 Architecture Gate

创建 Architecture PR：

```text
specs/v1/architecture.md
projects.yaml
contracts/openapi.yaml
contracts/events.yaml
```

其中 `architecture.md` 和 `projects.yaml` 属于 Architecture Gate；任何
`contracts/openapi.yaml` 的新增或修改——包括首次引入——同时触发 §8.1 Contract
Gate，不得因为它与 Architecture PR 同时提交而绕过合同检查。一个 PR 同时包含两类
文件时，必须同时通过 Architecture Gate 和 Contract Gate。

确认：

- 组件边界和依赖方向。
- 哪些平台需要生成。
- OpenAPI/event 边界。
- 数据、安全、性能策略。
- 概念领域模型。
- 物理 DB schema 和 migrations 只属于 `apps/backend`。

Architecture Gate 通过后才能生成或调整项目骨架。

### 6.4 Scaffold PR

Factory 根据已批准的 `projects.yaml` 创建 Scaffold PR。

先预览，再生成：

```bash
sdd product scaffold --repo . --projects projects.yaml --dry-run
sdd product scaffold --repo . --projects projects.yaml
```

首次 Scaffold PR 才创建 `apps/backend`、`apps/web`、`apps/ios`、`apps/android` 中
实际获批的目录；未出现在 `projects.yaml` 的平台不得生成。

Scaffold PR 只包含：

- 目录和构建配置。
- 最小可运行应用。
- lint/typecheck/test/build。
- CI wiring。
- 示例测试。

不得提前实现产品功能。

### 6.5 Design Gate

有 UI 时创建 Design PR：

```text
specs/v1/design.md
design/tokens/
```

Figma 页面建议：

```text
00 Foundations
01 User Flows
02 Components
10 iOS
20 Android
30 Web
90 Prototype
```

为页面定义稳定 ID：

```text
SCR-LOGIN
SCR-DASHBOARD
```

Design Gate 检查：

- 主流程、失败流程和边界状态。
- loading/error/empty/offline。
- iOS/Android/Web 平台差异。
- accessibility。
- 设计 token。
- 页面数据与 OpenAPI 是否匹配。

无 UI 项目记录跳过 Design Gate 的原因。

### 6.6 Plan Gate

Commander 创建：

```text
specs/v1/plan.md
```

Plan 描述：

- 技术路径。
- 平台任务边界。
- 合同和 mock 策略。
- 跨平台依赖。
- 测试策略。
- 发布顺序。

`plan.md` 是规划快照，不记录任务状态。

### 6.7 Backlog dry-run

```bash
sdd backlog compile --repo . --version v1 --dry-run
```

Compiler 读取：

```text
spec.md
architecture.md
design.md
plan.md
projects.yaml
contracts/*
```

Dry-run 报告至少包含：

- 将创建、更新或保持不变的 Issue。
- stable task ID。
- 目标平台标签。
- requirement/screen/operation 引用。
- 依赖图和循环依赖检查。
- 预计影响的 CODEOWNERS。

### 6.8 Backlog publish

Plan Gate 通过后：

```bash
sdd backlog publish --repo . --version v1
```

生产环境的 publish 必须由单写者 workflow 执行；本地 CLI 默认只 dry-run 或触发该
workflow。workflow 在仓库维度串行化，禁止两个版本并发写同一组 Issues：

```yaml
concurrency:
  group: sdd-backlog-${{ github.repository }}
  cancel-in-progress: false
```

publish 中途失败后，使用相同 source revision 直接重跑。Compiler 必须先按 stable
task ID marker 查询并 upsert；已完成的写入收敛为 no-op，不得生成重复 Issue。锁负责
避免并发写，upsert 负责失败重试，两者都必须存在。

发布完成后核验：

- 每个 Issue 有一个稳定 marker。
- 没有重复 task ID。
- 每个实现 Issue 引用批准的 spec commit。
- Issues 已加入对应 Project view。
- GitHub Issues 是唯一任务状态来源。

## 7. 实现与 Review

每个 Issue 单独执行：

```text
读取 Issue + 相关 spec/plan/design
  -> 从 main 创建 issue-<n>-<slug>
  -> 先写或扩展测试
  -> 实现
  -> 本地 lint/typecheck/test/build
  -> PR
  -> CI Gate
  -> 独立模型 Review
  -> 人工批准
  -> merge
```

横切功能默认拆成：

```text
Contract PR
Generated client PR
Backend implementation PR
Web implementation PR
iOS implementation PR
Android implementation PR
```

只有必须保持原子性的机械生成变更才放进同一个跨平台 PR。

## 8. Contract-first 操作流程

### 8.1 Contract PR

先修改：

```text
contracts/openapi.yaml
```

Contract Gate 执行：

1. OpenAPI lint。
2. Breaking-change diff。
3. `$ref`、examples、operationId 完整性。
4. 生成 TS/Swift/Kotlin clients。
5. 三类 generated clients 编译和最小测试。

Contract Gate 通过后可以先合并合同，使 backend 和 clients 基于同一合同与 mock 并行开发。

Gate 由 `contracts/openapi.yaml` 的路径变化强制触发，文件新增和修改规则相同。首次
合同可以与 Architecture PR 同时提交，但只有 Architecture Gate 与 Contract Gate
都通过后才能合并。

### 8.2 Backend Implemented Gate

Backend 实现 PR 必须：

1. 启动真实 provider。
2. 使用批准的固定 OpenAPI revision 运行 schema/conformance tests。
3. MVP 使用 Schemathesis 或等效工具。
4. 记录实现的 contract commit。

Provider conformance 失败时 backend 实现不能合并，但不回滚已经批准的合同；应修正实现或通过新的 Contract PR 调整合同。

### 8.3 Breaking change

Breaking API 处理：

```text
保留旧 operation/version
  -> 创建 migration plan
  -> 创建受影响平台 Change Issues
  -> 新旧实现并存
  -> 客户端完成迁移
  -> 删除旧接口单独走 PR/Gate
```

不得在同一个未协调 PR 中直接删除已使用接口。

## 9. CI Gate 操作规则

CI 拓扑：

```text
detect
├── backend
├── web
├── ios
└── android
     ↓
  CI Gate
```

`CI Gate` 使用 `if: always()`，并读取 detector 输出和 `needs.*.result`。

`detect` 是 CI 中始终运行的 job，而不是作者本地操作。它必须：

1. 读取 Git diff，处理明确的路径规则。
2. 发现 `specs/**`、`design/**` 或 `contracts/**` 语义变更时，在 CI 中执行
   `sdd impact --base <base-sha> --head <head-sha> --format json`。
3. 校验 impact JSON schema，并输出 `backend`、`web`、`ios`、`android` 四个布尔值。
4. 将路径规则、impact 结果和 PR 强制标签取并集，作为平台 job 的唯一 detector 输出。

`platform:*` 标签只能把对应输出从 `false` 强制为 `true`，不得用于跳过本应执行的
检查。`sdd impact` 执行失败、输出非法或无法判定时，`detect` 必须失败，不能默认
跳过平台 CI。

判定：

```text
detected=false + skipped -> pass
detected=true  + success -> pass
detected=true  + skipped -> fail
detected=true  + failure -> fail
detected=true  + cancelled -> fail
```

不要把所有 skipped 都视为成功。

路径影响建议：

```text
apps/backend/**      -> backend
apps/web/**          -> web
apps/ios/**          -> ios
apps/android/**      -> android
contracts/**         -> backend + web + ios + android
design/**            -> web + ios + android
specs/**             -> sdd impact 决定，不默认运行所有重型 CI
.github/workflows/** -> 所有 CI 或 workflow validation
```

`specs/**` 的收窄程度取决于当时是否已有 task/Issue 级关联图（§4.4/§6.7 描述的、由
`sdd backlog compile` 建立的图，在 M5 才存在）。该图建立前，`sdd impact` 对无法精确
归因到具体平台的实质性变更，保守地判定为影响全部已声明（且已生成骨架的）平台——
"不默认运行所有重型 CI"在这个阶段的可执行含义是"零内容差异的改动才不触发"，不是
"每条改动都能被精确路由到受影响的那一两个平台"；后者要等 task 图建立后才具备条件。

## 10. Spec / Design / Contract 变更

### 10.1 生成影响报告

```bash
sdd impact --base origin/main --head HEAD
```

报告内容：

- 变更 requirement IDs。
- 变更 screen IDs。
- 变更 OpenAPI operationIds。
- 受影响平台。
- 受影响 Issues。
- Breaking 与否。
- 建议创建的 Change Issues。

### 10.2 同步规则

```text
文档澄清                 -> 不生成平台任务
新增非破坏性 requirement -> 只增加受影响任务
未开始 Issue             -> 提供 update diff
In Progress              -> 新建 Change Issue
Done                     -> 新建 Change/Migration Issue
重复运行相同 revision    -> no-op
```

## 11. 发布操作

各平台独立 tag：

```text
backend-v1.0.0
web-v1.0.0
ios-v1.0.0
android-v1.0.0
```

发布 workflow 必须：

- 验证对应平台 CI。
- 记录 spec 和 contract commit。
- 只读取对应平台 secrets。
- 使用 GitHub environment protection。
- 输出可追踪的 release artifact。

移动端签名材料必须按平台隔离：

- iOS 证书、provisioning profile 和 App Store Connect key 只存在于受保护的
  `ios-release` environment 或外部 secret manager。
- Android keystore、alias 和密码只存在于受保护的 `android-release` environment
  或外部 secret manager。
- workflow 只在对应 release job 中把材料写入临时 keychain/临时文件，并在
  `always()` 清理步骤中删除；不得提交到仓库或上传为普通 artifact。
- 两个平台使用独立审批人与 environment protection；任一平台 job 都不能读取另一
  平台的 secrets。
- Fastlane Match 等证书管理工具可以作为实现选择，但不是本方案的强制依赖。

## 12. 验收场景

系统落地完成前，至少验证以下场景：

1. Template 创建初始 `main` 后，可以通过 Bootstrap PR 产生真实 check context，再启用 required checks。
2. `product init` 只生成控制骨架和空 `components`，不生成 `apps/*`。
3. Architecture Gate 批准平台后，Scaffold PR 只生成获批目录。
4. 根骨架和空 scaffold 的 `CI Gate` 成功。
5. 只改 backend 时，iOS macOS runner 不启动。
6. 首次新增或后续修改 OpenAPI 时，Contract Gate 和四个平台 client checks 都执行。
7. specs-only PR 的 `detect` 使用 `sdd impact` 输出平台矩阵；impact 失败时 CI 失败。
8. 平台 job 意外 skipped 时，`CI Gate` 失败。
9. 同一 backlog 输入发布两次或失败后重跑，不产生重复 Issue。
10. 两个 publish 并发触发时，第二个等待而不是并行写 Issue。
11. 修改未开始任务时只生成可审查 diff。
12. 修改进行中任务时创建 Change Issue。
13. 后端偏离 OpenAPI 时 provider conformance 失败。
14. Breaking API 不会静默覆盖客户端任务。
15. iOS/Android release job 不能读取对方签名 secrets，临时签名材料会被清理。
16. 各平台可以独立 release。

## 13. 故障处理

### CI Gate 一直 pending

检查：

- `CI Gate` 是否 `if: always()`。
- ruleset 要求的 check name 是否完全一致。
- workflow 是否在当前 PR commit 上产生该 check。
- detector 和 platform jobs 是否都包含在 `needs`。

### Compiler 重复创建 Issue

检查：

- Issue 是否包含完整 `sdd-task-id` marker。
- task ID 算法是否使用了不稳定标题或数组下标。
- Compiler 是否先读取全部 open/closed Issues 再创建。
- 多个 publish 是否有 concurrency lock。

### Contract 和 backend 不一致

处理：

- 不手工修改 generated client。
- 确认 backend tests 使用批准的 OpenAPI commit。
- 修正 backend 实现；若合同本身错误，走新的 Contract PR。
- 不通过修改 conformance 测试来掩盖偏差。

### 模板有安全更新

一次性脚手架不直接运行 template update。处理方式：

1. 在模板仓库识别具体安全变更。
2. 为受影响产品生成显式同步 PR。
3. 只包含必要文件和依赖更新。
4. 运行产品完整 CI。
5. 不覆盖产品业务定制。

## 14. 第一版完成定义

满足以下条件才算 MVP 可用：

- 两个仓库均通过 ruleset 和 CI。
- 能从 Intake 生成并批准 Spec。
- 能生成 architecture、design、plan，并在 Architecture Gate 后按获批拓扑生成平台骨架。
- 能 dry-run 和幂等发布平台 Issues。
- 能在 CI 中检测 Spec/OpenAPI 影响，并对任何 OpenAPI 新增或修改执行 Contract Gate。
- 能验证 provider 与 OpenAPI 一致。
- 能按路径运行平台 CI，并稳定上报 `CI Gate`。
- 能完成至少一个纵向功能，从 Issue 到四平台 PR/CI/Review。
- 所有自动化写操作都可 dry-run、审查和追踪。

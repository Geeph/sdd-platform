# SDD 平台实现规划（方案 A / Phase 1）

> 本文是 [single-repo-implementation-runbook.md](single-repo-implementation-runbook.md)
> 的实现规划，描述如何把手册中的 MVP 规格落成可执行的里程碑。本文不承担任务状态；
> 真实进度只存在于 GitHub Issues。落地目标 = 手册 §14「第一版完成定义」，按 §12
> 验收场景验证。

## 0. 技术选型

- **实现语言 / 运行时：Node.js + TypeScript**（手册 §3 在 Node/Python 间留空，此处定为 Node）。
  - Factory、Compiler、CLI 统一用一套 TypeScript toolchain 实现，避免跨语言拼装。
  - GitHub 写操作用 [`octokit`](https://github.com/octokit)（含 Git Data API，用于 §5.2 的快照 bootstrap 与 §4.5 的 Issue upsert）。
  - Schema 校验用 `ajv`，直接消费 `schemas/*.json`。
- 平台仓库本身建议组织成 workspace，包目录对应手册 §4.1：

  ```text
  sdd-platform/
  ├── cli/                # @sdd/cli            sdd 命令入口（建议 oclif 或 commander）
  ├── factory/            # @sdd/factory        建仓 / 配置 / bootstrap（octokit + Git Data API）
  ├── backlog-compiler/   # @sdd/backlog-compiler  strategies + 依赖归并 + Issue upsert
  ├── schemas/            # projects / task / impact JSON Schema + ajv 导出
  ├── templates/          # monorepo-root + 各平台模板
  └── .github/workflows/  # reusable workflows（java / web / ios / android）
  ```

- **不阻塞 M1、后续确认的工具选型**：包管理 / 构建 / 测试（建议 pnpm + tsup + vitest）、
  OpenAPI lint（spectral）、breaking diff（oasdiff）、TS/Swift/Kotlin client 生成器、
  provider conformance（Schemathesis，作为 CI 步骤运行，与实现语言无关）。

## 1. 里程碑

每个里程碑标注：交付物 / 命令、手册依据、解锁的 §12 验收场景。

### M1 — 基础：Schema + 仓库骨架

- 搭起上面的 workspace 骨架。
- 编写 `projects.schema.json`、`task.schema.json`、`impact.schema.json`（§4.2–4.3）。
- 实现 `sdd validate`（ajv 校验 `projects.yaml` / task / impact）。
- 依据：§4.1–4.3。
- 价值：后续所有命令的前置；先把"契约"钉死。

### M2 — Factory：`product init`（只建控制骨架）

- `monorepo-root` 模板：`specs/_template/`、`contracts/`、`design/tokens/`、
  `projects.yaml`（`components: []`）、`template.lock`、`AGENTS.md`、`.github/`。
- `sdd product init --dry-run` → 真建仓：**解析并固定 `sdd-platform` release/commit，
  校验模板 checksum，再用 Git Data/Contents API 把 `monorepo-root` 快照写成初始
  commit 建立 `main`**（按改写后的 §5.2，不走 GitHub Template 功能）。
- 配置 labels / teams / 初始 ruleset；创建 Bootstrap PR；CI 绿后再把 `CI Gate`、
  `PR hygiene` 加入 required checks。
- 依据：§5。
- 验收：12.1、12.2。

### M3 — Scaffold 平台骨架

- 平台模板：`spring-boot` / `web` / `ios-tuist` / `android`，各含最小可运行应用 +
  lint/typecheck/test/build + CI wiring。
- `sdd product scaffold --dry-run` → 真生成；**只生成 `projects.yaml` 中获批的目录**，
  未列出的平台不得生成。
- 依据：§6.4。
- 验收：12.3。

### M4 — CI Gate + detect + impact

- 4 个 reusable workflow（`java/web/ios/android.yml`）。
- `detect` job：路径规则 + 对 `specs/**`、`design/**`、`contracts/**` 语义变更执行
  `sdd impact --format json`，校验 impact schema，输出四平台布尔矩阵。
- `CI Gate`：`if: always()` + 读 `needs.*.result`，实现 §9 的判定真值表
  （`detected=true + skipped/failure/cancelled → fail`，不把所有 skipped 当成功）。
- `sdd impact`（§10）。
- 依据：§9、§10。
- 验收：12.4、12.5、12.7、12.8。

### M5 — Backlog Compiler

- strategies（common/backend/web/ios/android）+ 依赖归并；**稳定 task ID**；重复任务
  与循环依赖检测。
- `sdd backlog compile --dry-run`（§6.7 报告：建/改/不变的 Issue、stable ID、平台标签、
  引用、依赖图）。
- Issue upsert：写入 `sdd-task-id` / `sdd-source-revision` marker，按 §4.5 规则
  create / update-diff / change-issue / no-op。
- `sdd backlog publish` 经**单写者 workflow** 执行，仓库维度 `concurrency` 串行化；
  **锁防并发 + upsert 防重试**，两者都要。
- 依据：§4.4–4.5、§6.7–6.8。
- 验收：12.9、12.10、12.11、12.12。

### M6 — Contract-first

- Contract Gate：OpenAPI lint、breaking-change diff、`$ref`/examples/operationId 完整性、
  生成 TS/Swift/Kotlin client 并编译 + 最小测试（§8.1）。由 `contracts/openapi.yaml`
  路径变化强制触发，新增与修改同规则。
- Backend Implemented Gate：启动真实 provider，用固定 OpenAPI revision 跑 conformance
  （Schemathesis 或等效），记录 contract commit（§8.2）。
- 依据：§8。
- 验收：12.6、12.13、12.14。

### M7 — Release

- 各平台独立 tag（`backend-v* / web-v* / ios-v* / android-v*`）+ release workflow。
- 签名材料隔离：`ios-release` / `android-release` 受保护 environment，独立审批人；
  临时 keychain/文件在 `always()` 清理；任一平台 job 不可读另一平台 secret。
- 依据：§11。
- 验收：12.15、12.16。

### M8 — 纵向切片 + DoD 验收

- 在 demo-product 跑通至少一个功能：Issue → 四平台 PR → CI → 独立 Review → 合并（§7）。
- 过 §12 全部 16 个场景，签 §14。

## 2. 执行策略：先搭"会走路的骨架"

不要把每个里程碑做"完整"再进下一个。先做 **M1→M5 的最薄版本**，把一条
`Issue → PR → CI Gate 绿 → review → merge` 的纵向链路打通（这正是 §14 的核心），
再回头逐个加深各 Gate。否则容易在 M2/M4 过度打磨，迟迟看不到端到端反馈。

## 3. 关键风险（手册中容易做错的点）

- **task ID 必须稳定**（§13）：不能由标题或数组下标推导，否则 Compiler 反复建重复 Issue。
- **锁与 upsert 缺一不可**（§6.8）：lock 防并发写，upsert 防失败重试收敛为 no-op。
- **CI Gate 的 check context 命名**（§13）：ruleset 里 required check 名要与 workflow
  实际产出完全一致，否则永远 pending。
- **bootstrap 机制**（改写后的 §5.2）：用 Git Data API 写快照以支持"固定 revision +
  checksum 锁"，与 GitHub Template 功能不兼容，M2 一开始就按此实现，别走回 Template 功能。
- **签名 secret 隔离**（§11）：release job 互不可读对方 secret，临时材料 `always()` 清理。

## 4. 待决事项

- 包管理 / 构建 / 测试工具链的最终选型（M1 确认；建议 pnpm + tsup + vitest）。
- OpenAPI 工具链（lint / breaking diff / client 生成）的最终选型（M6 前确认）。
- 本仓库 runbook 与 `sdd-agent-starter` 源文件在 bootstrap 机制上的分叉、以及权威归属
  （独立未决项，不阻塞实现）。

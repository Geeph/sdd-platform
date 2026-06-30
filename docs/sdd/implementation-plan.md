# SDD 平台实现规划（方案 A / Phase 1）

> 本文是 [single-repo-implementation-runbook.md](single-repo-implementation-runbook.md)
> 的实现规划，描述如何把手册中的 MVP 规格落成可执行的里程碑。本文不承担任务状态；
> 真实进度只存在于 GitHub Issues。落地目标 = 手册 §14「第一版完成定义」，按 §12
> 验收场景验证。
>
> 本版据评审修正 5 处：新增 Gate 授权溯源机制；M2 加入最小 CI Gate；`sdd impact`
> 分两阶段交付；`sdd sync --check` 补上里程碑并标注优先级；M1 固定包管理/构建/测试工具链。

## 0. 技术选型

- **实现语言 / 运行时：Node.js + TypeScript**（手册 §3 在 Node/Python 间留空，此处定为 Node）。
  - Factory、Compiler、CLI 统一用一套 TypeScript toolchain 实现，避免跨语言拼装。
  - GitHub 写操作用 [`octokit`](https://github.com/octokit)（含 Git Data API，用于 §5.2 的快照 bootstrap 与 §4.5 的 Issue upsert）。
  - Schema 校验用 `ajv`，直接消费 `schemas/*.json`。
- **工具链（M1 固定，保证首个里程碑即可复现）**：包管理 `pnpm`（workspace）、构建
  `tsup`、测试 `vitest`、CLI 框架 `oclif`（多命令更顺手，亦可 `commander`）。
- 平台仓库组织成 pnpm workspace，包目录对应手册 §4.1：

  ```text
  sdd-platform/
  ├── cli/                # @sdd/cli            sdd 命令入口（oclif）
  ├── factory/            # @sdd/factory        建仓 / 配置 / bootstrap（octokit + Git Data API）
  ├── backlog-compiler/   # @sdd/backlog-compiler  strategies + 依赖归并 + Issue upsert
  ├── schemas/            # projects / task / impact JSON Schema + ajv 导出
  ├── templates/          # monorepo-root + 各平台模板
  └── .github/workflows/  # reusable workflows（java / web / ios / android）
  ```

- **后续确认（M6 前定，不阻塞 M1）**：OpenAPI lint（spectral）、breaking diff（oasdiff）、
  TS/Swift/Kotlin client 生成器、provider conformance（Schemathesis，作为 CI 步骤运行，
  与实现语言无关）。

## 1. 贯穿性机制：Gate 授权溯源（approval provenance）

手册只描述了"记录批准 commit"（§6.2）和实现 Issue"引用批准的 spec commit"（§6.8）的
流程，没有定义识别与强制机制。缺这一层，`scaffold` / `publish` 可能消费**未合并的本地
文件**。本机制贯穿 M1–M5：

- **记录**：每个 Gate（Spec / Architecture / Design / Plan）的 PR 经人工 review + 合并后，
  由 gate-merge 自动化把 `{gate, approved_commit（合并 commit SHA）, pr, approved_at}`
  写入产品仓库的 gate 账本（建议 `specs/<version>/gates.yaml`，单写者、可审计）。
- **校验库**（M1 交付，被 scaffold / compile / publish 复用）：
  1. 工作区 clean，且操作对象取自已合并的 `approved_commit`，而非本地未提交/未合并改动；
  2. 被消费的产物（`projects.yaml` / `spec.md` / `plan.md`）确实位于其 Gate 的
     `approved_commit`；
  3. 校验不通过则命令直接失败——与 §14「自动化写操作可审查、可追踪」一致。
- **落点**：机制与校验库在 **M1** 定义；记录写入在 **M2** 接入 gate-merge；强制校验在
  **M3**（scaffold）与 **M5**（compile / publish）。
- 账本的具体形态（账本文件 / git tag / 读 GitHub PR review 状态）见 §5 待决。

## 2. 里程碑

每个里程碑标注：交付物 / 命令、手册依据、解锁的 §12 验收场景。

### M1 — 基础：Schema + workspace + 授权校验库

- 搭起 §0 的 pnpm workspace 骨架，**固定 pnpm + tsup + vitest**（首个里程碑即可复现）。
- 编写 `projects.schema.json`、`task.schema.json`、`impact.schema.json`（§4.2–4.3）。
- 实现 `sdd validate`（ajv 校验 `projects.yaml` / task / impact）。
- 实现 §1 的**授权溯源校验库**，供 M3 / M5 复用。
- 依据：§4.1–4.3、§6.2。
- 价值：后续所有命令的前置；先把"契约"与"授权校验"钉死。

### M2 — Factory：`product init`（控制骨架 + 最小 CI Gate）

- `monorepo-root` 模板：`specs/_template/`、`contracts/`、`design/tokens/`、
  `projects.yaml`（`components: []`）、`template.lock`、`AGENTS.md`、`.github/`。
- `sdd product init --dry-run` → 真建仓：**解析并固定 `sdd-platform` release/commit，
  校验模板 checksum，再用 Git Data/Contents API 把 `monorepo-root` 快照写成初始
  commit 建立 `main`**（按改写后的 §5.2，不走 GitHub Template 功能）。
- 配置 labels / teams / 初始 ruleset；创建 Bootstrap PR。
- **最小 root / no-op CI Gate + PR hygiene**：Bootstrap PR 必须产生真实的 `CI Gate`、
  `PR hygiene` check context，绿后才把它们加入 required checks（§5.2、§12.1）。此版只
  聚合根骨架，**平台矩阵留到 M4 扩展**。
- 接入 gate-merge：把 Gate 批准 commit 写入 gate 账本（§1 记录）。
- 依据：§5。
- 验收：12.1、12.2、12.4（根骨架 CI Gate 绿）。

### M3 — Scaffold 平台骨架（含授权校验）

- 平台模板：`spring-boot` / `web` / `ios-tuist` / `android`，各含最小可运行应用 +
  lint/typecheck/test/build + CI wiring。
- `sdd product scaffold --dry-run` → 真生成；**只生成 `projects.yaml` 中获批的目录**，
  未列出的平台不得生成。
- **强制授权校验**（§1）：只对**已批准、已合并**的 `projects.yaml` 的 `approved_commit`
  执行；工作区脏或本地未合并则拒绝。
- 依据：§6.3–6.4、§6.2。
- 验收：12.3。

### M4 — CI Gate 平台矩阵 + detect + impact（平台矩阵）

- 4 个 reusable workflow（`java/web/ios/android.yml`）。
- `detect` job：路径规则 + 对 `specs/**`、`design/**`、`contracts/**` 语义变更执行
  `sdd impact --format json`，校验 impact schema，输出四平台布尔矩阵。
- 把 M2 的最小 CI Gate **扩展为平台矩阵聚合**：`if: always()` + 读 `needs.*.result`，
  实现 §9 判定真值表（`detected=true + skipped/failure/cancelled → fail`，不把所有
  skipped 当成功）。
- **`sdd impact` 本里程碑只交付平台影响矩阵**：变更的 requirement/screen/operationId +
  受影响平台布尔（足够喂 detect / §9）。"受影响 Issues / 建议的 Change Issues"依赖
  stable task ID 与 marker，**移到 M5**。
- 依据：§9、§10.1（部分）。
- 验收：12.4、12.5、12.7、12.8。

### M5 — Backlog Compiler（+ impact 的 Issue 归并 + 授权校验）

- strategies（common/backend/web/ios/android）+ 依赖归并；**稳定 task ID**；重复任务
  与循环依赖检测。
- `sdd backlog compile --dry-run`（§6.7 报告：建/改/不变的 Issue、stable ID、平台标签、
  引用、依赖图）。
- Issue upsert：写入 `sdd-task-id` / `sdd-source-revision` marker，按 §4.5 规则
  create / update-diff / change-issue / no-op。
- `sdd backlog publish` 经**单写者 workflow** 执行，仓库维度 `concurrency` 串行化；
  **锁防并发 + upsert 防重试**，两者都要。
- **扩展 `sdd impact`**：基于 stable task ID 与 Issue marker，补"受影响 Issues / 建议
  Change Issues"，完整化 §10.1 并实现 §10.2 同步规则。
- **强制授权校验**（§1）：发布的实现 Issue 引用批准的 spec commit（§6.8）；对未批准/
  本地态拒绝。
- 依据：§4.4–4.5、§6.7–6.8、§10。
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

### M8 — `sdd sync --check`（漂移报告，只读）— 非关键路径

- 只读检测产品仓库与平台之间的漂移：模板（经 `template.lock`）、reusable workflows、
  共享文件（AGENTS、安全规则），输出需要的**显式同步 PR** 清单；**不自动覆盖**
  （§4.6、§13）。
- 依赖 `template.lock`（M2）与平台模板（M3）；技术上 M3 之后任意时点可做。
- **不在 §14 关键路径，§12 未覆盖**：当前定为 Phase 1 末位、低优先；若资源紧张可延后，
  但延后须显式记为"移出 Phase 1"，不能像之前那样悬空。
- 依据：§2、§4.6、§13。

### M9 — 纵向切片 + DoD 验收

- 在 demo-product 跑通至少一个功能：Issue → 四平台 PR → CI → 独立 Review → 合并（§7）。
- 过 §12 全部 16 个场景，签 §14。

## 3. 执行策略：先搭"会走路的骨架"

不要把每个里程碑做"完整"再进下一个。先做 **M1→M5 的最薄版本**，把一条
`Issue → PR → CI Gate 绿 → review → merge` 的纵向链路打通（这正是 §14 的核心），
再回头逐个加深各 Gate。M1 的授权校验库与 M2 的最小 CI Gate 都是这副骨架的必备件，
不能省。否则容易在 M2/M4 过度打磨，迟迟看不到端到端反馈。

## 4. 关键风险（手册中容易做错的点）

- **授权校验要校验"合并态"而非"文件存在"**（§1、§6.2）：只检查文件存在等于没校验，
  必须把产物绑定到 Gate 的 `approved_commit` 并拒绝本地未合并改动。
- **task ID 必须稳定**（§13）：不能由标题或数组下标推导，否则 Compiler 反复建重复 Issue。
- **锁与 upsert 缺一不可**（§6.8）：lock 防并发写，upsert 防失败重试收敛为 no-op。
- **CI Gate 的 check context 命名**（§13）：ruleset 里 required check 名要与 workflow
  实际产出完全一致，否则永远 pending。M2 的最小 Gate 与 M4 的矩阵 Gate 必须用同一个
  check 名，避免启用 required checks 后断档。
- **bootstrap 机制**（改写后的 §5.2）：用 Git Data API 写快照以支持"固定 revision +
  checksum 锁"，与 GitHub Template 功能不兼容，M2 一开始就按此实现，别走回 Template 功能。
- **签名 secret 隔离**（§11）：release job 互不可读对方 secret，临时材料 `always()` 清理。

## 5. 待决事项

- Gate 授权账本的具体形态：账本文件（`specs/<version>/gates.yaml`）/ git tag / 读
  GitHub PR review 状态。建议账本文件为主，必要时叠加 API 校验（M1 前定）。
- OpenAPI 工具链（lint / breaking diff / client 生成）的最终选型（M6 前确认）。
- 本仓库 runbook 与 `sdd-agent-starter` 源文件在 bootstrap 机制上的分叉、以及权威归属
  （独立未决项，不阻塞实现）。

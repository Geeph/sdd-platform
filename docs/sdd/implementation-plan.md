# SDD 平台实现规划（方案 A / Phase 1）

> 本文是 [single-repo-implementation-runbook.md](single-repo-implementation-runbook.md)
> 的实现规划，描述如何把手册中的 MVP 规格落成可执行的里程碑。本文不承担任务状态；
> 真实进度只存在于 GitHub Issues。落地目标 = 手册 §14「第一版完成定义」，按 §12
> 验收场景验证。
>
> 本版据评审修正：新增 Gate 授权溯源机制；M2 加入最小 CI Gate 和 SDD 产物模板；
> `sdd impact` 分两阶段交付；限定 `sdd sync --check` 的托管范围；M1 固定完整工具链。
> 二轮修正：provenance 要求文件在 Gate PR 的 changed files 中、且按明确 PR/merge SHA 定位；
> M5 publish 校验完整输入集；拆出 M4.5 Contract Gate（先于 backlog），M6 专做 provider conformance。

## 0. 技术选型

- **实现语言 / 运行时：Node.js + TypeScript**（手册 §3 在 Node/Python 间留空，此处定为 Node）。
  - Factory、Compiler、CLI 统一用一套 TypeScript toolchain 实现，避免跨语言拼装。
  - GitHub 写操作用 [`octokit`](https://github.com/octokit)（含 Git Data API，用于 §5.2 的快照 bootstrap 与 §4.5 的 Issue upsert）。
  - Schema 校验用 `ajv`，直接消费 `schemas/*.json`。
- **工具链（M1 固定，保证首个里程碑即可复现）**：包管理 `pnpm`（workspace）、构建
  `tsup`、测试 `vitest`、CLI 框架 `oclif`。
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

- **后续确认（不阻塞 M1）**：OpenAPI lint（spectral）、breaking diff（oasdiff）和
  TS/Swift/Kotlin client 生成器在 **M4.5 前**确定；provider conformance（Schemathesis，
  作为 CI 步骤运行，与实现语言无关）在 **M6 前**确定。

## 1. 贯穿性机制：Gate 授权溯源（approval provenance）

手册只描述了"记录批准 commit"（§6.2）和实现 Issue"引用批准的 spec commit"（§6.8）的
流程，没有定义识别与强制机制。缺这一层，`scaffold` / `publish` 可能消费**未合并的本地
文件**。本机制贯穿 M1–M5：

- **权威来源**：GitHub 上合入受保护 `main` 的 Gate PR 及其 review/merge 元数据是唯一
  授权事实来源，不在仓库内维护一个可由后续 commit 改写的自证账本。Gate PR 使用
  `gate:spec` / `gate:architecture` / `gate:design` / `gate:plan` / `gate:contract` 标签和版本
  标识；ruleset 开启 stale review dismissal，并要求对应 CODEOWNER 批准，确保批准绑定最终
  head SHA。
- **批准记录**：记录 `{gate, version, pr, approved_head_sha, merge_commit_sha, approved_at,
  authorization_policy, required_checks}`；CLI 运行时从 GitHub API 读取并验证。当前采用
  `current-codeowners` 可撤销授权策略：执行 scaffold/publish 时重新确认用户或同组织可见团队
  仍具有仓库 write 权限；成员或权限被移除会立即撤销后续写操作授权。Contract Gate 额外要求
  `required_checks` 包含同一 `approved_head_sha` 上成功的 `Contract Gate` check。生成的
  dry-run、Issue marker 和审计报告保存这组不可混淆的 provenance，而不是信任工作区里的
  声明文件。
- **校验库**（M1 交付，被 scaffold / compile / publish 复用；目标 Gate 由**明确的 PR 号或
  merge SHA** 指定，label 只作辅助一致性核对、不用于定位）：
  1. 该 PR 已合入预期仓库的受保护 `main`，最终 head SHA 获所需 CODEOWNER 批准；
  2. **被消费产物确实由该 PR 审批**：`artifactPath` 必须在该 PR 的 changed files 中（相对
     base 为 added/modified），不能只是 merge tree 继承的历史文件；
  3. 工作区 clean，且本地产物的 Git blob 与该 PR head/merge 版本的同路径 blob 一致；
  4. 当 `gate=contract` 时，`Contract Gate` check 必须在该 PR 最终 head SHA 上成功；旧
     commit、缺失、skipped、failure 或 cancelled 均不算通过；
  5. 后续 Gate 沿用的产物必须能追溯到相应 Gate 的批准记录；
  6. GitHub API 不可用、证据不完整或校验失败时，任何写操作 fail closed。
- **落点**：机制与校验库在 **M1** 定义；Gate labels、CODEOWNERS、ruleset 和 PR hygiene 在
  **M2** 配置；强制校验在 **M3**（scaffold）与 **M5**（publish）。`compile --dry-run`
  可用于 Gate 评审，但必须醒目标注未批准输入，且不得产生 GitHub 写操作。

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
- `specs/_template/` 提供 `spec.md`、`architecture.md`、`design.md`、`plan.md` 模板；
  `.github/` 提供 Intake Issue Form、Gate PR template 与 CODEOWNERS 映射，Factory 配置
  Gate labels。
  Commander 或人工从这些版本化模板创建 Intake 和各 Gate PR；模板明确稳定 requirement /
  screen / operation ID、上游批准 commit 引用、跳过 Design Gate 的理由等必填字段。
- `sdd product init --dry-run` → 真建仓：**解析并固定 `sdd-platform` release/commit，
  校验模板 checksum，再用 Git Data/Contents API 把 `monorepo-root` 快照写成初始
  commit 建立 `main`**（按改写后的 §5.2，不走 GitHub Template 功能）。
- 配置 labels / teams / 初始 ruleset；创建 Bootstrap PR。
- **最小 root / no-op CI Gate + PR hygiene**：Bootstrap PR 必须产生真实的 `CI Gate`、
  `PR hygiene` check context，绿后才把它们加入 required checks（§5.2、§12.1）。此版只
  聚合根骨架，**平台矩阵留到 M4 扩展**。PR hygiene 同时校验 Gate 类型/版本、必需产物、
  稳定 ID、上游批准引用和对应 CODEOWNER；合并后的授权状态由 §1 的 GitHub 元数据判定。
- 依据：§5。
- 验收：12.1、12.2、12.4（根骨架 CI Gate 绿）。

### M3 — Scaffold 平台骨架（含授权校验）

- 平台模板：`spring-boot` / `web` / `ios-tuist` / `android`，各含最小可运行应用 +
  lint/typecheck/test/build + CI wiring。
- `sdd product scaffold --dry-run` → 真生成；**只生成 `projects.yaml` 中获批的目录**，
  未列出的平台不得生成。
- **强制授权校验**（§1）：只对**已批准、已合并**的 `projects.yaml` 执行；其 Git blob
  必须与 Architecture Gate 的 `merge_commit_sha` 一致，工作区脏或本地未合并则拒绝。
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
- **M4 阶段没有 task/Issue 级关联图（M5 才建立），`specs/**` 的平台归因因此是保守的**：
  对 `specs/**`/`design/**`/`architecture.md`/`plan.md` 里任何无法精确归因到具体平台的
  实质性变更，`sdd impact` 判定为影响全部已声明（且已 scaffold）的平台，不追求逐条精确
  narrowing——§9"不默认运行所有重型 CI"在 M4 阶段的可执行含义是"零内容差异才不跑，任何
  实质编辑保守全跑"，精确到平台的收窄是 M5 建立 task 图之后的能力，不是本里程碑的范围。
- 依据：§9、§10.1（部分）。
- 验收：12.4、12.5、12.7、12.8。

### M4.5 — Contract Gate（合同先行，先于 backlog）

- Contract Gate：OpenAPI lint、breaking-change diff、`$ref`/examples/operationId 完整性、
  生成 TS/Swift/Kotlin client 并编译 + 最小测试（§8.1）。由 `contracts/openapi.yaml`
  路径变化强制触发，新增与修改同规则。
- M4 detector 增加 `contract_changed` 输出；变化时运行稳定命名的 `Contract Gate` job，
  M4 的 `CI Gate` 将其纳入聚合。`contract_changed=true` 时，Contract Gate 为 skipped / failure /
  cancelled 或没有在当前 head SHA 产生结果，`CI Gate` 必须失败；无合同变化时才允许 skipped。
- **次序关键**：OpenAPI 在 Architecture 阶段就产生（§6.3），M5 会据合同编译/发布任务，
  所以合同必须在 backlog 之前通过本 Gate；M5 publish 也必须校验 contracts 来自已通过的
  Contract Gate，包括当前批准 head SHA 上成功的 check evidence。
- 依赖 M4 的 CI 装配。
- 依据：§6.3、§8.1。
- 验收：12.6、12.14（breaking 检测；配合 M5 的 change issue 实现"不静默覆盖客户端任务"）。

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
- **强制授权校验**（§1，校验完整输入集）：Compiler 读取 spec / architecture / design /
  plan / projects / contracts（§6.7），publish 前必须逐项校验各来自对应已通过 Gate——
  spec→Spec、architecture+projects→Architecture、design→Design（或有据可查的跳过证据，
  §6.5）、plan→Plan、contracts→Contract Gate（M4.5）；任一未批准 / 本地态即拒绝发布。
  每个实现 Issue 记录其引用的批准 provenance（§6.8）。
- 依据：§4.4–4.5、§6.7–6.8、§10。
- 验收：12.9、12.10、12.11、12.12。

### M6 — Backend Implemented Gate（provider conformance）

- 启动真实 provider，用固定 OpenAPI revision 跑 conformance（Schemathesis 或等效），
  记录实现的 contract commit（§8.2）。conformance 失败不回滚已批准合同，应修正实现或走
  新的 Contract PR。
- 依据：§8.2。
- 验收：12.13。

### M7 — Release

- 各平台独立 tag（`backend-v* / web-v* / ios-v* / android-v*`）+ release workflow。
- 签名材料隔离：`ios-release` / `android-release` 受保护 environment，独立审批人；
  临时 keychain/文件在 `always()` 清理；任一平台 job 不可读另一平台 secret。
- 依据：§11。
- 验收：12.15、12.16。

### M8 — `sdd sync --check`（漂移报告，只读）— 非关键路径

- 只读检测**平台持续托管的表面**：reusable workflow 固定 revision、AGENTS/安全规则等
  明确登记的共享文件，以及平台发布的定向安全更新；输出需要的**显式同步 PR**清单，
  **不自动覆盖**（§4.6、§13）。
- `template.lock` 只用于审计生成来源和判断某项定向安全更新是否适用；不得把一次性生成的
  `apps/*` 与当前模板做通用 diff，也不得把正常业务修改报告为漂移。
- 依赖 `template.lock`（M2）与平台模板（M3）；技术上 M3 之后任意时点可做。
- **不在 §14 关键路径，§12 未覆盖**：当前定为 Phase 1 末位、低优先；若资源紧张可延后，
  但延后须显式记为"移出 Phase 1"，不能像之前那样悬空。
- 依据：§2、§4.6、§13。

### M9 — 纵向切片 + DoD 验收

- 使用 M2 的 Intake/Gate 模板跑通 Intake → Spec → Architecture → Design（或有据可查地
  跳过）→ Plan，并核验每个批准记录都能由 §1 的校验库复算。
- 在 demo-product 跑通至少一个功能：Issue → 四平台 PR → CI → 独立 Review → 合并（§7）。
- 过 §12 全部 16 个场景，签 §14。

## 3. 执行策略：先搭"会走路的骨架"

不要把每个里程碑做"完整"再进下一个。先做 **M1→M5 的最薄版本**，把一条
`Issue → PR → CI Gate 绿 → review → merge` 的纵向链路打通（这正是 §14 的核心），
再回头逐个加深各 Gate。M1 的授权校验库与 M2 的最小 CI Gate 都是这副骨架的必备件，
不能省。否则容易在 M2/M4 过度打磨，迟迟看不到端到端反馈。

## 4. 关键风险（手册中容易做错的点）

- **授权校验要校验"合并态 + 实际审批"而非"文件存在"**（§1、§6.2）：除本地 blob 等于
  Gate PR 版本外，`artifactPath` 还必须在该 PR 的 changed files 中——否则任意后续 Gate PR
  都"包含"它却从未审批它。
- **task ID 必须稳定**（§13）：不能由标题或数组下标推导，否则 Compiler 反复建重复 Issue。
- **锁与 upsert 缺一不可**（§6.8）：lock 防并发写，upsert 防失败重试收敛为 no-op。
- **CI Gate 的 check context 命名**（§13）：ruleset 里 required check 名要与 workflow
  实际产出完全一致，否则永远 pending。M2 的最小 Gate 与 M4 的矩阵 Gate 必须用同一个
  check 名，避免启用 required checks 后断档。
- **bootstrap 机制**（改写后的 §5.2）：用 Git Data API 写快照以支持"固定 revision +
  checksum 锁"，与 GitHub Template 功能不兼容，M2 一开始就按此实现，别走回 Template 功能。
- **签名 secret 隔离**（§11）：release job 互不可读对方 secret，临时材料 `always()` 清理。

## 5. 待决事项

- OpenAPI 工具链（lint / breaking diff / client 生成）的最终选型（M4.5 前确认）；provider
  conformance 工具在 M6 前确认。
- 本仓库 runbook 与 `sdd-agent-starter` 源文件在 bootstrap 机制上的分叉、以及权威归属
  （独立未决项，不阻塞实现）。

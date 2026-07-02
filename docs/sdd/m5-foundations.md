# M5 实施细案：Backlog Compiler（+ impact 的 Issue 归并 + 强制授权校验）

> 本文是 [implementation-plan.md](implementation-plan.md) 中 **M5** 里程碑的文件级实施方案，
> 评审通过后据此交 Codex 实现。M5 完成 = `@sdd/backlog-compiler`（M1 占位包）补全为真实
> 实现：strategies（common/backend/web/ios/android）+ 依赖归并产出**稳定 task ID** 的任务集；
> `sdd backlog compile` 产出确定性 dry-run 报告（§6.7 全部条目）；`sdd backlog publish` 经
> **平台仓托管的单写者 workflow** 幂等地 upsert 产品仓 Issues（锁防并发 + upsert 防重试，
> 缺一不可）；publish 前对**完整输入集**逐项强制 `verifyGateApproval`（spec→Spec、
> architecture+projects→Architecture、design→Design 或有据可查的跳过、plan→Plan、
> contracts→Contract Gate）；`sdd impact --with-issues` 填充 M4 留空的
> `affected_issues` / `suggested_change_issues` 并实现 §10.2 同步规则。
>
> 依据手册（[single-repo-implementation-runbook.md](single-repo-implementation-runbook.md)）
> §4.3（task schema）、§4.4（Compiler 五条）、§4.5（Issue upsert 规则）、§6.7（dry-run 报告
> 条目）、§6.8（publish：单写者 workflow / concurrency / 锁与 upsert / 发布后核验清单）、
> §7（实现拆分与依赖方向）、§10.1–10.2（影响报告与同步规则）、§13（"Compiler 重复创建
> Issue"排障清单——本文把清单里每一条都变成设计约束）、§12.9–12.12、§12.14（后半）；
> implementation-plan §M5、§1（M5 是继 M3 之后第二个强制授权点）、§3（先搭会走路的骨架——
> strategies 的粒度按 MVP 骨架取舍，见 §2）。格式与自查方式对齐
> [m1-foundations.md](m1-foundations.md) / [m2-foundations.md](m2-foundations.md) /
> m3-foundations.md（分支 `m3-foundations`）/ [m4-foundations.md](m4-foundations.md) /
> [m4.5-foundations.md](m4.5-foundations.md)：publish 全是幂等/并发/重放高发区，每条机制
> 都过一遍"重放 / TOCTOU / 相似字段分道扬镳 / 崩溃恢复 / 仅按 name 防伪"清单，自查结论
> 内联在各节。
>
> **时序拍板记录（2026-07-01，用户确认）**：M4.5 先于 M5 规划；两份方案同批产出（本文与
> m4.5-foundations.md），**实现顺序钉死为 M3 → M4 → M4.5 → M5**。M5 的 contracts 校验消费
> M4.5 交付的 `Contract Gate` check evidence（M1 provenance `gate='contract'` 路径已实现并
> 合入 main，check 名 `Contract Gate` 硬编码）；**M4.5 实现落地之前，任何含 contracts 的
> publish 在本文 §5.4 的校验处自然 fail closed**（找不到成功的 Contract Gate evidence），
> 无合同的产品不受影响——该空窗是设计内行为。M4.5 之前经 Architecture PR 合入的遗留合同，
> 按 m4.5 §6.3 第 5 条走一次 re-affirming Contract PR 收敛，M5 不为其开任何后门。
>
> **依赖状态说明（实机核对 `main`@`8ce0cf4`，2026-07-01；开工实现前须以届时 main 重核）**：
> - **M1 + M2 代码已合并**（PR #2 / #4）。已实机核对：`schemas/task.schema.json`（id pattern
>   `^[a-z0-9]+(\.[a-z0-9-]+)+$`、platform/track enum、references.{requirements,screens,
>   operations}、depends_on）与 `schemas/impact.schema.json`（`affected_issues[]` item =
>   `{task_id, issue≥1, change:'update'|'change'|'migration'}`、`suggested_change_issues[]`
>   item = `{task_id, platform, kind:'change'|'migration', reason}`，两者必填齐全）——
>   **本文是纯填充方，两份 schema 均不改动**；`@sdd/provenance` 的 `verifyGateApproval`
>   （`ApprovalRef` 按明确 PR 号 / merge SHA、`GitReader` 四方法接口、`Provenance` 含
>   `required_checks`）；`backlog-compiler/` 为 M1 占位包（仅导出 `M1_PLACEHOLDER`）。
> - **M3 方案定稿于分支 `m3-foundations`，代码实现中未合并**。本文引用 M3 的只有：
>   `createLocalGitReader`（`GitReader` 首个真实实现，本文 §5.3 在 checkout 出的产品仓
>   副本上复用）、退出码惯例（新增 `7`=授权校验未通过）、D7 的 dry-run/真实执行
>   fail-closed 边界——均为其文档契约。m3 §9.1 的 4 处 M1/M2 先行补丁中，**#3（gate label
>   存在性）是本文强制授权校验的直接前置**（缺它时"任何 CODEOWNER 批准过该文件的 PR"都能
>   冒充 Gate 批准，五路校验全部弱化），实机核对仍未合并，列入 §11.1。
> - **M4 方案已合并（PR #5），代码未实现**。本文引用其外部契约：`computeImpact` /
>   `ImpactReader` / `ChangedPath(previousPath)` / `changedPaths` 注入参数（m4 D22）、
>   D20 第 4 稿的三个 artifact-specific semantic diff（REQ canonical heading / SCR canonical
>   屏幕清单 / OpenAPI operation object——本文 §1/§2 的任务源提取**复用同一套 extractor**，
>   不再发明第二套解析）、`detect` 不消费 `affected_issues`/`suggested_change_issues`
>   （m4 §5.3 已钉死）、`MinimalOctokit`/`fetchPullRequest`/`fetchChangedFiles`（D16/D22）。
> - **M4.5 方案已完成本轮评审修订**（[m4.5-foundations.md](m4.5-foundations.md)）。
>   本文消费其两条输出契约（m4.5 §6.3）：evidence 链（合并的合同 ⇒ approved head SHA 上
>   存在可反查到 organization ruleset pin 的平台 workflow identity、且最新受信 attempt 为
>   success 的 `Contract Gate` check）与唯一溯源不变量（main 上每个
>   openapi.yaml blob ↔ 恰一个 `gate:contract` PR）。**m4.5 评审若变更这两条，本文 §5.4
>   的 contracts 分支需同步复核**——这是两份文档同批评审的原因。

## 0. 已定决策

沿用 M1–M4.5 已定且不再论证的约定：Node 24 LTS + TS strict、pnpm/tsup/vitest/oclif/biome、
provenance 只认 GitHub PR/merge 元数据且按明确 PR 号 / merge SHA 定位、fail closed、不建
仓内账本、gate check 由平台仓集中托管、M2 D12 dry-run 确定性（canonical JSON /
operation_id / byte-identical / 零 mutation / text 只是 renderer）、M3 D21"路径只认
path"、M4 D18/D25 的 existing 语义、M4 D20 semantic diff、M4 D22 计数校验、CLI 双层模式。
M5 新增决策：

- **D1 — 一句话架构**：`compile` 是**纯函数**（六类输入 → 任务集 + 计划），`publish` 是
  "授权校验 → 读全量 Issue 索引 → 按 §10.2 分类 → 逐条 upsert → 发布后核验"的**幂等
  收敛循环**，与 M2 `init` / M3 `scaffold` 同一哲学：phase 由 GitHub 实际状态推导、无本地
  checkpoint、失败同输入重跑收敛、默认不删除任何东西。业务逻辑全部落在
  `@sdd/backlog-compiler`；CLI 与 workflow 只是壳。
- **D2 — `source_revision` 精确定义：产品仓 `main` 上的一个完整 40-hex commit SHA，
  publish 的全部输入（六类文件）都从这个 commit 读取**；create 或任务内容 update 时把它
  写入 Issue 的 `sdd-source-revision`，既有 Issue no-op/refresh-metadata 时按 D10 保留
  “最后一次任务内容变化 revision”的语义。约束：
  1. 由触发方显式传入（CLI 默认解析"当前远端 main HEAD"为 40-hex 后传入；workflow input
     必须已是 40-hex，不接受可移动 ref——同 M3 D19 对 `template_ref` 的理由）；
  2. **执行时三次新鲜度校验（M3 D18 的 publish 版）**：单写者 workflow 在授权校验之前、
     首个 Issue 写之前、发布后核验末尾各读一次产品仓 main 当前 HEAD，要求
     `source_revision == main HEAD`；不等 → fail closed
     （退出码 7），提示"main 已前进，请对当前 HEAD 重新触发"。这挡住的重放场景：拿一个
     **曾经合法但已被后续 Gate 取代**的旧 revision 发布，把 Issues 回退到旧内容——
     provenance 只能证明"该 revision 曾被批准"，证明不了"它仍是现行版本"，两个校验缺一
     不可（与 scaffold 的 D18 完全同构）。排队等待期间 main 前进导致的失败是设计内行为：
     操作者对新 HEAD 重新触发即可，publish 幂等。首写前失配保证零任务写；若 main 恰在
     写入期间前进，末次 guard 令本 run 失败而不是把陈旧状态报告为成功，已写前缀由针对
     新 HEAD 的下一次 publish 收敛。
  3. **不是**工作区状态、不是 Plan Gate 的 merge SHA（合同 PR 可能晚于 Plan Gate 合并，
     用任何单个 Gate 的 merge SHA 都会漏掉之后合法合入的其它已批准产物；用"当前 main
     HEAD + 逐产物 blob 回溯批准"才对任意合并顺序都成立，见 §5.4）。
- **D3 — 稳定 task ID：`<platform>.<kind>.<source-slug>` 三段、版本无关、只从模板强制的
  稳定源 ID 派生**（§1 详述算法与四个任务族）。要点先行：segment 2 是**封闭的 kind 集合**
  `{contract, api, screen, req}`，它把三个源命名空间（operationId / SCR-* / REQ-*）硬隔离，
  杜绝跨族碰撞；ID 里**没有 spec 版本号**——v1→v2 时 REQ/SCR/operationId 不变的任务算出
  **同一个 ID**，§10.2 的 update/change 判定因此"认得出同一个任务"（ID 含版本的话，换版
  即全量新建 Issue，正是 §13 点名的事故形态）；**任何段都不来自标题或数组下标**（§4.4/§13）。
- **D4 — 重复检测的精确定义**：全部 strategies 输出汇总后，**最终 ID 全局唯一性检查**——
  两个不同源（如 operationId `loginUser` 与 `login_user` slug 化后同为 `login-user`）产出
  同一 ID → **硬失败**（退出码 3，报告列出冲突双方的源 ID 与位置），绝不静默去重或加
  序号后缀（后缀随集合变化漂移，等于重新引入下标依赖）。同一源在同一 strategy 内天然
  只产出一次（按源 ID 遍历），所以任何冲突都意味着"源 ID 经 slug 化后失去区分度"，
  必须人工改源 ID（operationId/SCR 命名）解决——这是把 §13 的"重复 Issue"消灭在编译期。
- **D5 — 循环依赖检测的精确定义**：任务集构成有向图（边 = task → 其 `depends_on` 每一
  项）。归并 pass 做两件事，任一失败即整体失败（退出码 3）：
  1. **悬空引用**：`depends_on` 目标必须存在于本次编译输出集合内（MVP 的 depends_on 只
     指向同批任务，见 §2）；不存在 → 报"dangling dependency"。
  2. **环检测**：对全图跑 Kahn 拓扑排序，无法排空 → 存在环，DFS 找出至少一条具体环路
     完整打印（`a → b → c → a`），不是只报"有环"。自环（task 依赖自己）是长度 1 的环，
     同规则覆盖。
  MVP 的四个任务族按构造无环（依赖方向恒为 * → contract，见 §2.3），检测仍无条件执行
  （§4.4 是对 Compiler 的要求，不是对当前任务族形状的要求；未来族形状变化时这是安全网）。
- **D6 — 任务生成覆盖"declared 的全部平台"，不做 M4 式 existing 收窄**：M4 的
  `existing`（declared 且目录已 scaffold）门控的是"**跑不跑 CI**"——对不存在的目录跑构建
  没有意义；backlog 的问题相反：任务本来就是"去实现"，Architecture Gate 批准了平台、
  scaffold 尚未落地时，实现任务恰恰应该已经存在（scaffold 本身也是要排期的工作）。与
  §12.3 的时序关系：publish 不要求 scaffold 已完成；未 scaffold 平台的实现 PR 自然要等
  Scaffold PR 先合并（M3 负责），Issue 先于目录存在没有任何一致性代价。**平台词表换名点
  显式重申**（m4 §2.3 点名过的易错处）：任务的 `platform` 用 `{backend,web,ios,android}`
  词表，由 `projects.yaml` 的 `ci` 值映射（`java→backend`，其余同名）；`common` 不对应
  任何 component，是合同/跨端工作的归属（D7）。
- **D7 — `platform:'common'` 任务的 Issue 归属与 label**：common 任务（MVP 只有 contract
  族）发布为**同一产品仓的普通 Issue**，打 `platform:common` label——该 label 不在 M2 的
  初始 label 集合里（§5.3 只有四平台），**M5 把 publish 的第一步定为"确保本次要用的
  label 全部存在"**（create-if-missing，含 `platform:common`；调色/描述沿用 M2 的
  desired-state 风格，**只增不删、不动未知 label**）。不单独建"contract 仓"或用
  assignee/milestone 模拟归属——手册的模型是单产品 monorepo 单 Issue 池，view 层的切分
  交给 label（§12 Projects 边界见 D22）。
- **D8 — Issue 状态模型（手册缺口的补齐，§10.2 每一行的可执行前提）**：GitHub 原生只有
  open/closed，本文定义**从 GitHub 原生事实确定性推导**的四态：

  | 推导态 | 判定（按顺序第一条命中） | §10.2 对应行 |
  |---|---|---|
  | `done` | issue `state=closed` 且 `state_reason=completed`（或历史 issue 无 reason） | "已完成" |
  | `cancelled` | `state=closed` 且 `state_reason=not_planned` | 手册未列；按"已完成"行处理（内容变化 → Change/Migration Issue，reason 注明原任务已取消），**不重开、不更新原 Issue** |
  | `in_progress` | `state=open` 且（assignees 非空 **或** timeline 存在来自同仓库的 PR cross-reference） | "In Progress" |
  | `not_started` | `state=open` 且以上皆无 | "未开始" |

  - **方向性自查**：误判的两个方向代价不对称——把 in_progress 误判成 not_started 会在
    实现者背后**静默改写任务内容**（最坏方向）；把 not_started 误判成 in_progress 只是
    多开一个 Change Issue（噪音）。因此 in_progress 的信号取**并集**（assignee 或
    linked PR 任一即算），宁可过检不可漏检。
  - **防伪定位（诚实）**：assignee/关联 PR 都是产品仓 collaborator 的操作，防的是"状态
    误读"不是"恶意协作者"——威胁模型与手册一致（Issues 是唯一状态来源，写权限即状态
    权限）。不引入自定义 status label 做主判据：label 谁都能贴且没有行为含义，assignee
    与 PR 关联是"真的有人在干活"的行为证据。`status:blocked`（M2 已建）不参与状态推导，
    是人用的提示 label。
  - timeline 读取（`GET /issues/{n}/timeline` 全分页，filter `cross-referenced` 事件且
    `source.issue.pull_request` 存在且 source 仓库 == 产品仓）**只对"内容有变化、需要
    分流"的 Issue 惰性执行**（§4.3），不对全量 Issue 拉 timeline。
- **D9 — §10.2 每一行的可执行化 + "确认后更新"的确切含义**（§4.5 原文"未开始且内容
  变化 → 生成 update diff，确认后更新"）：

  | §10.2 行 | 触发条件（本文判据） | publish 动作 |
  |---|---|---|
  | 文档澄清 | 任务在编译输出中、content-hash（D10）与 Issue marker 一致，且 provenance-hash 一致 | no-op |
  | 仅批准链变化 | content-hash 一致、provenance-hash 不一致 | **refresh-metadata**：只刷新批准溯源小节与 provenance marker，不创建 Change Issue |
  | 新增非破坏性 requirement | task ID 无对应 primary Issue | create（含完整 marker + body） |
  | 未开始 Issue | primary 存在、content-hash 不一致、状态 `not_started` | **update**：替换 managed region + 更新 marker（"确认" = 人在触发 publish 前已审阅过 dry-run 报告里的逐 Issue diff——dry-run 是确认界面，publish 是确认动作；不存在第二个交互式确认步骤，CI 环境也不可能有） |
  | In Progress | 同上但状态 `in_progress` | **create Change Issue**（D20），原 Issue 一字不动 |
  | Done / cancelled | 同上但状态 `done`/`cancelled` | **create Change 或 Migration Issue**（migration 判据见 §6.3），原 Issue 不重开 |
  | 重复运行相同 revision | content-hash 与 provenance-hash 全部一致 | 全量 no-op（§12.9） |

  编译输出中**不再存在**的 task ID 进入 orphan reconciliation pass（D18）：仍不删除、
  不关闭 primary Issue；`not_started` 只报告 `orphaned`，`in_progress`/`done`/`cancelled`
  创建幂等 Change Issue。若旧 Issue 的 `references.operations` 中有 operationId 已不在
  当前 OpenAPI extractor 输出集合中，Change Issue 的 kind 为 `migration`；其它 REQ/SCR/
  平台移除为 `change`。这使删除 operation 后已经从当前任务集消失的 backend/common 任务
  仍能兑现 §12.14，而不是被 orphan 分支吞掉。
- **D10 — Issue body = marker 头 + 受管区域 + 人类自由区；变更检测只看 content-hash，
  provenance 与 revision 永不参与 hash**（回答任务书"provenance 记录会不会被 update diff
  误判成内容变化"——被设计排除）：
  ```text
  <!-- sdd-task-id: ios.screen.login -->
  <!-- sdd-source-revision: <40-hex> -->
  <!-- sdd-content-hash: sha256:<64-hex> -->
  <!-- sdd-provenance-hash: sha256:<64-hex> -->
  <!-- sdd-role: primary -->
  <!-- sdd:task-begin -->
  ...渲染的任务正文：title/scope/acceptance/references/depends_on（链接到依赖 Issue）、
     spec 版本、以及"批准溯源"小节（每个 gate 的 PR#/merge SHA/approved_at，§5.4 的
     校验结果原样复述）...
  <!-- sdd:task-end -->
  （sdd:task-end 之后的内容归人类所有，compiler 永不读写）
  ```
  - `content-hash = sha256(canonical JSON of {id, platform, track, title, scope,
    acceptance, references, depends_on, spec_version})`——**输入是编译出的任务结构体，
    不是渲染后的 markdown**：渲染模板措辞调整不改变 hash（纯呈现变化不惊动 §10.2），
    provenance / source_revision / role 都不在 hash 里（重新批准同一内容、或对相同内容
    换 revision 重跑，都不构成**任务内容**变化）。另算
    `provenance-hash = sha256(JCS(按 gate 名排序后的已验证 Provenance 摘要))`，摘要含
    gate、PR、merge SHA、approved head SHA、approved_at 与 required_checks；它只驱动
    `refresh-metadata`，绝不驱动 Change/Migration Issue。
  - update 操作 = 只替换 begin/end 之间 + 刷新 marker 三行（task-id 不变）；**受管区域内
    的人工编辑会在下次 update 时被覆盖**（明文写进渲染出的正文提示里）；end 之后的
    人类笔记永不触碰。
  - content-hash 一致且 provenance-hash 一致时连 marker 的 source-revision 也不刷新
    （完全 no-op，§12.9）；content-hash 一致但 provenance-hash 改变时执行一次
    `refresh-metadata`，保持 source-revision 不变，只更新批准溯源小节与 provenance-hash。
    marker 里的 revision 语义因此是"最后一次**内容变化**来自哪个
    revision"，不是"最后一次 publish 跑过哪个 revision"——两个语义容易混，取前者是因为
    它能回答"这个 Issue 的内容出处"，后者只能靠 workflow run 日志回答（那本来就是
    run 日志的职责）。
- **D11 — 已发布 Issue 的定位：全量列出 + 解析 marker 建索引，绝不用 Search API**
  （§13 排障清单第 3 条的正面实现）：`GET /repos/{o}/{r}/issues?state=all&per_page=100`
  全分页（**该端点混含 PR，按 `pull_request` 字段过滤掉**——易错点显式点名）、对每个
  issue body 解析 marker 头。不用 Search API 的理由：结果最终一致（新建 Issue 可能秒级
  不可见——恰好是崩溃重跑最需要看见它们的时刻）、额外限流、短语匹配语义不精确——三条
  任何一条都足以在重跑时漏查已建 Issue 而重复创建。完整性：`per_page=100` 追
  **Link header** 到结束（M2 既有惯例，不用"不满一页/空页"猜测——m4 D22 教训的同款）+
  防御性页数上限（超限抛错）；GitHub 对 issues 列表没有 `changed_files` 式的权威计数，
  这是该端点能做到的最强保证，**如实记录而不假装更强**。索引不变量校验：同一
  `(task_id, role=primary)` 出现多个 Issue → **fail closed**（§6.8 核验清单"没有重复
  task ID"的运行时形态；报告全部编号，人工处置，publish 拒绝在脏状态上继续写）。
- **D12 — 单写者 workflow 拓扑：平台仓 `backlog-publish.yml`（`workflow_dispatch`）+
  以 `inputs.product_repo` 为 key 的 concurrency group + 环境保护的 App 身份**——这是
  与 M2 D7/D10 张力的显式调和（类比 m4 D2 对 D10 边界的处理），§5.1/§5.2 全文展开。
  要点：
  1. **workflow 放平台仓**：产品仓不含任何 workflow（M2 D7 铁律不破）。手册 §6.8 的
     YAML 片段（`group: sdd-backlog-${{ github.repository }}`）是按"workflow 在产品仓"
     的假设写的——在平台仓宿主下 `github.repository` 恒为平台仓，会把**所有产品**塞进
     同一把全局锁（错误的粒度）。调和：group 改为含目标产品仓标识
     `sdd-backlog-${{ inputs.product_repo }}`，锁的**意图**（按产品串行）保持，**实现
     载体**（哪个仓的 workflow）改变；需要同步 runbook §6.8 片段（§11 上层文档修订）。
  2. **canonical 仓身份守卫（事实修正）**：GitHub concurrency group 名称本身
     **大小写不敏感**，`Acme/Demo` 与 `acme/demo` 不会取得两把锁；canonical 化不是并发
     安全的第二层，而是避免重命名旧名/大小写变体进入 marker、run-name 与日志的身份卫生。
     CLI 触发路径先经 `GET /repos` 解析出 canonical `full_name` 再 dispatch；workflow
     第一步（任何写之前）用 App token `GET /repos/{input}`，
     要求返回的 `full_name` 与 input **逐字节相等**，不等（含大小写变体、重命名旧名、
     不存在）→ fail closed 零写。于是"绕开锁"的变体 dispatch 最多空跑到第一步就死，
     **到达写阶段的运行必然共享同一个 group**。
  3. `cancel-in-progress: false` → 并发触发时第二个排队等待（§12.10 字面）。GitHub 的
     队列语义：同 group 至多 1 running + 1 pending，第三个触发会**顶替**（取消）之前的
     pending——被顶替的意图由更新的触发承载且 publish 幂等，语义可接受，如实记录。
  4. **不踩 `repository_dispatch` 红线的论证**：手册 §1 排除的是"跨仓库
     `repository_dispatch`"事件扇出（产品仓事件驱动平台仓、或反向）。本设计是**人/CLI
     直接对平台仓调用 `workflow_dispatch` API**——单仓、显式、点对点的调用，不存在
     事件路由与扇出；产品仓侧不产生也不消费任何 dispatch 事件。
- **D13 — 写身份：组织级 GitHub App 的 installation token，运行内铸造，环境保护**：
  默认 `GITHUB_TOKEN` 只对宿主（平台）仓有权限，写产品仓 Issues 必须跨仓凭据（呼应
  m4 D24 的 App 讨论；publish 是 `workflow_dispatch` 而非 fork PR 触发，**不存在 m4
  D24 的 fork 拿不到 secret 问题**）。设计：
  - App 权限（安装到全部产品仓）：Issues:write（建/改/label）、Contents:read（checkout
    source_revision）、Pull requests:read + Checks:read + **Actions:read** + Members:read +
    Metadata:read（`verifyGateApproval` 的读集；Actions:read 用于 M4.5 D11 从 check 反查受信
    workflow run identity）。**无 Contents:write**——publish 对产品仓的 git 内容
    零写，Issue 是唯一写面。
  - App 私钥存平台仓 **environment secret**（环境名 `backlog-publisher`），环境的
    deployment branch policy 限定 `main`——`workflow_dispatch` 可以对任意 ref 触发
    workflow 文件的任意分支版本，不锁环境的话，有平台仓写权限的人可以在分支上改出一个
    "跳过授权校验的 publish"并拿到密钥；锁 main 后分支版本拿不到 secret，改动必须先过
    平台仓自己的 PR 流程。触发权限（对平台仓 Actions 的 write）是运维边界，如实记录为
    前置（§11 待决 #1：是否要求 environment required reviewers 加一道人工放行）。
- **D14 — 本地 CLI 的角色：只 dry-run，或触发 workflow；本地直写不提供**（§6.8"本地
  CLI 默认只 dry-run 或触发该 workflow"的收紧落地）：`sdd backlog publish` 本地执行 =
  编译 + （给了授权引用则）校验 + 打印计划摘要 + `POST .../workflows/backlog-publish.yml/
  dispatches`；真正的写只发生在 workflow 内部运行的 `sdd backlog publish --execute`。
  不提供"绕过锁的本地直写"逃生舱——锁与 upsert 缺一不可（§6.8），本地进程拿不到
  concurrency 锁，直写等于亲手拆掉一半防线；隔离 org E2E 也走真 workflow（§8）。
  `--execute` 在检测到非 Actions 环境（无 `GITHUB_ACTIONS`）时拒绝运行并指路，防误用；
  这是防呆不是安全边界（安全边界是"App 凭据只存在于受保护环境"，D13）。
- **D15 — 强制授权校验 = 对完整输入集逐项 `verifyGateApproval`，全部通过才允许任何写**
  （§5.4 全文展开；plan §1"M5 校验完整输入集"的落地）。输入集与 Gate 的映射、design 的
  skip 证据形态、contracts 的存在性判定都在 §5.4 精确定义；**dry-run 与真实执行的
  fail-closed 边界逐字沿用 M3 D7**：两者都真实调用校验并如实报告 `verified`，dry-run
  无论真假都照常出完整计划且零写，仅 `--execute` 在任一项 `verified=false` 时 fail
  closed（退出码 7，零写）。
- **D16 — marker 不是账本（概念边界，防评审误读）**：`sdd-task-id` /
  `sdd-source-revision` / `sdd-content-hash` / `sdd-provenance-hash` 是 **upsert 的定位键与变更检测缓存**，
  不是授权来源、不是状态来源——授权的唯一来源是 publish 时实时的 `verifyGateApproval`
  （GitHub PR/merge 元数据），任务状态的唯一来源是 Issue 本身的 open/closed/assignee/
  关联 PR（D8）。marker 被人为篡改的后果止于"下次 publish 的收敛动作变化"（hash 改坏 →
  多做一次 update 覆写回来；task-id 改坏 → 该 Issue 失联、同 ID 重建新 Issue、失联者
  进 orphan/重复报告），**不可能借 marker 获得任何授权**。这与 plan §1"不建仓内账本"
  不冲突：账本的定义是"可被后续提交改写的自证授权记录"，marker 不承载授权。
- **D17 — `sdd impact --with-issues`：在 M4 契约之上加层，不改 `computeImpact` 签名**
  （§6 展开）：Issue 归并层是独立函数 `annotateImpactWithIssues(impact, index)`，输入
  M4 的 `SDDImpact` 输出 + D11 的 Issue 索引，产出填充了两个数组的新 `SDDImpact`。
  CLI 组合两层；`detect`（CI）永不传 `--with-issues`（m4 §5.3 已钉死，detect 也没有
  Issues 读权限诉求）。任务→ID 反查用 **Issue 受管区域里渲染的 references**（发布时
  写入的结构化清单，§4.2 解析回来），不重新编译旧版 spec——已发布 Issue 自包含。
- **D18 — 幂等收敛的判定序（当前 task 六岔路 + orphan pass，publish 与 dry-run 共用
  分类函数）**：`索引无此 ID → create`；`有且 content/provenance hash 均等 → no-op`；
  `content hash 等而 provenance hash 不等 → refresh-metadata`；`有、content hash 不等、
  not_started → update`；`有、hash 不等、in_progress → ensure-change-issue`；
  `有、hash 不等、done/cancelled → ensure-change-or-migration-issue`。全部动作幂等
  （create 以"索引重查"为前提、ensure-* 以 D20 三元组定位去重），**任何前缀崩溃 +
  同输入重跑 = 剩余后缀继续执行**，无需也没有本地断点记录。当前 tasks 分类完成后，对
  索引中未命中的 primary 执行上述 orphan reconciliation pass；Change/Migration Issue
  仍以 D20 三元组去重。
- **D19 — 并发防线分层陈述（自查："concurrency 是唯一防线吗"）**：写-写并发的**唯一
  防线是 concurrency group**（GitHub 没有 Issue 的条件创建/CAS，"查了再建"天然有
  查-建窗口，任何应用层花招都关不死它，不假装能关死）。分层：① 锁保证同产品同时至多
  一个写者（§12.10）；② upsert 保证同一写者的重试/崩溃重跑收敛（§12.9）；③ **写后
  核验**（§5.6）在全部写完成后重建索引，检查"每 task ≤1 个 primary、marker 齐全、
  无重复 task-id"——若锁外写者（人工建了带 marker 的 Issue、或有人绕过流程）留下残留，
  在这里**检出并以失败退出**（报告编号，人工处置，不自动删）。②③ 都不是①的替代，
  三层各管一段，这就是"锁与 upsert 缺一不可"再加一层"§6.8 发布后核验清单自动化"。
- **D20 — Change/Migration Issue 的身份与幂等**：primary Issue 的唯一性键是
  `(task_id, role=primary)`；变更 Issue 的唯一性键是 **`(task_id, role=change,
  source_revision)` 三元组**（marker：`sdd-role: change` + 同名 task-id + 触发本次
  变更的新 revision）。同一 revision 重跑 → 三元组命中 → no-op（§12.12 幂等）；
  revision 再前进且内容又变 → 新三元组 → 新 Change Issue（每轮变更各留痕，符合
  "Change Issue 是给人排期的工作项"语义）。Change Issue 内容：标题
  `Change: <task title>`、label `type:change` + 原平台 label、body 含指向 primary
  Issue 的引用、新旧 content-hash、变更摘要（引用 `changed.*` 里命中的源 ID）、
  migration 时的 breaking 依据；**它不承载 marker 意义上的任务内容**（primary 仍是
  任务的家），role=change 的 Issue 永不被 update（一次性创建物）。为保持统一的五行
  marker，change Issue 的 `sdd-content-hash` 是 canonical change payload（task_id、kind、
  primary issue、新旧 hash、reason）的 hash，`sdd-provenance-hash` 是创建该 change Issue
  时的批准链；两者只用于完整性诊断，不参与后续 primary 分类或 metadata refresh。
- **D21 — label 词表补全**：M5 用到而 M2 未建的 label：`platform:common`（D7）。
  `type:change` M2 已建；migration 不加新 type label（`type:change` + body 注明
  migration + `suggested_change_issues.kind` 字段区分，避免 label 集合漂移；评审如
  认为值得，加 `type:migration` 是一行 desired-state 的事，列 §13 待决 #6）。
- **D22 — Projects 看板边界（核对过手册原文后的定界）**：§6.8 核验清单含"Issues 已
  加入对应 Project view"，§4.5/§10.2 未再提 Projects——手册全篇 Projects 只是 view、
  Issues 是唯一状态源。M5 **不调用 Projects API**（GraphQL-only、org 级资源、M2 也
  从未创建 Project）；实现方式：发布的 label 集合（platform:*/track:*/type:*）足以
  支撑 Projects v2 的 auto-add filter（人工一次性配置），§6.8 该条核验在 §5.6 的
  发布后报告里列为 **manual 项**（打印提示而非 API 断言）。看板自动化明确移出 M5
  （任务书边界确认）。

## 1. 稳定 task ID（§4.4/§13 的核心）

### 1.1 ID 语法与四个任务族

ID 匹配 M1 task schema 的 `^[a-z0-9]+(\.[a-z0-9-]+)+$`，本文收窄为恒三段
`<platform>.<kind>.<slug>`：

| 族 | ID 形态 | 生成规则（每源恰一枚） | track | references | depends_on |
|---|---|---|---|---|---|
| 合同 | `common.contract.<slug(operationId)>` | contracts/openapi.yaml 的每个 operation | `contract` | operations=[opId] | —（根） |
| 后端 | `backend.api.<slug(operationId)>` | 每个 operation × backend 已声明 | `code` | operations=[opId] | `common.contract.<同 slug>` |
| 屏幕 | `<client>.screen.<slug(SCR-X 去前缀)>` | design.md canonical 屏幕清单的每个 SCR × 每个已声明客户端平台（web/ios/android） | `code` | screens=[SCR]；operations=design §8 映射表命中的 opId（无则空） | 映射 opId 各自的 `common.contract.*`（合同先行；**不依赖 backend**——§8.1 的 mock 并行开发） |
| 需求 | `<platform>.req.<lower(AREA)>-<n>` | spec.md canonical `### REQ-<AREA>-<n>` 的每个 REQ × 每个已声明平台 | `code` | requirements=[REQ] | —（特性级伞任务；细粒度顺序由前三族与 plan.md 承载） |

- 源提取**复用 m4 D20 第 4 稿的三个 extractor**（REQ 只认 canonical heading、SCR 只认
  canonical 屏幕清单行、operation 经 `yaml` 解析取 operationId）——同一套代码回答"有哪些
  ID"，M4 的 diff 与 M5 的任务生成永不因解析差异分道扬镳；design.md §8 页面↔OpenAPI
  映射表的解析是 M5 新增的小 extractor（canonical 表行 `SCR-X | opId[, opId]`，解析
  失败/表缺失 → 该 screen 的 operations 为空 + dry-run warning，**不猜**）。
- **为什么 req 族覆盖全部平台而不试图判断"这个 REQ 与哪个平台相关"**：模板没有强制
  REQ↔平台/REQ↔SCR 的结构化映射，任何相关性判断都是启发式 → 不稳定 → ID 集合随措辞
  漂移 → §13 事故。全平台生成是确定性的保守选择（M4 D5 保守性原则在 backlog 侧的
  对应物）；不适用的任务由人关闭（closed as not_planned → D8 的 `cancelled` 态，后续
  变更不会再骚扰它）。
- **为什么 backend 有 api 族而客户端没有 per-op 族**：backend 的交付面就是 operation
  （M6 conformance 按合同验收）；客户端消费 operation 但工作单元是 screen/feature，
  per-op 客户端任务既无对应验收物又制造噪音。
- kind 集合 `{contract, api, screen, req}` 是**封闭保留字**：REQ 的 AREA 段被移入
  segment 3（`req.<area>-<n>`），不占 segment 2——避免 `REQ-API-001` 生成
  `backend.api.req-001` 与 api 族碰撞（自查抓到的跨族碰撞）。segment 3 内部：AREA 为
  `[A-Z0-9]+`（无连字符）、n 为 `\d+`，`<lower(area)>-<n>` 可无歧义反解回 REQ ID。

### 1.2 slug 算法（确定性、全函数，实现为纯函数 `slugify`）

```text
输入：operationId（^[a-z][a-zA-Z0-9_-]*$，Contract Gate D6.2 强制）或 SCR 名段
     （SCR- 后的 [A-Z0-9-]+）
1. camelCase 边界插 '-'：小写/数字→大写 的每个边界（loginUser → login-User）
2. 全小写；'_' → '-'
3. 折叠连续 '-'，去首尾 '-'
4. 结果必须匹配 ^[a-z0-9][a-z0-9-]*$ 且非空；否则该源 fail closed（退出码 3，
   报源 ID——不静默丢弃、不代填占位符）
例：loginUser → login-user；login_user → login-user（与上例碰撞 → D4 硬失败）；
    SCR-LOGIN → login；SCR-LOGIN-V2 → login-v2
```

### 1.3 跨版本同一性（v1→v2）

- ID 无版本段；`--version` 只决定读 `specs/<version>/`。v2 保留的 REQ/SCR/operation →
  同 ID → 命中既有 Issue → 按 D18 分类（内容没变 no-op，变了走 §10.2）。v2 新增源 →
  新 ID → create；v2 移除源 → orphan 报告（D9 末条）。
- **同一 requirement 在同一平台的多任务**：MVP 按构造不存在（req 族每 (REQ,平台) 恰一
  枚；screen/api 族的多任务由各自源 ID 区分）。未来要拆分时，扩展方向已定：在 kind
  后加**源内稳定子键**（如 REQ 验收标准的显式锚点），**禁止**顺序号/标题派生——把这条
  写成对未来修改者的约束，防止有人用"-1/-2 后缀"重新引入下标。

## 2. strategies 与依赖归并

### 2.1 输入 → strategy → 输出

| strategy | 读取（§6.7 六类中的） | 产出族 |
|---|---|---|
| common | contracts/openapi.yaml | 合同族 |
| backend | contracts/openapi.yaml + projects.yaml | 后端族（backend 已声明时） |
| web / ios / android | specs/<v>/design.md（屏幕清单 + §8 映射）+ projects.yaml | 屏幕族（对应平台已声明时） |
| （全部） | specs/<v>/spec.md + projects.yaml | 需求族 |

- `architecture.md` 与 `plan.md`：**参与授权校验与 source_revision 定位（§5.4），MVP 不
  从中提取结构化字段**——两者是散文，任何提取都是不稳定启发式；plan 对任务边界的指导
  由人消费。显式记录，防评审问"六类里怎么少了两类"。
- design.md 不存在（无 UI 产品，走 skip 路径）→ 屏幕族为空集，合法。
- contracts/openapi.yaml 不存在 → 合同族与后端 api 族为空集，合法（后端仍有 req 族）。

### 2.2 编译流水（纯函数 `compileBacklog`）

```text
输入：{ files: 六类文件在 source_revision 的字节, version, projects: 已过 sdd validate }
1. 解析 projects.yaml → declared 平台集合（ci→platform 词表映射，D6）
2. 各 strategy 独立产出 Task[]（§1.1 表）——每个 task 过 @sdd/schemas 的 task 校验
   （自产自校，不合规是实现 bug，抛错不吞）
3. 归并 pass：D4 全局 ID 唯一性 → D5 悬空引用 + 环检测
4. 输出 CompiledBacklog = { tasks（按 id 字节序排序）, graph（边列表排序）, 源统计 }
```

确定性：输出只依赖输入字节；无时间戳/随机量；同输入两次编译 byte-identical（M2 D12
的编译侧应用，§7 的 operation_id 建立在此之上）。

### 2.3 依赖方向与环

MVP 的边全部指向合同族（api→contract、screen→contract），req 族无边——图按构造是
以 contract 为根的两层 DAG。D5 的检测仍无条件跑（安全网 + 未来族形状变化的护栏）。
跨平台依赖的表达完全落在 `depends_on`（发布时渲染成 Issue 链接），**不用** GitHub 的
blocked-by 关系（无公开稳定 API）也不用 milestone 模拟。

## 3. Issue 状态模型

见 §0 D8（判定表、方向性、防伪定位、惰性 timeline）。补充实现细节：

- assignees 与 state/state_reason 来自 D11 的全量列出响应，零额外请求；timeline 只对
  "hash 不等"的 task 对应 Issue 拉取（全分页 + 页数防御上限）。
- timeline 事件里 PR 引用的仓库判定：`source.issue.repository.full_name == 产品仓`
  （fork 上引用产品 Issue 的 PR 不算"在干活"——不引入 fork 贡献假设，与 m4 D24 记录的
  组织内协作模型一致）。
- 状态推导函数 `deriveIssueState(issue, timeline?) → 'not_started'|'in_progress'|
  'done'|'cancelled'` 是纯函数，表驱动单测覆盖四态 × 信号组合（§8）。

## 4. Issue 渲染、marker 与 upsert 操作

### 4.1 渲染（`render.ts`）

- 输入 task + provenance 集合 + source_revision → `{ title, body, labels }`。title =
  task.title（**title 只是呈现**——改标题不改 ID、不参与定位，§13"不能由标题推导"的
  另一半）；labels = `platform:<p>` + `track:<t>` + `type:task`（change issue 为
  `type:change`）。
- body 结构见 D10；references/depends_on 渲染为结构化清单（`- REQ-AUTH-001` 每行一项，
  §6 的反查解析依赖该格式，渲染器与解析器同文件成对实现 + round-trip 测试）。
- publish 的 create 顺序按依赖图反向拓扑（依赖先于依赖者；同层按 task ID 排序），每次
  create 成功即更新内存索引，随后依赖者才能把 `depends_on` 渲染为真实 Issue 链接；若
  依赖 task 已规划创建但最终仍无 Issue 编号，依赖者不得以裸 task ID 降级发布，整体失败。
- 长度守卫：body > 60000 字符（GitHub 上限 65536 留余量）→ 该 task fail closed 并报
  源（不截断——截断会破坏 marker/正文完整性且 hash 与内容失配）。

### 4.2 marker 解析（`marker.ts`）

- 头五行 HTML 注释逐行前缀解析（同 M2 gate marker 风格）；缺任一行/格式非法 → 该
  Issue 视为"非受管"（不入索引，不参与 upsert；出现在核验报告的 unmanaged 列表——
  它可能是人手写的仿制品，宁可视而不见也不猜）。
- `sdd:task-begin/end` 定界受管区域；缺 end → 视为受管但**损坏**：update 时整个 body
  重建为 marker+受管区域（丢弃无法定界的残余——损坏态无法保全人类区，报告注明）。

### 4.3 upsert 动作集（`publish.ts`，全部经注入的 `IssuesWritePort`）

| 动作 | GitHub 调用 | 幂等依据 |
|---|---|---|
| ensure-labels | list labels + create 缺失项 | 按名存在即 no-op（D7/D21） |
| create | `POST /issues`（title+body+labels 一次成型，**不做"先建后补"两段式**——崩在两段之间会留下无 marker 的裸 Issue） | 执行前索引确认无此 ID；任何歧义失败后先重建索引再决定是否重试（见下） |
| update | `PATCH /issues/{n}`（body 替换受管区 + marker；labels 做加法与受管值纠正，不删人工 label） | hash 不等才执行；执行后 hash 相等 → 重跑 no-op |
| refresh-metadata | `PATCH /issues/{n}`（只更新 provenance 小节与 provenance-hash） | provenance-hash 不等才执行；不改变 task content-hash/source-revision |
| ensure-change-issue | 同 create，role=change | D20 三元组，索引命中即 no-op |

写节流：串行逐条 + 遵守 `Retry-After`/secondary limit 退避。`PATCH` 可按 M2 `withRetry`
重试；**所有创建类 POST 禁止盲重试**：网络断开/超时/5xx 等无法证明服务端未创建的结果后，
先重新全量读取 Issue 索引并按 primary 键或 D20 三元组查询；已出现则视为前次成功，仍不存在
才允许下一次 POST（有界重试）。这覆盖“服务端成功但客户端未收到响应”的重复创建窗口。

## 5. `sdd backlog publish`：单写者 workflow

### 5.1 workflow（平台仓 `.github/workflows/backlog-publish.yml`）

```yaml
name: backlog-publish
on:
  workflow_dispatch:
    inputs:
      product_repo:     { type: string, required: true }   # owner/name，canonical 大小写
      version:          { type: string, required: true }   # ^v\d+$
      source_revision:  { type: string, required: true }   # 40-hex，产品 main 上的 commit
      spec_pr:          { type: string, required: true }   # 数字
      architecture_pr:  { type: string, required: true }
      design_pr:        { type: string, required: true }   # 数字，或字面 "skipped"
      plan_pr:          { type: string, required: true }
      contract_pr:      { type: string, required: false }  # 数字；source_revision 含
                                                            # openapi.yaml 时必填（§5.4）
run-name: "backlog-publish ${{ inputs.product_repo }}@${{ inputs.source_revision }}"
concurrency:
  group: sdd-backlog-${{ inputs.product_repo }}   # D12：按目标产品串行；手册片段的
  cancel-in-progress: false                        # github.repository 在平台仓宿主下是
                                                   # 错误粒度，已显式调和
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: backlog-publisher       # D13：App 私钥所在环境，branch policy=main
    steps:
      - checkout 平台仓（github.sha）→ pnpm install --frozen-lockfile → build
      - 铸造 App installation token（对 inputs.product_repo；action 按完整 SHA pin）
      - name: canonical guard            # D12 防线二：任何写之前
        run:  GET /repos/<input> 的 full_name 必须与 input 逐字节相等，否则 exit 7
      - name: freshness guard            # D2：source_revision == 产品 main 当前 HEAD
        run:  不等则 exit 7（提示对新 HEAD 重新触发）
      - name: checkout 产品仓 @ source_revision（App token，只读，独立目录，
              **全历史 fetch-depth: 0**——§5.4 的 verifyGateApproval 经
              createLocalGitReader 调 blobAt/codeownersAt 读各 Gate PR 的
              merge/base commit，浅克隆缺祖先历史会让全部授权校验假性失败）
      - name: publish
        run: |
          node cli/bin/run.js backlog publish --execute \
            --repo <input> --version <v> --source-revision <sha> \
            --spec-pr ... --architecture-pr ... --design-pr ...|--design-skipped \
            --plan-pr ... [--contract-pr ...] \
            --product-checkout <上一步路径>
```

- 触发方需要平台仓 Actions write（运维前置，§13 待决 #1 讨论是否再加 required
  reviewers）；`workflow_dispatch` 是对平台仓的直接 API 调用，不触碰手册 §1 排除的
  跨仓 `repository_dispatch`（D12.4）。
- 所有 inputs 在 CLI 侧（触发前）与 workflow 内（执行前）双重格式校验；`source_revision`
  非 40-hex、version 非 `^v\d+$`、PR 号非数字 → 退出码 2。

### 5.2 本地 CLI（触发方）

```bash
# 只读预览（默认；--dry-run 为同义显式旗标）
sdd backlog compile --repo <owner/name> --version v1 [--source-revision <sha>] \
  [--spec-pr N --architecture-pr N (--design-pr N|--design-skipped) --plan-pr N \
   [--contract-pr N]] [--format json|text]

# 触发单写者 workflow（本地不直写，D14）
sdd backlog publish --repo <owner/name> --version v1 \
  --spec-pr N --architecture-pr N (--design-pr N|--design-skipped) --plan-pr N \
  [--contract-pr N] [--source-revision <sha>]   # 缺省解析远端 main HEAD → 40-hex
```

- `compile`：API 读产品仓（source_revision 缺省同上解析）；给了授权引用就真实校验并
  如实报告（D15/M3 D7），没给则 `authorization.verified=false, reason="no approval
  references supplied"` 且照常出完整计划；恒零写。**compile 需要 Issues:read**（分类
  依赖现存 Issue 索引）——用户 token 读得到即可；读不到（无权限）→ 计划中所有分类降级
  标注 `state: unknown`，动作列 `create-or-reconcile?` 并加醒目 warning（预览尽力而为，
  真判定在 execute；不因预览权限不足而假装知道状态）。
- `publish`（本地）= compile + 打印摘要 + dispatch + 打印 Actions 查看指引后退出 0
  （不轮询占用进程，M2 惯例）；dispatch API 无返回 run id，指引给出按 run-name 过滤的
  URL。退出码：`0` 已触发；`2` 输入错误；`3` 预检失败（如 compile 已发现 ID 冲突/环——
  没必要浪费一次 workflow 运行）；`6` API 暂时性失败。

### 5.3 `--execute` 执行流水（workflow 内部；退出码沿 M3：`7`=授权失败，`5`=状态
冲突/核验失败，`3`=编译失败，`6`=暂时性）

```text
1. 平台仓构建产物自检 + 参数格式校验
2. canonical guard / freshness guard（workflow 步骤已做，CLI 内重复执行——防线不依赖
   "调用方一定是那个 workflow"这一假设；本地误开 --execute 时同样成立）
3. 授权校验（§5.4）：任一 fail → exit 7，零写
4. 从 --product-checkout（source_revision 的产品仓副本）读六类文件 → compileBacklog
   （§2.2）→ 冲突/环 → exit 3
5. D11 全量索引（含完整性不变量校验；重复 primary → exit 5，零写）并完成当前 task +
   orphan reconciliation 分类
6. freshness guard #2：紧邻首写再次要求 source_revision == main HEAD；不等 → exit 7 零写
7. ensure-labels（首个写操作）
8. 按 D18 顺序执行 upsert；创建类 POST 的歧义失败先重建索引再重试（§4.3）；重试耗尽
   → 中止后续，exit 6——同输入重跑从第 5 步重建索引后收敛
9. 发布后核验（§5.6）+ freshness guard #3；main 已前进则 exit 7 并明确要求按新 HEAD
   重跑，不把陈旧发布报告为成功；否则 exit 0，产出核验报告
```

### 5.4 强制授权校验（完整输入集，D15）

在 `--product-checkout`（=source_revision 的干净副本，worktree 天然 clean）上构造
`createLocalGitReader`（M3 契约），逐项调用 `verifyGateApproval`：

| 输入 | gate | artifactPath | approval 来源 | 附加规则 |
|---|---|---|---|---|
| spec.md | `spec` | `specs/<v>/spec.md` | `--spec-pr` | — |
| architecture.md | `architecture` | `specs/<v>/architecture.md` | `--architecture-pr` | 同一 PR 校验两次（第二行） |
| projects.yaml | `architecture` | `projects.yaml` | 同上 | 与上一行同 PR——两 artifact 都必须在其 changed files 中 |
| design.md | `design` | `specs/<v>/design.md` | `--design-pr` | 与 `--design-skipped` 互斥，二者必居其一 |
| （design 跳过） | — | — | `--design-skipped` | **两层不可变证据**：① 已由 `--plan-pr` 的 Plan Gate 批准并通过 blob 一致性校验的 `plan.md` 必须含 `sdd:design-skip` 机读块，且 `reason:` 非空；② source_revision 下 `specs/<v>/design.md` 必须不存在。PR body marker 只供 hygiene/人类阅读，M5 不把可在合并后编辑的 body 当授权事实 |
| plan.md | `plan` | `specs/<v>/plan.md` | `--plan-pr` | — |
| contracts/openapi.yaml | `contract` | `contracts/openapi.yaml` | `--contract-pr` | **存在性驱动的必填**：source_revision 下该文件存在 ⇔ `--contract-pr` 必填；文件存在而缺参 → exit 2；文件不存在而给参 → exit 2（悬空授权引用同样拒绝——参数与输入集必须一一对应）。M1 contract 路径自动要求 approved head SHA 上 success 的 `Contract Gate` check（M4.5 evidence 链；M4.5 未落地 → 此处 fail closed，文首时序） |

- 每一项都经 `verifyGateApproval` 的全套判定（已合并受保护 main、CODEOWNER 批准绑定
  最终 head、artifact ∈ 该 PR changed files、blob 与 checkout 一致、label 一致 +
  存在性〔§11.1 #2 补丁〕、current-codeowners 复算）。**blob 一致这一步在这里的含义**：
  source_revision 的每个产物字节 == 各自 Gate 批准的字节——若某产物在 Gate 之后被无
  gate 的 PR 改动过（hygiene 对非 Gate PR 只做通用校验，挡不住 specs/** 的普通修改），
  此处必然失配 → fail closed，直到新 Gate 重新批准。这是"完整输入集"的实质：**六类
  文件在 source_revision 上的每个字节都有活的批准链**。
- `sdd:design-skip` 块随 `plan.md` 一起进入 Plan PR 最终 head，例如
  `<!-- sdd:design-skip\nreason: backend-only product\n-->`；解析器只接受唯一块与非空单行
  reason。M5 同步更新 `specs/_template/plan.md`；存量产品若走 skip，需经新的 Plan Gate
  re-affirm 该 plan.md，不能靠编辑历史 PR body 补证据。
- `contracts/events.yaml`：M4.5 未给它 gate，M5 编译也不读它（§2.1）——**不在输入集、
  不校验**，显式记录以免评审误以为遗漏。
- 五项校验的 `Provenance` 结果集原样进入每个 Issue 受管区域的"批准溯源"小节（§6.8
  "每个实现 Issue 引用批准的 spec commit"的超集），并进入 dry-run/核验报告。

### 5.5 幂等 / 并发 / 重放 / 崩溃恢复（自查汇总表）

| 场景 | 防线 | 验收 |
|---|---|---|
| 同 revision 发布两次 | content/provenance hash 全等 → 全量 no-op（连 marker 都不刷，D10） | §12.9 |
| 并发两个 publish | concurrency group（D12），第二个排队 | §12.10 |
| 中途崩溃重跑 | 无本地状态；重建索引（D11）→ 已写命中 no-op、未写继续（D18） | §12.9 |
| 崩在 create 与后续 task 之间 | create 单调用成型（§4.3），不存在半成品 Issue | §8 失败注入 |
| 查-建窗口被锁外写者插入 | 锁是唯一写-写防线（D19，如实陈述）；写后核验检出重复并失败报告 | §8 |
| 重放旧 revision | freshness guard（D2.2） | §8 |
| 非 canonical/重命名旧仓名输入 | canonical guard 拒绝，锁本身按 GitHub 大小写不敏感语义工作（D12.2） | §8 |
| marker 被篡改 | D16：失联/重复进核验报告，授权不受影响 | §8 |
| 排队期间 main 前进 | 后到运行的 freshness guard 失败，操作者重触发 | §8 |
| **运行中** main 前进 | 首写前 guard 尽量保证零写；若写入期间前进，发布后 guard 令 run 失败并要求按新 HEAD 重跑，禁止陈旧 run 报成功 | 失败注入/E2E |

### 5.6 发布后核验（§6.8 清单的自动化）

写全部完成后重建索引，逐条断言并产出核验报告（任一失败 → exit 5；随后执行 freshness
guard #3，失配 → exit 7）：
每个受管 Issue 有符合其 role 的完整 marker；`(task_id, primary)` 无重复；本次任务集每项
都有对应 primary 且 content/provenance hash 相等；**仅当前 primary 与本 run 新建的 change
Issue** 的溯源引用本次 `--spec-pr` 的 `Provenance.merge_commit_sha`，历史 change Issue
保持创建时证据、不要求刷新；orphaned reconciliation 动作 / unmanaged 列表；"Projects view"条目输出为
manual 提示（D22）。

## 6. `sdd impact` 扩展（affected_issues / suggested_change_issues）

### 6.1 接口与时机

```bash
sdd impact --base <sha> --head <sha> --repo <owner/name> --with-issues [--format json|text]
```

- `--with-issues` 仅 API 模式可用（要读产品仓 Issues；本地 git 模式给出明确错误）。
  CI 的 `detect` 永不传它（m4 §5.3）；publish 不调用它（publish 的分类走 D18，输入是
  编译出的完整任务集而非 base..head 差量——两条路径共享 D8 状态模型与 §6.3 判定函数，
  但驱动数据不同，显式区分防混淆）。它的受众是人：评审 Gate PR / 排期前看"这次变更
  会波及哪些已发布任务"。
- 组合方式（D17）：`computeImpact` 原样先跑（M4 契约零改动，含 `changedPaths` 注入
  参数），其输出 + D11 索引 → `annotateImpactWithIssues` 填充两个数组。M1 schema
  不动（文首已核对 item 结构够用）。

### 6.2 反查

对索引中每个 primary Issue：解析受管区域 references 清单（§4.1 round-trip 保证可解析；
解析失败的 Issue 计入 warning 并跳过——它多半被人改坏了受管区，宁可少报不误报）→
与 `changed.{requirements,screens,operations}`（m4 D20 semantic diff 的产出）求交集，
非空 → 该 Issue 受影响。

### 6.3 分类（与 publish 共用的判定函数）

- `affected_issues[].change`：状态 `not_started` → `update`；其余状态下，task 的
  references.operations 与 base..head 的 **removed operations**（m4 D20 operation diff
  的 `removed` 集）交集非空 → `migration`，否则 → `change`。Migration Issue 在存储上仍是
  role=change/type:change，只是 kind 与正文不同，因此不违反 §10.2 的 Change Issue 形态。
- `suggested_change_issues[]`：仅为 change/migration 的受影响 Issue 生成
  `{task_id, platform, kind, reason}`（update 不是新 Issue，不进该数组——与 M1 schema
  的 kind 枚举无 update 一致）；reason = 命中的源 ID 清单 + 状态依据（人读的一句话）。
- **§12.14 的 M5 半边到此为止**：M4.5 保证 breaking 合同不静默合并（检测半边）；M5
  保证 breaking 落地后，引用被删 operation 的已发布客户端/后端任务在下一次
  `--with-issues` 报告中变成 migration 建议，并由 publish 的 orphan reconciliation
  pass（task 已消失时）或当前 task 分类（task 仍存在时）创建幂等 Migration Change Issue。
  M5 **不**在合同合并时刻做任何拦截（那是 M4.5 的 CI 位面），也**不**自动改写客户端
  代码任务的验收标准（migration Change Issue 是给人的工作项）。

## 7. dry-run 报告（`compile` 输出契约，M2 D12 全套约束）

```json
{
  "plan_version": 1,
  "operation_id": "sha256:<64-hex>",
  "target": { "repository": "acme/demo", "version": "v1", "source_revision": "<40-hex>" },
  "authorization": { "verified": false, "reason": "no approval references supplied",
                     "gates": { "spec": null, "architecture": null, "design": null,
                                "plan": null, "contract": null } },
  "tasks": [ { "id": "backend.api.login-user", "platform": "backend", "track": "code",
               "title": "...", "references": {"operations": ["loginUser"]},
               "depends_on": ["common.contract.login-user"],
               "action": "create|update|refresh-metadata|noop|ensure-change|ensure-migration",
               "issue": 42, "state": "not_started", "content_hash": "sha256:...",
               "provenance_hash": null,
               "diff_summary": ["title", "acceptance"] } ],
  "graph": { "edges": [ ["backend.api.login-user", "common.contract.login-user"] ],
             "cycles": [] },
  "orphaned": [ { "task_id": "ios.screen.legacy", "issue": 17,
                    "action": "report|ensure-change|ensure-migration" } ],
  "unmanaged_or_broken": [],
  "labels_to_create": ["platform:common"],
  "codeowners_affected": [ { "platform": "backend", "path": "apps/backend",
                             "owners": ["@acme/backend-team"] } ],
  "warnings": []
}
```

- §6.7 条目逐项落位：建/改/不变的 Issue（`tasks[].action`）、stable ID、平台标签
  （platform 字段 + labels_to_create）、requirement/screen/operation 引用、依赖图与
  环检查（graph）、预计影响的 CODEOWNERS（projects.yaml 的 component path × source_
  revision 下 CODEOWNERS 的匹配 owner；common 任务映射 `/contracts/` 的 owner）。
- 授权未验证（示例中的 `authorization.verified=false`）时无法计算可信 provenance-hash：
  字段为 `null`，content action 仍照常给出，但 classifier 不声称 metadata no-op/refresh，
  在 warnings 标注 `metadata action unknown until authorization succeeds`。`--execute` 的
  授权硬门保证真实写入路径永远拿到非空 provenance-hash 与确定 metadata action。
- 确定性：canonical JSON（UTF-8/LF/两空格/固定 key 序；tasks 按 id、edges 按字典序、
  其余数组按注明键排序）；`operation_id = sha256(JCS({target, tasks 的 {id,content_
  hash,provenance_hash,action}, graph}))`；无时间戳/请求 id/token；相同输入（含产品仓 observed Issue
  状态）两次运行 **byte-identical**；text 输出只是 renderer。零 mutation 由读写 port
  类型隔离保证（compile 只见 `IssuesReadPort`，M2 的同款手法），测试在传输层断言
  mutation count=0。
- `diff_summary` 只列**变化的字段名**（title/scope/acceptance/references/depends_on），
  不内嵌新旧全文——报告保持可 diff 的紧凑；逐字对照由人拿两个 revision 的源文件看
  （报告里有两边 hash 与 revision，链路齐）。

## 8. 测试

- **slug / ID**（纯函数表驱动）：§1.2 全部示例；`loginUser` vs `login_user` 碰撞 →
  D4 硬失败且报告双方源；`REQ-API-001` 不与 api 族碰撞（kind 保留字回归）；slug 结果
  为空/非法 → fail closed。
- **strategies / 编译确定性**：固定 fixture（spec/design/openapi/projects）→ 任务集
  快照测试；同输入 byte-identical；design §8 映射表缺失 → screen 任务 operations 空 +
  warning；无 UI（design 缺失）→ 屏幕族空；无合同 → 合同/api 族空；declared-未
  scaffold 平台照常出任务（D6 回归）。
- **归并**：悬空 depends_on → 报错含目标 ID；人为构造含环任务集 → 报错含完整环路；
  自环覆盖；两个全新且有依赖的 task 发布时断言依赖 Issue 先创建，依赖者正文链接到其真实
  Issue 编号，依赖创建失败时依赖者零写。
- **状态模型**（表驱动）：四态 × {assignee, linked-PR, 两者, 皆无} × {open, closed+
  completed, closed+not_planned}；fork 仓 PR 引用不算 in_progress；timeline 只对
  hash 不等的 Issue 拉取（fake port 断言调用集合）。
- **marker / render round-trip**：渲染→解析 references 清单还原；受管区人工污染 →
  update 后恢复；缺 end 标记的损坏态；unmanaged（缺 marker）不入索引；**provenance
  小节变化不改变 content-hash、但改变 provenance-hash 并只产生 refresh-metadata**；刷新后
  同输入零写；60000 字符守卫。
- **D18 分类 × §10.2**（表驱动，publish 与 --with-issues 共用函数）：当前 task 六岔路
  全覆盖；orphan pass 覆盖四态，旧 operations 已从当前 extractor 集合消失 → migration，
  其它源/平台移除 → change 或仅 report（not_started）。
- **幂等 / 崩溃注入**（mock IssuesWritePort，镜像 M2 失败注入矩阵）：在 ensure-labels
  后 / 第 k 个 create 后 / update 前后 / change-issue 前后各注入崩溃 + 同输入重跑 →
  最终状态与一次成功执行逐 Issue 相等、写调用总数无重复 create；同 revision 二次运行
  → 零写（§12.9）；D20 三元组：同 revision 重跑不重复 change issue，revision 前进后
  产生新 change issue；create POST 服务端成功但客户端超时 → 重建索引命中、不得二次 POST，
  primary 与 change 两类各一例。
- **索引**：分页含 PR 混入 → 正确过滤；同 task 两个 primary → exit 5 且零任务写；
  Search API 出现在实现里 → 无此调用（静态断言 import/调用面，防某天有人"优化"）。
- **授权矩阵**（mock octokit + 真 verifyGateApproval 接线，沿 M3 风格）：五路各自
  fail → exit 7 零写；design 跳过两层证据——只编辑 PR body 不作数、plan.md 无机读块/
  reason 为空/design.md 存在分别 fail，两层齐 → 过；contract 存在性
  驱动必填——文件在而缺 `--contract-pr` → exit 2、文件不在而给参 → exit 2、文件在 +
  evidence 缺（M4.5 未落地模拟）→ exit 7；dry-run 同输入全部照常出计划零写（M3 D7
  边界回归）。
- **freshness / canonical / 重放**：三个 freshness guard 分别覆盖初始失配、首写前前进
  （零写）、写入期间前进（已有前缀但最终 exit 7，按新 HEAD 重跑收敛）；非 canonical repo
  输入 → guard exit 7。另以静态/集成断言确认 concurrency group 大小写不敏感，不再测试
  “大小写拿两把锁”的错误前提。
- **--with-issues**：computeImpact 的 mock 输出 + 固定索引 → 两数组填充符合 §6.3；
  过 `validateImpactDocument`；无 `--repo` / 本地模式 → 明确报错；detect 代码路径不
  引用 annotate（静态断言，m4 §5.3 的守卫）。
- **workflow YAML 静态守卫**（镜像 M2 D8/m4 §6 风格）：concurrency group 表达式含
  `inputs.product_repo` 且 `cancel-in-progress: false`；job 绑定 `environment:
  backlog-publisher`；inputs 集合与 §5.1 一致；App 权限/测试 fixture 证明 token 可读
  Actions run metadata，从而满足 M4.5 D11。
- **隔离 org E2E**（真 workflow + 测试产品仓，复用既有 harness）：完整 publish →
  Issues/labels/marker/溯源齐全 + 核验报告过；**同输入二次触发 → run 成功且零写**
  （§12.9）；**两次快速连续触发 → 第二个 run 处于 queued 直到第一个完成**（§12.10）；
  修改 spec 的未开始任务 → dry-run 显示 diff、publish 后 body 更新（§12.11）；给
  Issue 加 assignee 后再变更 → 原 Issue 不动、Change Issue 建立（§12.12）；杀死
  publish run 中途重跑 → 收敛无重复；旧 revision 重放 → freshness 拒绝；（M4.5 落地
  后）含合同产品全链路 + 删 operation → done 任务收到 migration 建议（§12.14 联合）。

## 9. 交付文件树

```text
sdd-platform/
├─ backlog-compiler/
│  ├─ package.json（占位 → 真实：依赖 @sdd/schemas、@sdd/provenance、yaml）
│  └─ src/
│     ├─ index.ts                 # 稳定导出面
│     ├─ types.ts                 # Task/CompiledBacklog/PlanEntry/IssueIndex/状态枚举
│     ├─ slug.ts                  # §1.2
│     ├─ extract.ts               # 源提取（复用/对齐 m4 D20 extractor + design §8 映射）
│     ├─ strategies.ts            # 四族生成（§2.1）
│     ├─ reconcile.ts             # D4 唯一性 + D5 悬空/环
│     ├─ compile.ts               # compileBacklog（纯函数，§2.2）
│     ├─ marker.ts · render.ts    # §4.1/4.2（round-trip 成对）
│     ├─ state.ts                 # D8 状态推导
│     ├─ issue-index.ts           # D11 全量索引 + 不变量
│     ├─ classify.ts              # D18 当前 task 六岔路 + orphan pass（与 --with-issues 共用）
│     ├─ plan.ts                  # dry-run 报告组装 + canonical JSON + operation_id（§7）
│     ├─ publish.ts               # --execute 流水（§5.3）+ 发布后核验（§5.6）
│     ├─ authorize.ts             # §5.4 完整输入集校验（组合 @sdd/provenance）
│     ├─ impact-issues.ts         # annotateImpactWithIssues（§6）
│     └─ ports.ts                 # IssuesReadPort / IssuesWritePort / ProductSource
├─ cli/src/commands/backlog/{compile,publish}.ts + test/**
├─ cli/src/commands/impact.ts     # 增 --with-issues（M4 文件的增量）
├─ templates/monorepo-root/specs/_template/plan.md # sdd:design-skip 机读块说明
└─ .github/workflows/backlog-publish.yml   # §5.1
```

## 10. M5 完成定义（DoD）

- `compileBacklog` 确定性（byte-identical）、D4/D5 硬失败路径、四族生成规则全部测试
  覆盖；task ID 与既有 task.schema.json / impact.schema.json **零 schema 改动**。
- `sdd backlog compile` 产出 §7 报告：§6.7 条目齐全、canonical JSON、operation_id
  稳定、零 mutation（传输层断言）、text 只是 renderer；授权引用给/不给两态都如实报告
  且照常出计划。
- `sdd backlog publish`（本地）只 dispatch 不直写；`--execute` 在授权矩阵任一失败时
  exit 7 零写；五路映射（含 design 双层 skip 证据、contract 存在性驱动必填）与
  freshness/canonical guard 全部测试覆盖。
- upsert 全链路幂等：同 revision 重跑零写（§12.9）；崩溃注入矩阵全过；并发第二 run
  排队（§12.10，E2E）；创建类 POST 歧义结果经索引重查不重复；三次 freshness guard；
  §12.11/§12.12 行为逐字达成；发布后核验（§5.6）实现 §6.8 清单并在违规时失败。
- content 与 provenance 使用分离 hash：仅批准链变化只 refresh metadata，不创建 Change
  Issue，刷新后同输入零写，发布后 provenance 核验一致。
- Change/Migration Issue 按 D20 三元组幂等；orphaned 不删除，按 D18 对已开始/完成任务
  reconcile，删除 operation 的 backend/common task 不会漏掉 migration；unmanaged/损坏
  marker 的处置符合 §4.2。
- `sdd impact --with-issues` 填充两数组、过 schema 校验、不改 `computeImpact` 契约、
  `detect` 路径零引用（静态守卫）。
- workflow：concurrency 按产品串行 + canonical guard 双防线、App 凭据在受保护环境、
  产品仓零 workflow 文件新增；YAML 静态守卫通过。
- 隔离 org E2E 全组场景通过；工作区全绿（frozen install + build/typecheck/test/lint、
  无生成漂移）。

## 11. 验收映射与依赖

**§12 场景**：**§12.9**（同输入两次/失败重跑不重复）→ D18/§5.5 + E2E；**§12.10**
（并发第二个等待）→ D12/§5.1 + E2E；**§12.11**（未开始只生成可审查 diff）→ D9/§7
`diff_summary` + update 语义；**§12.12**（进行中创建 Change Issue）→ D9/D20；
**§12.14（后半）** → §6.3 末条（前半在 M4.5）。

**依赖 M1（已合并）**：task/impact schema（零改动消费）、`verifyGateApproval` +
`GitReader`、`sdd validate`。**依赖 M2（已合并）**：label 体系与 desired-state 只增
不删惯例、`withRetry`/分页（创建类 POST 除外，须先索引重查）、D12 确定性模式、marker 行解析风格。**依赖 M3（方案契约）**：
`createLocalGitReader`、退出码 7、D7 dry-run 边界。**依赖 M4（方案契约）**：
`computeImpact`/`ImpactReader`/`changedPaths`、D20 extractor、`detect` 不读两数组。
**依赖 M4.5（同批未评审初稿）**：evidence 链与唯一溯源不变量（m4.5 §6.3）——其评审
变更需回灌本文 §5.4。

### 11.1 实现前必须已合并的先行补丁（与 m3/m4.5 的表合并追踪）

| # | 内容 | 来源 | 对 M5 的意义 |
|---|---|---|---|
| 1 | `verify.ts` gate label 存在性 | m3 §9.1 #3 | 五路校验全部依赖——缺它时"CODEOWNER 批准过该文件"即可冒充任意 Gate |
| 2 | `strict_required_status_checks_policy` 拼写 | m3 §9.1 #4 | Gate PR 批准绑定最终 head 的防线之一（provenance 第 1 步的运行环境假设） |
| 3 | `verifyContractGateCheck` 反查受信 workflow identity + 最新 attempt | m4.5 §10.1 #1 | contracts 路 evidence 的防伪 |

**上层文档修订（评审通过时一并执行）**：runbook §6.8 的 concurrency YAML 片段改为
平台仓宿主形态（group 含目标产品仓标识，D12.1 的调和结果）。

## 12. 不在 M5 范围

- Contract Gate workflow 本身 → **M4.5**（本文只消费其 evidence）；provider
  conformance → **M6**；release/签名 → **M7**；`sync --check` → **M8**。
- **Projects 看板自动化**（D22 定界：label 支撑 view 过滤，§6.8 该条为 manual 核验项）。
- Issue 的自动关闭/删除（orphaned primary 保留；已开始/完成者可按 D18 另建 Change/
  Migration Issue）；跨产品仓 backlog；Epic 语义
  （`type:epic` label 保留不用）；per-REQ 任务的精细平台归因（D6 的保守选择，收窄
  需要模板层引入 REQ↔平台映射，属未来里程碑）；`contracts/events.yaml` 的读取与校验
  （§5.4 显式记录）。
- 本地直写 publish（D14——不是缺功能，是拆防线）。

## 13. 待决事项（实现前需确认）

1. **`backlog-publisher` 环境是否加 required reviewers**：branch policy=main 已挡分支
   版本窃 secret；再加人工放行会把每次 publish 变成两步——倾向不加（publish 本身幂等
   且授权校验硬），运维层再议。
2. **App 铸 token 的 action 选型与 pin**（`actions/create-github-app-token` 或库内
   octokit App auth）：实现时按 M2 D10"第三方 action 固定完整 SHA"择一。
3. **timeline API 的 preview header 现状**：`GET /issues/{n}/timeline` 历史上要求
   preview accept header，实现时核实当前版本要求。
4. **Issues 列表端点对 issue 总量极大仓库的页数上限取值**（D11 防御上限的具体数字）。
5. **extractor 的包边界**：m4 D20 的三个 semantic extractor 按 m4 §4.3 落在
   `@sdd/factory`（`impact.ts`）；本文 `extract.ts` 复用它们意味着 backlog-compiler
   依赖 factory，或把 extractor 提升到更小的共享位置（如 schemas 侧/独立小包）。实现
   时按 M4 落地后的真实形态择一——**硬约束只有一条：两处不得各持一份解析实现**（m4
   D16"两处正则漂移"教训的同款）。design.md §8 映射表的 canonical 行格式与 screens
   extractor 的表格解析同源，一并决定。
6. **是否增设 `type:migration` label**（D21）：当前用 `type:change` + kind 字段区分；
   看板过滤若需要一等 label，加法是 desired-state 一行。
7. **run-name 长度/字符**：`product_repo@sha` 的 run-name 是否需截断处理（GitHub
   上限），实现时核实。

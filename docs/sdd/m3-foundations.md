# M3 实施细案：Scaffold 平台骨架（含授权校验）

> 本文是 [implementation-plan.md](implementation-plan.md) 中 **M3** 里程碑的文件级实施方案，
> 评审通过后据此交 Codex 实现。M3 完成 = 能对 **Architecture Gate 已批准、已合并**的
> `projects.yaml` 执行 `sdd product scaffold`：只为获批的 component 生成对应平台目录
> （`spring-boot` / `web` / `ios-tuist` / `android` 之一），经 **Scaffold PR** 落地（不直推
> `main`），且每个生成目录都能被审计追溯到批准它的 Architecture Gate PR。
>
> 依据手册（[single-repo-implementation-runbook.md](single-repo-implementation-runbook.md)）
> §6.3–6.4（Architecture Gate / Scaffold PR）、§4.1（templates 目录）、§4.6（模板生命周期）、
> §5（bootstrap 模板与机制）、§7（实现与 Review）、§12.3–12.4；以及 implementation-plan
> §1（贯穿性授权溯源——**M3 是首个强制点**）、§M3、§3（先搭会走路的骨架）、§4（关键风险，
> 尤其"授权校验要校验合并态 + 实际审批而非文件存在"）。格式与详细程度对齐
> [m1-foundations.md](m1-foundations.md) / [m2-foundations.md](m2-foundations.md)。
>
> **依赖状态说明**：M1（schemas / `sdd validate` / `@sdd/provenance`）已实现并合入 `main`
> （PR #2）。M2（factory `product init`）的文件级方案（m2-foundations.md）已作为规划文档合入
> `main`（PR #3），但其**代码实现**（M2a 模板/manifest/plan/dry-run、M2b Git Data bootstrap、
> M2c labels/ruleset/Bootstrap PR/gate hygiene）目前在 `m2-foundations` 分支，尚未合并
> `main`。本文所有对 `@sdd/factory`、`@sdd/provenance` 接口的引用均已实机核对该分支当前代码
> （`factory/src/{types,resolve,render,init,github-read,github-write}.ts`、
> `cli/src/{local-reader,commands/product/init}.ts`、`scripts/build-template-manifest.ts`、
> `provenance/src/{types,verify}.ts`——后者已合入 `main`，是权威、稳定的接口）。**Codex 实现
> M3 前必须以最终合并的 M2 代码重新核对每个引用的类型/函数签名**；本文标注的"需要对 M2 factory
> 做的接口调整"（见 §0 D2/D4/D8）是明确的实现前置任务，不是可选项。
>
> 经核对，implementation-plan.md 当前版本已将 Contract Gate（M4.5）与 provider conformance
> （M6）拆分，未见"M6 — Contract-first"合并写法；m2-foundations.md §9 中的待校正记录已过期，
> 本文不再复述。
>
> **本版（第 2 稿）据评审修正 5 处 P1 + 1 处 P2**：新增 main 新鲜度校验防止旧 Architecture
> Gate 被重放（D18）；`template_ref` 收紧为必须是 40-hex commit SHA（D19，需要一处 M1
> schema 前置补丁）；修正 scaffold 分支/PR 的幂等模型，改为"一旦存在即纯复用"，不再尝试对
> main 已前进的情形做非 force fast-forward（D20）；统一目录/lock 位置/CODEOWNERS 匹配只认
> `component.path` 原值，不再由 `id` 推导（D21，此前"apps/&lt;id&gt;"式简写在 id≠path
> 时会算错目录）；纠正"`verifyGateApproval` 会强制要求 gate label 存在"的错误描述——实际
> 现状只查冲突不查缺失，需要一处 M1 代码补丁（D22，见 §3.5）；`owner` 收紧为必须是已校验的
> team slug 并改用 `team_reviewers`（D23，需要另一处 M1 schema 前置补丁）。三处 M1 前置
> 补丁汇总在新增的 §9.1。
>
> **本版（第 3 稿）据评审修正 3 处 P1（均针对第 2 稿新引入的机制）+ 2 处非阻塞文档问题**：
> D18 的 main 新鲜度校验只在 scaffold **运行那一刻**成立，Scaffold PR 从打开到人工合并
> 之间 main 仍可能被新 Gate 改写而不产生冲突（TOCTOU）——新增 D24：`sdd-main` ruleset 加
> `strict_required_status_checks_policy` + `PR hygiene` 新增 Scaffold PR 专属规则，在
> "合并前要求分支最新"触发的重新检查里核对 main 当前状态（§3.6）；D20 第 2 稿的修复本身
> 自相矛盾（"分支存在无 PR"被判 `conflict`，却又要求该场景收敛）且未校验复用内容的完整性
> （分支被篡改也会被盲目接受）——重写为"任何复用前先做只读内容校验，通过才复用/补建 PR，
> 不通过才是 `conflict`"，统一解决两个问题（§2.3）。另修正两处文档准确性问题：
> `template.lock.approved_by` 示例补上 `required_checks` 字段（§4）；"复算恒定成功"改为
> 准确描述 `current-codeowners` 的可撤销语义——复算是"按当前标准重判"，批准人事后离职/被
> 移出 team 会让同一个 PR 的复算合法地变成 `ok:false`，这是策略本身的设计，不是异常
> （§3.4）。
>
> **本版（第 4 稿）据评审修正 3 处 P1（第 3 稿引入的 D20/D24 本身的实现细节问题）**：
> `output_sha256`（`sha256(content)`）与 Git 对象自己的 blob SHA（`sha1("blob "+len+
> "\0"+content)`）是两个不同哈希函数、不同输入前缀，第 3 稿把"tree 里查到的 blob SHA"
> 直接与 `output_sha256` 比较，这个比较对任何输入恒为假——校验从未真正生效过；同时"计划
> 外路径"缺一个可执行定义（完整 tree 因 `base_tree` 继承必然含全仓库其余内容）。新增
> **D25**：统一的"component 子树完整性校验"原语——严格限定在每个 pending component 的
> `path` 子树内、按 blob SHA 取回实际内容后计算 `sha256(content)` 与 `output_sha256`
> 比较（不比较 Git blob SHA），子树内文件集合须与期望完全相等；D20 与 D24 都改为调用
> D25，不再各自描述（此前不一致）的校验逻辑。另外，D24 的 merge-time hygiene 此前只
> 核对新增 `template.lock` 的元数据与当前 main 的 `projects.yaml`，从未验证 PR 实际
> 文件与 lock 声明的 `output_sha256` 是否一致——若攻击者能同时篡改应用文件和对应
> `template.lock` 的 `output_sha256`（让两者继续对得上），原设计查不出来；修复为 hygiene
> 独立按当前 main 的 component 信息重新渲染（不读、不信 PR 自己的 `template.lock`），
> 再用 D25 核对 PR head 实际内容。另收紧 D20 的 PR 复用逻辑：查到候选 PR 后显式核对
> `base.repo`/`base.ref`/`head.repo`/`head.ref` 而非只凭同名 head 分支判定，并直接复用
> 该次响应的 `head.sha`、不再另外读分支 ref，避免两次读之间的竞态。
>
> **本版（第 5 稿）补齐 merge-time 独立重渲染的两个可信输入**：第 4 稿虽然不再信任 PR
> 自带的 `template.lock`，但仅凭当前 `projects.yaml` 仍无法重建 lock 中的 `approved_by`，且
> 没有保证 scaffold CLI 与 required `PR hygiene` workflow 使用同一版渲染器。新增 **D26**：
> （a）generator 构建必须嵌入平台仓完整 commit SHA，scaffold preflight 将它与产品仓 required
> workflow 的 pinned SHA 对齐并写入 lock；（b）M3 要求 Architecture Gate PR 必须带明确的
> `version:<v>` label；（c）hygiene 只把 lock 里的 PR 号当候选 locator，重新调用
> `verifyGateApproval` 得到可信 Provenance，再用同一 pinned generator commit 重建完整 lock。

## 0. 已定决策

沿用 M1/M2 已定的运行时与工具链（Node 24 LTS + TS strict、pnpm/tsup/vitest/oclif/biome、
可复现构建、GitHub 写操作走 Git Data/Contents API、provenance 只认 PR/merge 元数据、dry-run
确定性 + canonical JSON + operation_id、teams 只校验不创建、不建仓内账本）——这套约定用于
**平台仓自身**（`@sdd/factory`、`@sdd/cli` 等 TS 包）。**四个平台模板生成的应用代码是独立
技术栈**，各自的工具版本在 §1 单独锁定，与平台仓的 TS 工具链无关。M3 新增决策：

- **D1 — 四个平台模板的技术栈**：`spring-boot`→Java 21 LTS + Gradle；`web`→TypeScript +
  Vite + pnpm；`ios-tuist`→Swift + Tuist（模板名已由 M1 `projects.schema.json` 的
  `template` enum 锁定，非本文新决策）；`android`→Kotlin + Gradle。每个模板的具体锁定版本
  见 §1 各节表格；**版本号在实现时可按当时最新稳定版微调，但工具选型与"必须锁定 + 可复现"
  的机制不可变**。
- **D2 — 四个模板复用 M1/M2 的 manifest/checksum 机制，但需要两处 factory 接口放开**：
  1. `TemplateManifest.template` 当前在 `factory/src/types.ts` 是字面量类型
     `'monorepo-root'`，且 `resolve.ts` 的 `validateManifest`/`parseManifest` 各有一处硬编码
     `manifest.template !== 'monorepo-root'` 校验；`render.ts` 的 `renderTree` 在构造
     `template.lock` 时也硬编码 `name: 'monorepo-root', path: 'templates/monorepo-root'`。
     三处都需要改为从**闭集** `TEMPLATE_NAMES = ['monorepo-root', 'spring-boot', 'web',
     'ios-tuist', 'android']` 校验，并让 `renderTree` 从入参（而非字面量）取
     `name`/`path`。这是**必要的 M2 factory 接口调整**，不是另起炉灶——§2.4 详述。
  2. `scripts/build-template-manifest.ts` 当前硬编码 `TEMPLATE_ROOT = 'templates/monorepo-root'`
     和 `MANIFEST_PATH`，需要参数化为 `--template <name>`，对四个平台模板各生成一份
     `templates/<name>.manifest.json`，而不是复制四份脚本。
- **D3 — Scaffold 是"create-only per component"**：已存在的 `path`（即 `component.path`，
  已含 `apps/` 前缀，见 D21）目录，无论
  `projects.yaml` 里对应 `template_ref` 是否变化，scaffold 永远视为 `noop`——不覆盖、不更新、
  不删除。`projects.yaml` 中消失的 component（架构变更移除平台）同样不触发删除，只产出
  `warning`。理由：呼应手册 §4.6"不自动把模板新版本覆盖进 `apps/*`"；删除/覆盖已生成代码是
  破坏性操作，超出 scaffold 单一职责，未来版本升级或移除属于人工 PR 或 M8 sync 的范畴。
- **D4 — Scaffold 需要一个新的、与 `publishSnapshot` 语义相反的写操作**：M2b 的
  `publishSnapshot` 显式禁止 `apps/*` 路径（防止 `product init` 意外写入平台代码，见
  `github-write.ts` "Validate no apps/\* paths" 与 `init.ts` 中的重复校验）；scaffold 需要的
  写操作恰恰**只**允许 pending components 各自 `path` 之下的 `**`。因此 M3 新增
  `publishComponentBranch` +
  `upsertScaffoldPull`（结构上复刻 `publishSnapshot`/`upsertBootstrapPull` 的 Git Data
  blob→tree→commit→非 force ref 前进模式），但：(a) `base_tree` = **当前 `main` 的实际
  tree**（不是 seed tree），(b) 写入目标是**新分支**而非 `main`，(c) 路径 allowlist 取反为
  "只允许 pending components 的 path 前缀"。见 §2.3。
- **D5 — Scaffold 只开 PR，不直接推 `main`，且没有 `--finalize-protection` 式的第二阶段**：
  scaffold 不改 ruleset/required checks——M2 的 `sdd-main` ruleset 在 `--finalize-protection`
  后已经要求 PR + CODEOWNER + `CI Gate`/`PR hygiene`，Scaffold PR 原生走这条已有路径。
  **唯一例外见 D24**：`sdd-main` 的 `required_status_checks` 规则需要补一个既有参数
  （`strict_required_status_checks_policy: true`），这是对 M2 现有 ruleset 配置的一处小
  补丁，不是 M3 自己新建保护资源。
- **D6 — 授权校验用显式 `--architecture-pr <n>` | `--architecture-merge-sha <sha>`
  （二选一）+ `--architecture-version <v>`**，直接映射 `@sdd/provenance` 的 `ApprovalRef`
  联合类型（`provenance/src/types.ts`）；**不做"按 label 自动搜索候选 PR"**——label 只辅助
  校验一致性，不用于定位（M1 §4 point 2 / plan §1）。M1 文档提到的 `listGateApprovals`
  候选发现帮助函数本身"非 M1 强制"且从未实现；M3 同样不将"自动发现"做成默认路径，见 §3.1。
- **D7 — dry-run 与真实执行共用同一个只读 `verifyGateApproval` 调用，但 fail-closed 边界
  不同**：`verifyGateApproval` 全程只读（`octokit.rest.pulls.get/listReviews/listFiles`、
  `repos.getBranch`、`checks.listForRef`、`teams.*` 均为 GET），调用它**不违反 M2 D12 的
  dry-run 零写约束**。因此 dry-run 与真实执行都发起真实校验、如实报告 `verified`/`reason`；区别在于：
  dry-run 无论 `verified` 是 `true` 还是 `false` 都照常输出完整计划（未批准输入也可预览，
  醒目标注），**只有真实执行在 `verified=false` 时 fail closed、不产生任何写**（含分支/
  commit/PR）。这与 M1 对 `compile --dry-run` 的既有原则一致（"可用于 Gate 评审，但必须醒目
  标注未批准输入，且不得产生 GitHub 写操作"）。见 §3.3。
- **D8 — `@sdd/provenance` 的 `GitReader` 接口目前没有任何具体实现**（`provenance/test/`
  下只有 mock）；M3 需要交付第一个真实实现 `createLocalGitReader(repoRoot)`（CLI 侧，
  shell out 到本地 `git`），服务于**产品仓的本地 worktree**。这与 M2 `cli/src/local-reader.ts`
  的 `createLocalFsReadPort`（读**平台仓**模板字节，实现 `GitHubReadPort`）是两个不同方向、
  服务不同接口的适配器，命名和职责都不应混淆或合并。见 §3.2。
- **D9 — per-component 生成溯源写入 `<path>/template.lock`（不是扩展根 `template.lock`）**：
  schema 复用 M2 根 lock 的字段形状，新增 `component` 与 `approved_by` 两个块；
  `approved_by` 直接持久化 `verifyGateApproval` 返回的 `Provenance` 对象，把"这个目录被哪个
  PR/commit 批准"焊死在生成物旁边，供人工审计与 M8 sync 复算。owner 已经在 M2 Bootstrap PR
  阶段的 CODEOWNERS 里预注册（`/apps/backend/ @org/backend-team` 等），M3 不需要再碰
  CODEOWNERS。见 §4。
- **D10 — 平台模板不包含任何 `.github/workflows/*`**：把 M2 D7"产品仓不放 gate workflow"
  的原则推广到**全部**四个平台模板——不仅是根骨架。每个模板对外只承诺一组固定的本地命令
  （lint/typecheck/test/build 各一条，见 §1 各表），供 M4 未来的 reusable workflow 调用；
  产品仓 `apps/*` 里不出现任何 workflow 文件，避免新增可被产品 PR 编辑的"伪造入口"。见 §5。
- **D11 — Scaffold 分支名/PR 是"当前待生成 component 集合"的函数**，不是永久固定名（不像
  `sdd/bootstrap` 只用一次）：`sdd/scaffold-<operation_id 前 12 位 hex>`。同一批待生成
  component 重复运行收敛到同一分支/PR；PR 合并后，若后续 Architecture Gate 又批准了新平台，
  下一次 scaffold 因 pending 集合变化而计算出新的 `operation_id`/分支名，不会与已合并/关闭的
  旧分支冲突。见 §2.3。
- **D18 — 授权校验必须同时钉住"当前 main"，否则旧 Architecture Gate 可被重放**：
  `verifyGateApproval` 只证明"本地 worktree 内容 == 指定 PR 批准的内容"，不证明"这仍是
  main 当前内容"。若调用者的本地 checkout 落后于（或被人为回退到）一个已被后续 Architecture
  Gate 取代的旧版本，仍可引用那个旧 PR 号让校验通过，进而按该旧版本的 component 列表生成
  骨架——即使 main 上现行的 `projects.yaml` 早已不同（例如后续 Gate 已经移除或改写了该
  component）。scaffold 必须在 preflight 里新增一步：读取远端 main 当前 HEAD 的
  `projects.yaml` blob SHA（复用 §2.3 读 main tree 那一步的同一次读，无需额外 API 调用），
  并要求它与本地 worktree 的 blob SHA（`git.blobWorktree` 同一算法）完全一致；不一致 →
  fail closed，退出码 `7`，报"projects.yaml 与远端 main 当前版本不一致（本地可能落后，或
  已有更新的 Architecture Gate 批准）"。这一步与 `verifyGateApproval` 的"本地 == 指定 PR"
  检查相加，构成"main 当前内容 == 本地 worktree == 指定 PR 批准内容"的完整链条，堵住重放
  旧批准的路径。见 §3.3。
- **D19 — `template_ref` 必须是完整 40 位 commit SHA，否则不是真正的 pin**：M1
  `projects.schema.json` 当前 `components[].template_ref` 只要求 `minLength: 1`，允许
  任意字符串（如可移动的 tag/branch 名）。Architecture Gate 批准的是 `projects.yaml` 这份
  **文本**（含字符串 `"v1.0.0"`），而不是它在某一时刻解析出的 commit；若该 tag/branch 在
  批准之后、scaffold 执行之前被重新指向别处，生成的模板内容就不是 Architecture Gate 审阅者
  实际见过的内容，却仍然通过全部校验。修复：**要求 `template_ref` 匹配 `^[0-9a-f]{40}$`**
  （与 `factory/src/resolve.ts` 现有的 `isFullCommit`/`COMMIT_RE` 判定同一格式），即写死为
  不可再移动的完整 commit SHA。这不是新原则——`product init` 的 `--platform-ref` 在真实
  执行时已经要求"统一解析为完整 40 位 commit 并钉死，禁止默认到可移动 ref"；D19 只是把同一
  原则从"CLI flag"搬到"schema 字段"，因为 `template_ref` 活在需要长期审计的 `projects.yaml`
  里，比一次性 CLI 参数更需要不可变性。**这是 M3 实现前必须先合并的 M1 schema 变更**
  （见 §9.1），当前无生产 `projects.yaml` 实例，改动零迁移成本。resolve 步骤相应简化：不再
  需要 annotated tag peel，只需确认该 SHA 在平台仓可达并读出其 tree。
- **D20 — Scaffold 分支/PR 一旦"内容验证通过"即复用，绝不盲目重建、也绝不盲目信任
  （修正幂等模型，第 2 稿修复自相矛盾）**：若 scaffold 分支的构建逻辑在"已存在"分支上尝试
  "非 force 前进"，会在 main 于两次调用之间前进后失败——旧 commit 的 parent 是旧 main
  tip，新一次调用基于新 main tip 生成的是**兄弟 commit**（不是旧 commit 的后代），非 force
  fast-forward 天然做不到，从而被误判为 `conflict`，即使内容本该收敛为 noop。
  **第 1 稿的修复本身有两个问题，此处一并修正**：(a) "分支存在但没有对应 PR"被无条件判
  `conflict`，但这恰恰是"`createRef` 成功、创建 PR 前崩溃"的正常中间态，与 §6 要求该场景
  前向收敛的测试直接矛盾；(b) "找到 `open` PR → 直接复用"没有验证该 PR/分支的实际内容，
  分支被人工（或攻击者）事后改写也会被无条件接受。

  修复：**任何时候观察到该分支名对应的 ref 或 PR 已存在**（不论是否找到 PR），**先做一次
  只读内容校验**，再决定下一步：
  1. **查候选 PR，并验证其身份**（第 3 稿新增，回应"仅凭同名 head 查错 PR"的问题）：用
     `GET /repos/{owner}/{repo}/pulls?head={owner}:{branchName}&state=all` 查询（`head`
     参数本身已经把 owner 限定在目标仓，不会查到 fork 上同名分支开出的 PR）；对返回的
     每个候选，**显式核对**（不只信任查询参数生效）：`base.repo` 是目标仓、
     `base.ref === 'main'`、`head.repo` 是目标仓（而非 fork）、`head.ref === branchName`。
     任一不符 → 视为异常外部状态，`conflict`，不采信。**后续步骤要检查的 tree，取自这次
     PR 响应自带的 `head.sha`**，不再单独调用 `git/ref/heads/{branch}`——避免"查 PR"和
     "查分支 ref"两次调用之间再产生一次新的竞态。
  2. **内容完整性校验，调用 §0 D25 的共用原语**：以（1）验证过的 `head.sha`（有 PR 时）
     或分支 ref 指向的 commit（无 PR 但分支存在时）对应的 tree 为校验对象，对每个 pending
     component 各自调用 D25——D25 的"期望文件集"直接取渲染阶段（本节生成流程第 1 步）
     刚算出的结果，同进程内存里现成的数据，不需要重新渲染。
  3. **D25 判定全部通过**（该分支的内容确实是本操作、或本操作某次先前尝试产生的）→ 按
     （1）找到的 PR 状态分流：
     - 找到 `open` PR → 复用（disposition=`noop`，"already in progress"），不重建/不
       重推分支。
     - 找到 `merged` PR → 理论上不会走到这里（下一次 preflight 的 disposition 判定会先
       将这些 component 标为已存在 `noop`）；异常出现则视为 `conflict`。
     - 找到 `closed`（未合并）PR → `blocked`，人工决定（重开该 PR，或删除旧分支后重试）。
     - **没有任何 PR**（分支 ref 存在但查不到 open/merged/closed PR）→ 这正是"建分支成功、
       建 PR 前崩溃"的中间态：**跳过重建分支**，直接执行 `upsertScaffoldPull` 补建 PR。
  4. **D25 判定不通过**（任一 pending component 的子树缺文件、多文件、或内容不符）→
     `conflict`，不动它——可能是外部改写（人工推了额外 commit、或与 hash 派生的分支名
     发生极小概率碰撞），一律不覆盖、不删除、不强推。
  5. 分支 ref 和 PR 都不存在 → 全新构建（blob/tree/commit off 当前 main tip → `createRef`）。

  **内容校验是每次运行都做的只读步骤**，不是"仅恢复场景"的特例逻辑——它同时提供了"崩溃后
  安全补建 PR"（原自相矛盾的场景）与"已有 PR 未被验证就复用"（原未校验直接信任）两个问题
  的统一修复。main 后续如何前进不影响这里的判定，因为判定只看**分支自身内容**是否等于
  本操作预期写入的内容，从不重新对比 main。见 §2.3。
- **D21 — 目录、`template.lock` 位置、CODEOWNERS 匹配全部只认 `component.path`，绝不由
  `id` 推导**：`projects.schema.json` 里 `component.path` 本身已经是完整路径（含 `apps/`
  前缀，允许嵌套，如 `apps/services/api`），`id` 只是短标识（如 `api`）。二者可以不同构
  （`id=api` 但 `path=apps/services/api` 完全合法）。本文所有生成位置、per-component
  lock 路径、CODEOWNERS 前缀匹配**统一以 `component.path` 的原始值为准**（不做"`apps/` +
  拼接"之类的二次前缀，也不用 `id` 猜测目录）；`id` 只用于 `{{component_id}}` render
  token、`template.lock.component.id` 字段和人类可读的日志/PR 描述，从不参与目录/路径
  计算。例：`id=api, path=apps/services/api` 时，生成目录是 `apps/services/api`（不是
  `apps/api`），对应 `template.lock` 落在 `apps/services/api/template.lock`。
- **D22 — `verifyGateApproval` 需要一处 M1 侧修复：`gate:<gate>` label 的"存在性"从未被
  强制**：`provenance/src/verify.ts` 当前的 label 检查只在**发现冲突**的 `gate:*`/
  `version:*` label 时才 fail（"存在一个不等于期望值的同前缀 label"），label **完全缺失**
  时循环不触发任何检查，直接判过。这意味着任何合并到 `main`、且在 CODEOWNER 规则下被正确
  路径批准的 PR，即使从未打上 `gate:architecture` label（从未真正走过 Architecture Gate
  流程/checklist），也能通过 `verifyGateApproval`——弱于 Gate 机制本应提供的保证。修复：
  `gate:<gate>` label 改为**必须存在**（不只是不冲突）；`version:<v>` label **维持"若存在
  须一致，不要求存在"**（对齐 M2 D5"版本以 `specs/<version>/` 路径段 + PR marker 为准，
  `version:*` label 只是按需 upsert 的辅助核对"的既有设计，不应对版本标签 rollout 早期或
  历史 Gate PR 反而更严格）。**这是 M3 实现前必须先合并的 M1 代码变更**（见 §9.1），影响面
  是全部五种 Gate（spec/architecture/design/plan/contract），不只 M3 的 architecture
  用例——修在源头让 M5（发布强制校验）以后也直接受益，不需要每个调用方各自重复一遍同样的
  防御。详见 §3.5。
- **D23 — `components[].owner` 必须是已校验的 GitHub team slug，作为 `team_reviewers`
  传给 PR API**：M1 `projects.schema.json` 当前 `owner` 只要求 `minLength: 1`，是自由
  字符串，无法安全判断它是个人用户名还是 team slug——而 GitHub"请求 PR reviewer"的 API
  把这两者放在**不同参数**里（`reviewers: string[]` 是个人，`team_reviewers: string[]`
  是 team），必须提前知道走哪个参数。沿用系统里既有的强约定（`product-init.yaml` 的
  `owners.*` 全部是 team slug，直接喂进 CODEOWNERS 的 `@org/<slug>` 形式），本文把
  `components[].owner` **同样定为必须是 team slug**：schema 加 pattern（如
  `^[a-z][a-z0-9-]*$`，与 `id`/`product` 同风格）；scaffold 在 preflight 里对每个
  pending component 的 `owner` 做与 M2 D13 相同的"只校验已存在 + ≥1 active member，不
  创建"检查，缺失 → `blocked`；`upsertScaffoldPull` 用 `team_reviewers`（不是
  `reviewers`）请求评审。**这也是 M3 实现前需要的一处 M1 schema 变更**（见 §9.1）。附带
  说明一个相邻但不在本文解决范围内的缺口：若某 component 的 `path` 不落在 M2 Bootstrap PR
  预注册的四条 CODEOWNERS stanza（`/apps/{backend,web,ios,android}/`）覆盖范围内（例如
  同一模板类型的第二个 component，或更深层路径），**CODEOWNER 批准会退回到通配符
  `* @org/<admins>`**，而不是该 component 声明的 `owner` 团队——scaffold 请求的 PR
  reviewer 仍然正确指向 `owner` 团队（best-effort 评审路由），但正式的"required
  CODEOWNER approval"门槛来自 admins，除非另有人工 PR 给 CODEOWNERS 补一条 stanza。这是
  M2 CODEOWNERS 设计的既有边界，不是 M3 引入的新问题，本文不在此处解决。
- **D24 — Scaffold PR 需要 merge-time 重新校验，关闭"审查窗口期"的 TOCTOU**：D18 的 main
  新鲜度校验只在 scaffold **preflight 那一刻**成立；Scaffold PR 本身不修改 `projects.yaml`
  （只加 `apps/**`），所以从 PR 打开到人工 review/merge 之间——可能是几小时到几天——main
  上若又有一个新的 Architecture Gate 合并，改写或移除了这个 PR 正在脚手架的 component，
  **PR 与 `projects.yaml` 之间没有任何路径重叠**，GitHub 不会提示冲突，PR 依然可以在旧的、
  已被取代的批准基础上干净合并。D18 挡不住这个窗口期，因为它只在 preflight 那次调用里跑
  一次，不会在人工点"合并"的那一刻自动重跑。

  修复分两部分：
  1. **`sdd-main` ruleset 的 `required_status_checks` 规则加
     `strict_required_status_checks_policy: true`**（GitHub ruleset 原生参数，即经典分支
     保护里的"要求分支在合并前保持最新"）。若 main 在 PR 存续期间前进，合并前必须先把 main
     并入该 PR 分支（"Update branch"），产生一个新 commit——这个新 commit 触发
     `PR hygiene` 重新运行（`synchronize` 事件）。若 main 没有前进，"最新"这个前提本来就
     成立，不需要也不会强制更新，不产生额外摩擦。这是对 M2 `sdd-main` ruleset 配置的一处
     小补丁（§9.1 #4），M3 本身不新建保护资源（D5）。
  2. **`checkPrHygiene`（M2 交付，`@sdd/factory`）新增一条 Scaffold PR 专属规则，含两层
     校验**：识别依据是"PR 的 changed files 里存在至少一个新增（`status=added`）的、
     路径匹配 `apps/**/template.lock` 的文件，且该 PR 没有 `gate:*` label"（与现有"有
     `gate:*` label → Gate 专属规则"、"两者都没有 → 纯通用校验"分列第三类，互斥）。

     **第一层——该 component 是否仍被批准**：读取该新增 lock 文件在 PR head SHA 的内容，
     解析出 `component.{id,path}` 与 `template.{name}`、`source.resolved_commit`；再读取
     **当前 main HEAD**（不是 PR 分支自己的树——PR 分支从未修改过 `projects.yaml`，读它
     自己的树只会拿到构建时刻的旧值，等于没检查）的 `projects.yaml`，确认其中存在一个
     component 满足 `id/path/template/template_ref` **四者都**与该 lock 文件记录的一致；
     不匹配（component 消失，或 `template_ref` 已被后续 Gate 改成别的 commit）→ 该项
     hygiene 规则失败，PR 无法合并——意味着该 Scaffold PR 已经过时，应该关闭并让下一次
     `sdd product scaffold` 基于新 `operation_id` 重新开一个（旧 PR 不会被自动处理，
     需要人工关闭，同 D20 的"默认不删/不关"原则）。

     **第二层——该 component 的实际落地内容是否仍与批准的模板一致（D25/D26）**：
     "只查了 lock 元数据、没查 PR 实际文件"的问题）**：**不能信任该 lock 文件自己
     `files[]` 里记录的 `output_sha256` 作为期望值**——如果攻击者能推一个后续 commit
     同时篡改某个应用文件*和*该 lock 文件对应的 `output_sha256`（让两者继续互相"对得
     上"），仅比较"lock 文件说什么"和"PR 里实际是什么"完全查不出问题，因为两者是被同一个
     攻击者一起改的，脱离了任何独立的真相来源。正确做法：**独立重新推导期望内容**，不
     读、不信 PR 里的 lock 文件——用第一层已经从**当前 main** 读到的
     `component.{id,path,owner}` 与 `template_ref`；按 D26 核对自身 generator commit 与受管
     workflow pin，且只把 PR lock 的 `approved_by.{pr,version}` 当候选 locator，重新验证该
     Architecture Gate PR，取得可信 Provenance；随后调用与 scaffold 命令本身相同的
     `resolveCommit`/`readTemplateTree`/`renderComponent` 管线（对**平台仓**在
     `template_ref` 这个被钉住的历史 commit 上重新解析 + 渲染，`product`/`repo` 取目标
     产品仓自身身份），重建包括 `template.lock` 在内的完整期望文件集；再对 PR **head** tree
     调用 §0 D25 的子树校验原语——不通过 → 该项 hygiene 规则失败。
     两层都通过才算 Scaffold PR hygiene 规则整体通过。

  **平台仓读取方式**：第二层重新渲染需要读平台仓在 `template_ref` 这个**任意历史 commit**
  上的模板内容——`PR hygiene` workflow 本身 checkout 的平台仓 pinned SHA 只是为了跑
  `sdd` 这个工具本身，与某个 component 具体的 `template_ref`（可能是更早的历史 commit）
  无关，**不能读本地 checkout**；必须走 GitHub API（`resolveCommit`/`readTemplateTree`
  对平台仓发起的只读调用，同 scaffold 命令自己解析模板的方式）。

  两部分组合：main 不前进 → 不强制更新分支 → 不重新触发检查 → 原有绿色结果继续有效
  （没有必要重新验证，因为什么都没变）；main 前进 → 强制更新分支 → 触发 hygiene 重跑 →
  若被取代的 component 已经消失，第一层检查变红，阻止合并；即使 component 仍被批准，
  PR 自己的文件被后续 commit 篡改，第二层检查也会变红。**这依赖 M2 已有的
  required-workflow 防伪机制**（D7/D10，check 由平台仓 pinned workflow 产出，不能被产品
  PR 伪造）——本条只是给同一个受信的 `PR hygiene` job 增加一条新规则分支，不引入新的
  check 名，不需要新的 required-check bootstrap。人工点击"合并"那一刻与"检查最后一次跑
  完"之间仍有秒级窗口——这是任何基于 required check 的分支保护共有的、不可消除的极小
  race，不是本设计的缺陷，此处不再进一步加固。见 §3.6、§5.3、§9.1。
- **D25 — "component 子树完整性校验"是 D20/D24 共用的一个原语，只在 `sha256(content)`
  这一个哈希空间里比较，绝不比较 Git blob SHA**（第 3 稿修复：`output_sha256` 是
  `sha256(文件原始字节)`，Git 的 blob SHA 是 `sha1("blob " + 字节数 + "\0" + 文件原始
  字节)`——**两个不同的哈希函数、不同的输入前缀，数值永不相等**，即使内容完全一致；第
  2 稿把"tree 里查到的 blob SHA"直接和 `output_sha256` 比较，这个比较对任何输入都恒为
  假，等于该校验从未真正生效过）。

  **给定**：某 component 的 `path`（如 `apps/backend`）与期望文件集 `F =
  [{path, output_sha256}, ...]`（含该 component 自己的 `<path>/template.lock`）。

  **给定**一棵目标 tree（D20 场景传分支 tip 的 tree；D24 场景传 PR head 的 tree）：
  1. 递归读该 tree（`GET .../git/trees/{tree_sha}?recursive=1`），**只保留路径以
     `path + "/"` 为前缀的条目**——`path` 之外的任何路径（`specs/**`、`contracts/**`、
     其它已生成 component 的目录、根 `template.lock` 等）一律忽略，不参与比对、不因为
     "存在"就判定异常（第 3 稿修复："计划外路径"曾经语焉不详——完整 tree 因为
     `base_tree` 继承关系必然包含整个仓库其余内容，这是正常状态，不是入侵迹象；只有
     **该 component 自己的子树内**出现计划外内容才算异常）。
  2. **集合相等**：这些条目的路径集合必须与 `F` 的路径集合**完全相等**——`F` 里有但
     tree 里没有 → 缺文件；tree 里有但 `F` 没有 → 多文件（例如攻击者在该 component
     目录下偷塞了一个新文件）。任一方向不等 → 校验失败。
  3. **逐文件内容比对**：集合相等之后，对每个路径，用该条目的 blob SHA 调用
     `GET .../git/blobs/{blob_sha}`（返回 base64 content），解码后计算
     `sha256(content)`，与 `F` 里同路径记录的 `output_sha256` 比较；任一不等 → 校验
     失败。**这里额外的"每文件一次 blob 内容读取"调用是必要成本**——换取的是与
     `output_sha256`/`output_tree_sha256` 全程同一套、且已经过 M2 验证的哈希语义，
     不需要再引入、验证一套 Git 内部对象哈希的实现（比"省一次 API 调用但要自己正确实现
     `sha1("blob "+len+"\0"+content)"`更不容易出错，也不依赖"GitHub 当前用 SHA-1 存
     对象"这个可能变化的事实）。
  4. 2、3 都通过 → 该 component 校验通过；任一步失败 → 校验失败，调用方按 D20/D24
     各自的规则处理（`conflict` 或 hygiene 规则变红）。

  D20 与 D24 调用同一个原语，但"期望文件集 `F`"的来源不同、可信度也不同：D20 直接用
  **本次调用自己刚渲染出的内存数据**（同进程、同次调用，不存在被篡改的可能）；D24
  **绝不能**用 PR 里 `template.lock` 自己声明的 `files[]`（那是被检查对象自己的声明，
  可能与被篡改的应用文件同步被改掉），必须按 §0 D24 第二层描述的方式独立重新渲染
  得到。（细节见 §1.1–1.4；具体 patch 版本号在实现时按当时最新稳定版确认，
  此处锁定的是**主版本/工具选型/锁定机制**）：
- **D26 — merge-time 重渲染必须钉住 generator，并重新验证 `approved_by`，不能从不可信 PR
  猜这两项**：D24/D25 要求 hygiene 独立重建包括 `<path>/template.lock` 在内的完整期望子树，
  仅有当前 main 的 component 与不可变 `template_ref` 还不够：lock 还含 generator 身份和
  Architecture Gate Provenance。两项按以下方式建立独立信任链：
  1. `@sdd/factory`/CLI 的发布构建注入 `generator.resolved_commit`（平台仓完整 40-hex commit
     SHA；本地未注入的开发构建只能 dry-run，真实 scaffold fail closed）。产品仓 required
     `PR hygiene` workflow 本来就由 M2 ruleset 以平台仓 `repository_id + path + sha` 固定；
     scaffold preflight 读取该受管 ruleset，要求运行中 generator commit **等于** workflow
     pinned SHA，否则 `blocked`。因此创建 PR 的 CLI 与日后执行 merge-blocking hygiene 的代码
     来自同一 commit、具有相同 render/lock canonicalization 语义。该 SHA 同时写入每个 lock，
     hygiene 再要求 lock 中值等于自身运行时嵌入的 commit。
  2. M3 的 Architecture Gate 增加一条调用侧前置约束：PR 除必须有 `gate:architecture` 外，
     还必须有且仅有一个 `version:<v>`，并与 `--architecture-version` 相等。D22 对通用
     `verifyGateApproval` 的“version label 可选”语义不变，避免扩大到其它 Gate；但 scaffold
     preflight 和 Scaffold hygiene 都额外强制 Architecture Gate 的 version label 存在。
     这样 lock 中的 `approved_by.version` 有独立的 GitHub PR 元数据可复核，而不是调用者可任意
     填写的字符串。
  3. hygiene 从 PR lock 中只读取 `approved_by.pr` 作为**不可信候选 locator**，以及候选
     `approved_by.version`；先读取候选 PR 并确认其 `version:<v>` label，再针对**当前 main 的
     `projects.yaml`** 调用 `verifyGateApproval`。实现可把当前 main checkout/fetch 到临时干净
     worktree 后复用 `createLocalGitReader`，不新增一套宽松 verifier。验证失败则 hygiene 变红；
     成功则只使用返回的 `Provenance`（不用 lock 原值）构造期望 `approved_by`。
  4. hygiene 用“当前 main component + pinned template commit + 与 workflow 相同的 generator
     commit + 重新验证得到的 Provenance”调用 `renderComponent`，由此可确定性重建**包含完整
     `template.lock`**的期望文件集，再交给 D25。PR lock 的其它字段均只是被比较对象，不能反向
     参与期望值计算。

  这会给 scaffold 增加读取受管 ruleset/workflow pin 的权限需求，见 §2.6；它换来的是一个闭合
  的信任链，而不是依赖“CLI 恰好与 workflow 同版本”的部署惯例。

目录一律是该 component 在 `projects.yaml` 里声明的 `path` 原始值（已含 `apps/` 前缀，
可能嵌套），**不由 `id` 推导**（D21）；下表按 `ci` 字段区分四套工具链：

| `ci` 字段 | 模板 | 语言 | 构建/包管理 | 复现锁定机制 | lint | typecheck（等效） | test | build |
|---|---|---|---|---|---|---|---|---|
| `java` | `spring-boot` | Java 21 LTS | Gradle 8.10 + Wrapper | `gradle-wrapper.properties`（`distributionSha256Sum`）+ Gradle toolchain 固定 JDK 21 | `./gradlew spotlessCheck` | `./gradlew compileJava compileTestJava` | `./gradlew test` | `./gradlew build` |
| `web` | `web` | TypeScript 5.6 | pnpm 9 + Vite 5 | `package.json.packageManager`（corepack）+ `pnpm-lock.yaml`（frozen install） | `pnpm biome check .` | `pnpm tsc --noEmit` | `pnpm vitest run` | `pnpm vite build` |
| `ios` | `ios-tuist` | Swift 6 | Tuist 4.x | `.tuist-version` + `.xcode-version` | `swiftlint` | `tuist build`（编译即 typecheck） | `tuist test` | `tuist build` |
| `android` | `android` | Kotlin 2.0 | Gradle 8.10 + AGP 8.5 + Wrapper | `gradle-wrapper.properties` + `gradle/libs.versions.toml`（version catalog 固定 AGP/Kotlin） | `./gradlew lint` | Kotlin 编译本身（随 build/test 触发） | `./gradlew testDebugUnitTest` | `./gradlew assembleDebug` |

## 1. 四个平台模板

### 1.0 共享机制

模板源码位于平台仓 `templates/{spring-boot,web,ios-tuist,android}/`，与 `templates/
monorepo-root/` 并列，各配一份 `templates/<name>.manifest.json`（生成方式见 D2 第 2 点）。
四个模板复用 monorepo-root 已建立的机制，无需重新发明：

- **manifest + checksum**：结构与字段与 M2 §2.4 完全一致（排序后的
  `相对路径 → mode + render? + 原始文件内容 sha256(content)` + `tree_sha256`；这里的
  `sha256` 全程是 M2 既有的"内容哈希"，与 D25 讨论的 Git 对象哈希无关，两套机制不要
  混淆）；`build:template-manifest`
  脚本参数化后对每个模板独立生成（D2）。drift 测试（committed manifest 与重算一致）对四个
  模板各跑一遍。
- **render token 分配**：复用 `renderContent` 的 `{{token}}` 替换机制，token 集合扩展为
  `{{product}}`（沿用 monorepo-root）+ 新增 `{{component_id}}`（如 `backend`）+
  `{{component_owner}}`（team slug，仅用于 README/注释，非强制）。
- **不做路径级模板替换**：M2 的 `renderTree` 只替换**文件内容**里的 token，输出路径与
  manifest 里的 `path` 完全相同——不支持"目录名本身包含 token"。Java/Kotlin 包名传统上与
  目录结构耦合（`dev/sdd/xxx/Application.java`），若让包名随 `product`/`component_id`
  变化，就需要给 render 机制新增"路径级 token"能力，这是对 M2 factory 的又一处结构性改动。
  **本文选择更简单的路线**：四个模板的 Java/Kotlin 源码目录与 `package` 声明使用**固定、不
  参数化**的两段式包名 `dev.sdd`（即 `src/main/java/dev/sdd/Application.java`，
  `package dev.sdd;`），不随 product/component 变化。Java 包唯一性只在**同一编译单元**内
  有意义，而每个 component 的 `path` 目录都是独立 Gradle 项目、从不与另一个 component 的
  目录共同编译，因此两个都用 `spring-boot` 模板的组件各自用 `dev.sdd` 包完全安全，不会
  冲突。真正需要"per-
  product/component 区分"的标识——Android `applicationId`、iOS `PRODUCT_BUNDLE_IDENTIFIER`、
  Spring 的 `spring.application.name`、`settings.gradle.kts` 的 `rootProject.name`、
  `package.json` 的 `name`——都是**纯内容字符串**，用既有的 content-only token 替换即可
  （如 `applicationId = "dev.sdd.{{component_id}}"`），不涉及路径，不需要扩展 render 机制。
  这一权衡把"四模板需要 product/component 特定标识"的真实需求与"避免给 M2 factory 引入路径
  模板化"的复用目标同时满足。
- **`RenderContext` 扩展**：新增 `ComponentRenderContext extends RenderContext { component:
  { id: string; path: string; owner: string } }`，供 §2.3 的 per-component 渲染使用；不修改
  既有 `RenderContext`（`monorepo-root` 渲染路径不变）。
- **目录只认 `path`，不由 `id` 推导**（D21）：`component.path` 已含 `apps/` 前缀且可嵌套
  （schema pattern `^apps/[a-z0-9-]+(/[a-z0-9-]+)*$`）；`id` 只是短标识，二者可以不同构。
  例：`id=api, path=apps/services/api` 时，生成目录是 `apps/services/api`（不是
  `apps/api`），对应的 `template.lock` 落在 `apps/services/api/template.lock`。本文
  下文所有涉及"生成到哪里"的地方都直接写 `path`（或 `<path>` 作为占位符），不再使用
  `apps/<id>` 这种会与嵌套/不同构 id 冲突的简写。
- **每模板自成一个可独立构建的最小项目**：模板里检入的文件（如
  `templates/spring-boot/build.gradle.kts`）**渲染前**含有 `{{...}}` token，不是合法的最终
  产物（例如 `application.yml` 里的 `spring.application.name: {{component_id}}`
  在渲染前不是合法值，但这类 token 只出现在配置值/字符串里，不影响该文件本身的 YAML/
  Gradle/Swift 语法合法性——因为 §1.0 已经把包名/目录固定，不存在"渲染前无法解析源码"的
  情况）。四个模板各自的**自测**（§1.5）用示例 token 渲染到 scratch 目录后，跑真实工具链
  验证可 lint/typecheck/test/build，镜像 M2 `factory/test/template.test.ts` 对
  `projects.yaml` "渲染 `{{product}}` 后过 `sdd validate`"的做法。
- **不含任何 CI workflow 文件**（D10，§5 详述）。

### 1.1 `spring-boot`（`ci: java`）

```text
templates/spring-boot/
├─ gradlew · gradlew.bat
├─ gradle/wrapper/{gradle-wrapper.jar, gradle-wrapper.properties}   # distributionSha256Sum 锁定
├─ settings.gradle.kts              # rootProject.name = "{{component_id}}"
├─ build.gradle.kts                 # Java 21 toolchain、Spring Boot 3.3.x plugin、Spotless
├─ src/main/java/dev/sdd/Application.java        # @SpringBootApplication
├─ src/main/java/dev/sdd/HealthController.java   # @RestController GET /api/health
├─ src/main/resources/application.yml            # spring.application.name: {{component_id}}
├─ src/test/java/dev/sdd/HealthControllerTest.java  # @SpringBootTest + MockMvc
├─ .gitignore
└─ README.md
```

- **锁定版本**：Java 21 LTS（Gradle toolchain 块，不依赖 CI 宿主默认 JDK）；Gradle 8.10
  （wrapper + `distributionSha256Sum`）；Spring Boot 3.3.x（`org.springframework.boot`
  plugin + BOM）；Spotless 6.25.x（`googleJavaFormat()`）。
- **最小应用**：`HealthController` 暴露 `GET /api/health` 返回 `{"status":"ok"}`；无数据库/
  无业务逻辑（呼应手册 §6.4"不得提前实现产品功能"）。
- **示例测试**：`HealthControllerTest` 用 `@SpringBootTest(webEnvironment=MOCK)` +
  `MockMvc` 断言该端点返回 200 与预期 JSON。
- **命令契约**（供 M4 未来 reusable workflow 调用，§5）：
  - lint：`./gradlew spotlessCheck`
  - typecheck（等效）：`./gradlew compileJava compileTestJava`
  - test：`./gradlew test`
  - build：`./gradlew build`（已含 compile + test + jar 打包）

### 1.2 `web`（`ci: web`）

```text
templates/web/
├─ package.json          # packageManager: pnpm@9.x（corepack）；name: {{component_id}}
├─ pnpm-lock.yaml
├─ .nvmrc                 # 24
├─ tsconfig.json          # strict
├─ vite.config.ts
├─ biome.json
├─ vitest.config.ts
├─ index.html
├─ src/main.tsx · src/App.tsx · src/App.test.tsx
├─ .gitignore
└─ README.md
```

- **锁定版本**：Node 24 LTS（`.nvmrc`，与平台仓一致但是独立项目）；pnpm 9.x（corepack 固定，
  `pnpm-lock.yaml` 提交，CI/构建一律 `--frozen-lockfile`，镜像 M1 的可复现构建原则）；
  Vite 5.4.x；React 18.3.x；TypeScript 5.6.x；Vitest 2.1.x；Biome 1.9.x。
- **选型理由**：Vite + React + TypeScript 是最少活动部件的 SPA 起点；vitest/biome/pnpm 与
  平台仓自身工具链一致（同一套心智模型，非技术硬性要求）；无路由/无状态管理/无 SSR 框架——
  产品需求出现后由后续实现 Issue 决定，不在 scaffold 阶段预设。
- **最小应用**：单页 `App.tsx` 渲染标题 `{{product}} / {{component_id}}`；无路由、无 API
  调用（`contracts/openapi.yaml` 尚未生成，见 §5）。
- **示例测试**：`App.test.tsx` 用 `@testing-library/react` 渲染 `<App />` 断言标题文本存在。
- **命令契约**：
  - lint：`pnpm biome check .`
  - typecheck：`pnpm tsc --noEmit`
  - test：`pnpm vitest run`
  - build：`pnpm vite build`

### 1.3 `ios-tuist`（`ci: ios`）

```text
templates/ios-tuist/
├─ .tuist-version                    # 锁定 Tuist CLI 版本
├─ .xcode-version                    # 锁定 Xcode 版本（GitHub macOS runner 预装多版本之一）
├─ Tuist.swift                       # Tuist 配置 manifest
├─ Project.swift                     # app target + test target；PRODUCT_BUNDLE_IDENTIFIER: dev.sdd.{{component_id}}
├─ Sources/App/{SDDApp.swift, ContentView.swift}   # SwiftUI 最小页面
├─ Tests/AppTests/ContentViewTests.swift           # XCTest
├─ .swiftlint.yml
├─ .gitignore
└─ README.md
```

- **锁定版本**：Tuist 4.x（`.tuist-version`；**实现时须核对 Tuist 当前推荐的版本钉死机制**
  ——Tuist 的 CLI 安装/版本管理方式在不同大版本间有过调整，`.tuist-version` 是历史约定名，
  以 Tuist 官方文档当时的推荐方式为准）；Xcode 16.x（`.xcode-version`）；Swift 6（Xcode 16
  默认 toolchain）；iOS 部署目标 17.0；SwiftLint 0.55.x（固定版本，通过 SPM plugin 或 Mint
  锁定，实现时确认）。
- **最小应用**：`ContentView` 显示 `"{{product}} · {{component_id}}"` 文本；`SDDApp` 为
  `@main` 入口。**不含路由/网络层**（同 web，等 Contract Gate 落地后由实现 Issue 添加）。
- **示例测试**：`ContentViewTests` 一个 XCTest 断言视图可实例化（保持最小、不需要模拟器截图
  比对）。
- **命令契约**：
  - lint：`swiftlint`
  - typecheck（等效，编译即类型检查）：`tuist build`
  - test：`tuist test`
  - build：`tuist build`
- **验证约束**：iOS 构建/测试需要 macOS + Xcode + Tuist，Codex 若在 Linux sandbox 中实现，
  **无法在本地验证该模板可编译**；需要 GitHub Actions macOS runner 或人工在 Mac 上验证后
  才能确认 §1.5 自测通过。见 §11 待决事项。

### 1.4 `android`（`ci: android`）

```text
templates/android/
├─ gradlew · gradlew.bat
├─ gradle/wrapper/{gradle-wrapper.jar, gradle-wrapper.properties}
├─ gradle/libs.versions.toml         # version catalog：AGP/Kotlin/Compose/JUnit/Robolectric 固定
├─ settings.gradle.kts               # rootProject.name = "{{component_id}}"
├─ build.gradle.kts                  # 根项目（plugins 声明）
├─ app/build.gradle.kts              # applicationId = "dev.sdd.{{component_id}}"
├─ app/src/main/AndroidManifest.xml
├─ app/src/main/java/dev/sdd/MainActivity.kt      # Jetpack Compose 最小页面
├─ app/src/test/java/dev/sdd/MainActivityUnitTest.kt   # JUnit + Robolectric（无需模拟器）
├─ .gitignore
└─ README.md
```

- **锁定版本**：Kotlin 2.0.20（Compose compiler 自 Kotlin 2.0 起作为 Gradle plugin 集成，
  无需单独锁定 compose-compiler 版本）；Android Gradle Plugin 8.5.2；Gradle 8.10（AGP 8.5
  要求 ≥8.7，锁定为满足下限的具体版本）；`compileSdk`/`targetSdk` 35，`minSdk` 26；
  Robolectric 4.13.x（本地 JVM 单测，不需要模拟器/真机，保持 test 命令快速可复现）。
- **最小应用**：`MainActivity` 用 Jetpack Compose 显示 `"{{product}} · {{component_id}}"`。
- **示例测试**：`MainActivityUnitTest` 用 Robolectric 在 JVM 内验证 Activity 可正常创建并
  显示预期文本，不依赖模拟器/仪器化测试（仪器化测试留给未来按需添加，非 scaffold 阶段必需）。
- **命令契约**：
  - lint：`./gradlew lint`（Android Gradle Plugin 内置 lint，零额外插件依赖）
  - typecheck（等效，随编译触发）：随 `build`/`test` 一并执行 Kotlin 编译
  - test：`./gradlew testDebugUnitTest`
  - build：`./gradlew assembleDebug`

### 1.5 模板自测（平台仓自身 CI，非产品侧 Gate）

四个模板各自的检入内容（含 `{{...}}` token）无法直接运行；自测流程：取样例
`{product: "demo", component_id: "sample", component_owner: "demo-team"}` 上下文，用
`renderTree`（复用 §1.0 的 `ComponentRenderContext`）把 manifest 列出的文件渲染到 scratch
目录，再对该目录跑 §1.1–1.4 表格里的四条命令，断言全部退出码 0。这是**平台仓自身**的工程
卫生（类似平台仓自己跑 `pnpm -r test`），不产生任何 product-facing check，也不是 M2/M3 定义
的 Gate 机制的一部分。

四种工具链在 CI runner 上的可用性不同：`spring-boot`/`android` 需要 JDK（`actions/setup-
java`）与 Android SDK（`android` 额外需要 cmdline-tools，但 Robolectric 单测本身不需要
模拟器）；`web` 只需要 Node；`ios-tuist` 需要 **macOS runner** + Xcode + Tuist（GitHub
托管的 macOS runner 预装多个 Xcode 版本，Tuist 需额外安装/缓存）。实现时平台仓自身的 CI
需要按平台拆分 job（而非单一 job 跑全部四种工具链）。

## 2. `@sdd/factory` 扩展：`sdd product scaffold`

### 2.1 命令接口

```bash
# 预览（零 GitHub 写；无授权引用时仍出计划，但 authorization.verified=false）
sdd product scaffold --repo . [--projects projects.yaml] \
  --platform-repo <org>/sdd-platform \
  [--architecture-pr <n> | --architecture-merge-sha <sha>] [--architecture-version <v>] \
  [--format text|json] --dry-run

# 真实生成（开/更新 Scaffold PR；授权校验未通过则 fail closed，退出码 7）
sdd product scaffold --repo . [--projects projects.yaml] \
  --platform-repo <org>/sdd-platform \
  --architecture-pr <n> | --architecture-merge-sha <sha> --architecture-version <v>
```

- `--repo .`：目标产品仓的本地 checkout（默认当前目录）。它同时是（a）`@sdd/provenance`
  `GitReader` 的操作对象（校验本地 `projects.yaml` blob/clean），和（b）`projects.yaml`
  的读取来源。**不是**平台模板字节的来源——那部分仍经 `--platform-repo` 解析（同 `product
  init` 的 GitHub 读取路径，或本地开发时的 `createLocalFsReadPort`）。
- `--projects projects.yaml`：显式产物路径，默认 `projects.yaml`，镜像 M1 `sdd validate
  --kind <file>` 的显式文件哲学；也是 `verifyGateApproval` 的 `artifactPath` 入参。
- `--platform-repo`：默认 `<target-owner>/sdd-platform`（同 `product init` 的同 org 约束与
  默认推导逻辑，`cli/src/commands/product/init.ts` 已有实现可直接复用该段逻辑）。**没有
  `--platform-ref` 标志**——与 `product init` 不同，scaffold 不需要单一全局 ref：
  `projects.yaml` 里每个 component 的 `template_ref` 本身就是该组件模板的 pin，且已经随
  整份 `projects.yaml` 一起被 Architecture Gate 批准与 blob 校验，直接按 component 各自的
  `template_ref` 解析即可；不需要 CLI 再传一次，也避免"CLI 传的 ref"与"projects.yaml 里记的
  ref"不一致的风险。
- `--architecture-pr` / `--architecture-merge-sha`：二选一，映射 `ApprovalRef`；**真实执行
  必填**，dry-run 可省略（省略时报告 `authorization.verified=false, reason="no approval
  reference supplied"`，不尝试调用 `verifyGateApproval`）。
- `--architecture-version`：如 `v1`，供 `verifyGateApproval` 的 label 辅助一致性核对
  （`gate:architecture` + `version:v1` 需与 PR 标签相符，否则 fail）；dry-run 若提供了
  `--architecture-pr`/`--architecture-merge-sha` 但未提供此项，同样按"无法尝试校验"处理并
  在报告里说明。
- **退出码**（沿用 `product init` 惯例，新增 `7`）：
  `0`=完成/noop（无待生成 component，或 Scaffold PR 已合并且收敛）；`2`=输入/checksum 错误；
  `3`=preflight/权限 `blocked`；`4`=等待 Scaffold PR 人工 review/merge；`5`=检测到
  drift/conflict；`6`=GitHub 暂时性失败可重跑；**`7`=授权校验未通过（fail closed，仅真实
  执行触发；dry-run 从不返回此码，只在 JSON 里标注 `authorization.verified=false`）**。

### 2.2 Dry-run 报告（确定性，本文 D7 / M2 D12）

首个前置步骤：本地 `--projects` 内容先过 `@sdd/schemas` 的 `validateProjectsDocument`
（M1 已交付，直接复用；不重新实现结构校验）。结构非法 → 退出码 `2`，不进入 provenance/
渲染流程。

```json
{
  "plan_version": 1,
  "operation_id": "sha256:<64-hex>",
  "target": { "owner": "acme", "repository": "demo", "default_branch": "main" },
  "source": { "repository": "acme/sdd-platform" },
  "authorization": {
    "gate": "architecture",
    "version": "v1",
    "artifact_path": "projects.yaml",
    "main_fresh": true,
    "verified": true,
    "reason": null,
    "provenance": {
      "pr": 42, "approved_head_sha": "<40-hex>", "merge_commit_sha": "<40-hex>",
      "approved_at": "2026-05-01T12:00:00Z", "authorization_policy": "current-codeowners"
    }
  },
  "components": [
    {
      "id": "backend", "path": "apps/backend", "owner": "backend-team", "template": "spring-boot",
      "disposition": "create",
      "template_source": {
        "path": "templates/spring-boot", "resolved_commit": "<40-hex>",
        "manifest_sha256": "sha256:<64-hex>", "source_tree_sha256": "sha256:<64-hex>",
        "output_tree_sha256": "sha256:<64-hex>"
      },
      "files": [ { "target": "apps/backend/build.gradle.kts", "mode": "100644", "render": true, "output_sha256": "sha256:<64-hex>" } ]
    },
    { "id": "web", "path": "apps/web", "owner": "web-team", "template": "web", "disposition": "noop", "detail": "apps/web already has content on main" }
  ],
  "operations": [
    { "order": 10, "phase": "branch", "kind": "branch.create", "disposition": "create", "target": "sdd/scaffold-<opid12>" },
    { "order": 20, "phase": "pull-request", "kind": "pull.upsert", "disposition": "create", "target": "sdd/scaffold-<opid12> -> main" }
  ],
  "warnings": []
}
```

- 排序：`components` 按 `id` 字节序；每个 component 的 `files` 按 `target` 字节序；
  `operations` 按 `(phase, order)`。`disposition ∈ {create, noop, blocked, conflict}`
  （scaffold 不产生 `update`——D3 create-only）。`components[].path` 是 schema 里的原始
  值（已含 `apps/` 前缀，可能嵌套，见 D21）；`files[].target` 直接是该 `path` 之下的完整
  相对路径，不做二次拼接。
- `template_source` **不再有 `requested_ref` 字段**：D19 之后 `template_ref` 本身必须是
  完整 40-hex commit SHA，"请求的 ref"与"解析出的 commit"恒等，保留两个字段是冗余信息；
  `resolved_commit` 即 `projects.yaml` 里该 component 的 `template_ref` 原值。
- `authorization.main_fresh`（D18 新增字段）：`main` 当前 HEAD 的 `projects.yaml` blob
  是否与本地 worktree 一致；为 `false` 时 `verified` 恒为 `false`，`reason` 说明"可能落后
  或已有更新批准"，且不进行 `verifyGateApproval` 之外的其它判断（两者是并列的必要条件，
  任一为否，`verified` 就是否）。
- `operation_id = sha256(JCS({ target, source: {repository}, authorization: {gate, version,
  pr|merge_commit_sha}, components: [{id, path, template, template_source: {resolved_commit,
  output_tree_sha256}} 按 id 排序，仅含 disposition=create 的项] }))`。**只有待生成
  component 参与哈希**——已存在（noop）的 component 不影响 `operation_id`，这样"这一批要
  生成什么"变化时才产生新分支名（D11），已合并批次不受后续批准影响。
  无时间戳/请求 id/token 等易变字段；相同输入两次运行 **byte-identical**（M2 D12 原则，
  M2 已验证过的同一套约束在此照搬）。
- `authorization.verified=false` 时，`provenance` 字段整体缺省（不猜测/不填充部分数据）；
  `components[].disposition` 仍照常计算并展示（预览未批准输入时"将会生成什么"依然有用，
  呼应 M1 对 `compile --dry-run` 的既有原则）。
- dry-run 对 GitHub 只发 `GET`（含 `verifyGateApproval` 内部的只读调用、main 新鲜度校验
  读取、`readTemplateTree`、"该 component 目录是否已在 main 存在"的树查询——后三者共享
  同一次 main tree 读取，不重复请求），**零 mutating 调用**；本地开发场景可用
  `createLocalFsReadPort` 读平台模板字节（同 `product init` dry-run 的既有模式）。

### 2.3 真实生成流程

**Preflight（全过才动手，否则 `blocked`/`2`/`7`）**：
1. `--projects` 过 schema 校验（含 D19 的 `template_ref` 40-hex 校验、D23 的 `owner`
   team-slug pattern 校验）。
2. **generator pin 校验（D26）**：读取产品仓受管 required workflow 的 pinned 平台仓 SHA，
   要求它与当前 CLI 构建嵌入的 `generator.resolved_commit` 相等；开发构建未嵌入 SHA、pin 缺失或
   不相等 → `blocked`，真实执行不继续。
3. 调用 `verifyGateApproval({ octokit, git: createLocalGitReader('.'), repo: <target 产品仓>,
   gate: 'architecture', version, approval, artifactPath: 'projects.yaml' })`。`ok:false` →
   打印 `reason`，退出码 `7`，**不做任何后续步骤**（不解析模板、不建分支）。
   此外要求该 PR 有且仅有一个 `version:*` label，且等于 `version:<--architecture-version>`
   （D26；通用 verifier 的 version-label 可选语义不变）。缺失/重复/不一致 → 退出码 `7`。
4. 读当前产品仓 `main` 的**实际** tip commit + 完整 tree（GitHub API 新读，不信任本地 git
   的 remote-tracking 状态——本地 git 只用于第 2 步的 provenance blob/clean 校验，不作为
   mutation 的数据源）。**main 新鲜度校验（D18）**：从这份 tree 里取 `projects.yaml` 的
   blob SHA，要求它与本地 worktree 的 `projects.yaml` blob SHA（`git.blobWorktree`
   同一算法）完全一致；不一致 → fail closed，退出码 `7`，报"projects.yaml 与远端 main
   当前版本不一致（本地可能落后，或已有更新的 Architecture Gate 批准）"，**不做任何后续
   步骤**。这一步与第 2 步相加，构成"main 当前内容 == 本地 worktree == 指定 PR 批准内容"
   的完整链条，防止引用已被后续 Architecture Gate 取代的旧 PR 号（D18 详述见 §3.3）。
5. 对每个 `projects.yaml` component：确认其 `template_ref`（已保证是完整 40-hex commit
   SHA，D19）在平台仓可达，读出对应平台模板（`spring-boot`/`web`/`ios-tuist`/`android`）
   的 tree；按 manifest 重算 checksum，不符 fail closed（沿用 M2 §2.4 的"任一步不符在写入
   前失败"）。**不需要 annotated tag peel**——`resolveRef`/`resolveCommit` 对一个已经是
   40-hex 的输入应直接短路为"确认存在"，不解析可移动 ref。
6. 对每个 component 判定 disposition：其 `path`（原始值，见 D21）在**本 preflight 第 4
   步**读到的 main tree 里已存在**任意**条目 → `noop`；否则 → `create`（pending）。
   `projects.yaml` 里已不存在、但 `main` 上仍有对应目录的历史 component → 不处理，只记
   `warning`（D3）。
7. 对每个 pending（`create`）component：校验其 `owner`（team slug，D23）是已存在的 org
   team 且 ≥1 active member（同 M2 D13 的"只校验+不创建"），缺失/成员为 0 → `blocked`。
   已存在（`noop`）的 component 不需要这一步（其 owner 在当年 scaffold 它时已经校验过）。
8. 若 pending 集合为空 → 报告"无待生成 component"，退出码 `0`，不建分支/PR。

**生成（仅当 pending 非空）**：
1. 用 `ComponentRenderContext`（`{product, repo, owners: 占位, component: {id, path,
   owner}}`）对每个 pending component 调用 `renderTree`（D2 放开字面量限制后原样复用）→
   得到该 component 的渲染文件集 + `output_tree_sha256` + 供 §4 `<path>/template.lock`
   的字段。
2. 计算 `operation_id`（§2.2）与分支名 `sdd/scaffold-<operation_id 前 12 位 hex>`（D11）。
3. **查该分支名当前的外部状态，并核对候选 PR 的身份**（D20）：
   - 用 `GET /repos/{owner}/{repo}/pulls?head={owner}:{branchName}&state=all` 查该
     head 分支名是否有 PR；同时查该分支 ref 是否存在。
   - 若查到候选 PR：**显式核对**其 `base.repo`/`base.ref==='main'`/`head.repo`/
     `head.ref===branchName` 均与目标仓/分支一致（不只信任查询参数——`head` 参数虽已
     限定 owner，仍要核对返回对象本身，防止任何查询/解析层面的意外）；不一致 → 异常外部
     状态，`conflict`，不采信；一致则记下这次响应自带的 `head.sha`，后续步骤直接用它，
     **不再另外调用 `git/ref/heads/{branch}`**（避免两次读之间再产生一次竞态）。
   - 分支 ref 和 PR 都不存在 → 跳到第 5 步全新构建。
   - 分支 ref 存在，或找到（身份核对通过的）PR → 继续第 4 步先做内容校验，再决定怎么走。
4. **内容完整性校验（D20，调用 §0 D25 的共用原语，仅当第 3 步发现分支 ref 或 PR 已存在时
   执行；只读，不写）**：校验对象是（有 PR 时）第 3 步核对过的 `head.sha`，或（无 PR 但
   分支存在时）分支 ref 指向的 commit；对每个 pending component，用本节第 1 步已经算出
   的渲染结果作为"期望文件集"，调用 D25。
   - **D25 判定不通过**（任一文件缺失、多出、或内容不符——即 D25 定义下该 component 子树
     与期望不完全相等）→ `conflict`，不动它，不覆盖、不删除、不强推，报告需要人工介入的
     具体分支名。
   - **D25 判定全部通过** → 按第 3 步查到的 PR 状态分流：
     - 找到 `open` PR → 复用（`disposition=noop`，"already in progress"），跳过第 5、6
       步的建分支/开 PR，直接到第 7 步返回 `await-human-merge`。
     - 找到 `merged` PR → 理论上不会走到这里（第 3 步 preflight 的 disposition 判定会先
       把这些 component 标为已存在 `noop`）；异常出现视为 `conflict`。
     - 找到 `closed`（未合并）PR → `blocked`，人工决定（重开该 PR，或删除旧分支后重试）。
     - **分支 ref 存在但没有任何 PR**（open/merged/closed 都找不到）→ 这正是"`createRef`
       成功、创建 PR 前崩溃"的正常中间态：**跳过第 5 步（不重建分支）**，直接执行第 6 步
       用该已存在的分支补建 PR。
5. **`publishComponentBranch`**（新写操作，D4，仅当第 3 步判定"分支 ref 与 PR 都不存在"
   时执行——即真正的全新构建，不是恢复路径）：为所有 pending components 的渲染文件（含
   各自的 `<path>/template.lock`）建 blob；以**当前 main tree**（preflight 第 4 步读到的
   那份）为 `base_tree` 建完整 tree（断言：每个待写路径都以某个 pending component 的
   `path` 为前缀；断言：这些路径在 `base_tree` 里均不存在——若存在则整批 `conflict` 中止，
   零写，防止 preflight 观测之后发生的竞态）；建 commit（parent = 当前 main tip）；
   `createRef` 建立该 scaffold 分支（**从不 force**）。
6. **`upsertScaffoldPull`**（在"全新构建"之后、或在第 4 步判定"分支存在但无 PR"之后执行；
   复刻 `upsertBootstrapPull` 的建 PR 逻辑）：head=scaffold 分支，base=`main`，
   `team_reviewers` 取 pending components 的 `owner` 去重后的并集（D23，不使用
   `reviewers` 参数——`owner` 是 team slug 不是用户名）；PR body 包含 `operation_id`、
   每个 component 的 `template`/`template_ref`/`resolved_commit`，以及 §3.4 所述的批准
   溯源摘要。
7. 返回 `nextAction: 'await-human-merge'`，退出码 `4`（同 `product init` 的"不轮询占用
   进程"原则）。
8. **幂等（D20）**：同一 `operation_id` 重跑 → 第 4 步内容校验通过 + 找到 `open` PR →
   纯复用，零写，与 main 是否在期间前进无关（判定只看分支自身内容，不重新对比 main）。
   pending 集合因新批准而变化 → 新 `operation_id` → 新分支/PR，旧分支不受影响、不被删除
   （不像 M2 的"仅一次性 Bootstrap PR"，scaffold 在产品生命周期内可能多次发生）。
9. **merge-time 重新校验（D24，不由本命令执行，由 GitHub + `PR hygiene` 在人工 review
   期间自动发生）**：本命令返回后，若 main 在该 Scaffold PR 被合并前又前进，`sdd-main`
   的 `strict_required_status_checks_policy` 会在合并前要求分支更新，触发 `PR hygiene`
   重新核对：(a) 本 PR 新增的每个 `<path>/template.lock` 记录的 component 是否仍能在
   **当前** main 的 `projects.yaml` 里找到匹配项；(b) 用当前 main 读到的 component 信息
   独立重新渲染，调用 D25 核对 PR head 实际文件是否仍与批准的模板一致（不信任 PR 里
   lock 文件自己的声明）。任一层不匹配则合并被阻塞（详见 §3.6）。这一步与本命令的
   preflight（D18）互补，不是本命令自己要做的事。

### 2.4 包结构与 M2 factory 复用清单

```text
factory/src/
├─ index.ts              # 扩展导出 scaffold 相关类型/函数（同一 barrel，不新建子包）
├─ resolve.ts             # 既有；按 D2 放开 TEMPLATE_NAMES 闭集校验
├─ render.ts              # 既有；renderTree 改为从入参取 template name/path（D2）
├─ scaffold/
│  ├─ types.ts            # ScaffoldInput / ScaffoldPlan / ComponentPlan / ScaffoldResult /
│  │                       # ScaffoldReadPort / ScaffoldWritePort / ComponentRenderContext
│  ├─ plan.ts             # compileScaffoldPlan（纯函数：输入+只读 port→ScaffoldPlan，
│  │                       # 镜像 plan.ts 但对 projects.yaml 里每个 component 循环）
│  ├─ render.ts           # renderComponent（复用 render.ts 的 renderContent/tokenMap，
│  │                       # 扩展支持 ComponentRenderContext；产出 <path>/template.lock 内容）
│  ├─ subtree.ts          # verifyComponentSubtree（D25 共用原语：给定 path + 期望文件集
│  │                       # + 目标 tree，递归读该 path 前缀下的条目、集合相等校验、逐
│  │                       # 文件 fetch blob content 算 sha256(content) 比对，见 §0 D25）
│  ├─ publish.ts          # publishComponentBranch + upsertScaffoldPull（新写操作，D4/§2.3，
│  │                       # 内部调用 subtree.ts 做复用前的内容完整性校验，D20）
│  └─ apply.ts            # applyScaffoldPlan（状态机：PLANNED→COMPONENTS_RENDERED→
│                          # BRANCH_PUBLISHED→PR_OPEN→AWAITING_HUMAN→COMPLETE，无 finalize 阶段）
├─ init.ts · github-read.ts · github-write.ts   # 既有（product init），不改动
├─ gate-hygiene.ts        # 既有（M2c）；新增 Scaffold PR 专属规则分支（D24，§3.6/§5.3）——
│                          # 第一层：识别依据 + 读当前 main projects.yaml + 逐 component 比对；
│                          # 第二层：对当前 main 读到的 component 信息独立重新渲染
│                          # （resolveCommit/readTemplateTree/renderComponent），调用
│                          # scaffold/subtree.ts（D25）核对 PR head 实际文件
└─ ...
provenance/src/verify.ts   # 签名不变；需要 §9.1/§3.5 的 gate label 存在性修复（D22，M3 前置）
cli/src/
├─ commands/product/scaffold.ts   # 新命令，镜像 product/init.ts 的参数解析/校验/输出风格
├─ git-reader.ts                  # 新：createLocalGitReader(repoRoot)，GitReader 首个具体实现（D8）
└─ local-reader.ts                # 既有；readTemplateTree 通用性已足够（按 D2 传入模板名即可）
```

**与 `GitHubReadPort`/`GitHubWritePort`（product init 用）的关系**：`resolveCommit` 与
`readTemplateTree` 两个方法**原样复用**（对 `(repo, commit, path)` 通用，只需 D2 的字面量
放开）；但 `observe(input: ProductInitInput)` 的返回形状（`repositoryExists` 等，围绕"目标
仓是否存在"设计）不适用于 scaffold 场景——scaffold 的目标仓**已存在**，需要的是"当前 `main`
tree + 各 component 路径是否已有内容 + 是否已有打开/已合并/已关闭的 scaffold PR（含验证
过身份的 `head.sha`，D20）+ 一个能读任意 tree 递归条目、并能按 blob SHA 取回实际内容的
读取能力（供 D25 的 `subtree.ts` 使用——D25 需要真正 fetch blob content 算
`sha256(content)`，不是只读 tree 里的 blob SHA）"。因此新增 `ScaffoldReadPort`（含
`resolveCommit`/`readTemplateTree` 复用 + 新增 `observeProduct` + 新增
`readTreeRecursive`/`readBlobContent` 这类原语，供 `subtree.ts` 组合使用），与
`GitHubWritePort` 平行新增 `ScaffoldWritePort`（`publishComponentBranch` +
`upsertScaffoldPull`），两者可共享
同一个 octokit 适配器实现（`github-read.ts`/`github-write.ts` 内新增函数，不是新建独立
客户端）。

### 2.5 恢复、幂等与并发

沿用 M2 D11 的哲学：phase 由 GitHub 实际状态推导（当前 scaffold 分支/PR 是否存在、其内容是
否等于本次计划），不在本地存 checkpoint；默认不删分支/不关 PR/不 force/不回滚；失败用同一
输入重跑收敛。与 `product init` 的差异：scaffold 没有"仓库创建"阶段（目标仓已存在），状态机
更短：

```text
PLANNED → AUTHORIZATION_VERIFIED → COMPONENTS_RENDERED → BRANCH_PUBLISHED
        → PR_OPEN → AWAITING_HUMAN → COMPLETE
```

并发：无本地锁，靠 GitHub 条件更新（分支 ref 只在不存在时 `createRef`，绝不对已存在的分支
重新写入；PR 按 head 分支查找去重）做并发控制；两个 scaffold 调用同时针对同一 pending 集合
竞争时，先到者建分支+开 PR，后到者观察到分支/PR 已存在，经 D20 的内容完整性校验确认内容
与自己预期一致后收敛为 noop/复用，不产生重复分支或重复 PR、也不会因为"没校验就信任"而
悄悄放过被篡改的分支。

### 2.6 权限

真实执行所需权限 = `product init` 已列出的产品仓写权限子集（Contents:write、Git Data
refs/blobs/trees/commits、Pull requests:write）+ **`@sdd/provenance` 校验所需的读权限**
（`Pull requests:read`、`Checks:read`、`Organization Members:read` 用于 CODEOWNER 团队
解析）+ **读取产品仓/组织受管 ruleset 与 required workflow source pin 的权限**（D26，用于
证明当前 CLI generator 与 merge-blocking hygiene 来自同一平台仓 commit）——这些权限现在作用于**同一个仓库**（产品仓），不像 `product init` 时 provenance
校验与写目标分属不同仓库阶段。此外需要平台仓 `Contents:read`（解析模板字节）。安全约束
（模板源仓 allowlist、路径 POSIX normalize + root containment、拒 symlink/`..`、日志
redact 凭据）沿用 M2 §2.7，不重复定义。

## 3. 强制授权校验（M3 是首个强制点）

### 3.1 CLI 如何定位 Gate PR

`@sdd/provenance` 的 `verifyGateApproval` 要求调用方**明确**给出 `approval: {pr:number} |
{mergeCommitSha:string}`——不支持"按 label 搜索"，因为同一 version 可能有多个已合并 Gate
PR，且 label 可被改（M1 §4 point 2）。M3 的 CLI 因此把这个要求原样暴露给使用者：
`--architecture-pr <n>` 或 `--architecture-merge-sha <sha>`（二选一，真实执行必填）+
`--architecture-version <v>`。运维/Commander 在批准 Architecture Gate PR 并合并后，把该 PR
号或 merge commit SHA 作为 scaffold 调用的入参——这通常就是"刚合并的那个 PR"，人工场景下
一目了然（合并按钮所在页面即是），不需要额外的自动发现。

M1 文档中提到的"配套（非 M1 强制）"发现步骤 `listGateApprovals({gate, version})`（按 label +
已合并状态列出候选 PR）**在 M3 中不实现**，保持"非强制"定位——它只是给人工挑选提供列表，
挑选结果仍需喂给 `verifyGateApproval` 做真正校验；把它做成默认路径会引入"按可变 label 自动
选 PR"的风险，与 fail-closed 精神冲突。若未来需要更友好的 CLI 体验（例如"帮我列出所有已合并
的 `gate:architecture` PR 供选择"），可作为独立的、明确标注"仅辅助定位、结果仍须显式确认"的
子命令另行提案，不属于 M3 范围。

### 3.2 新增 `GitReader` 实现（产品仓本地 worktree）

`provenance/src/types.ts` 定义的 `GitReader` 接口（`blobAt(commit, path)` /
`blobWorktree(path)` / `isClean(path)` / `codeownersAt(commit)`）目前**没有任何具体实现**
——`provenance/test/verify.test.ts` 全程用 mock。M3 需要交付第一个真实实现：

```ts
// cli/src/git-reader.ts
export function createLocalGitReader(repoRoot: string): GitReader {
  return {
    blobAt: (commit, path) => /* `git show <commit>:<path>` → blob bytes → sha256 或走
                                  `git rev-parse <commit>:<path>` 直接拿 blob SHA（更直接，
                                  避免多算一次 hash；provenance 只比较 blob SHA 是否相等） */,
    blobWorktree: (path) => /* `git hash-object <repoRoot>/<path>`：working tree 文件的
                                blob SHA（不经过任何 commit，未 add 的改动也能正确反映） */,
    isClean: (path) => /* `git status --porcelain -- <path>` 输出为空 */,
    codeownersAt: (commit) => /* `git show <commit>:.github/CODEOWNERS` → 用与
                                  provenance/src/verify.ts 里 matchCodeownersPattern 相同的
                                  解析规则转成 CodeownersEntry[]（不要在 CLI 侧重新实现一遍
                                  pattern matcher——CODEOWNERS 的解析/匹配已经是
                                  verifyGateApproval 内部逻辑的一部分，这里只需要"读取 + 按
                                  行切分成 pattern/owners 对"，真正的匹配仍在 verify.ts 内） */,
  };
}
```

与 M2 `cli/src/local-reader.ts` 的 `createLocalFsReadPort`（实现 `GitHubReadPort`，读**平台
仓**模板字节，服务 dry-run 的"零网络预览"）是两个方向相反、服务不同接口的适配器：
`createLocalGitReader` 读的是**产品仓**（scaffold 的操作对象本身），且服务于
`@sdd/provenance` 的 `GitReader`，不是 `@sdd/factory` 的任何 port。两者都通过 shell 出
`git` 命令读本地状态，可考虑抽取一个共享的"从 CWD 向上找 git 仓根 + 读 remote owner/repo"
小工具（`local-reader.ts` 里的 `parseRemoteUrl`/`resolvePlatformRoot` 逻辑），避免在
`git-reader.ts` 里重复实现一遍——这是一个值得做但非强制的小重构，实现时按判断取舍。

### 3.3 dry-run 与真实执行的 fail-closed 边界

`verifyGateApproval` 全程只读（§0 D7），因此 dry-run 与真实执行都会真实调用它、如实报告
结果；两者的差异**只**在于报告结果之后做什么：

| | dry-run | 真实执行 |
|---|---|---|
| 调用 `verifyGateApproval` | 是（若提供了 approval 引用） | 是（必须提供 approval 引用） |
| `verified=false` 时 | 照常输出完整计划，`authorization.verified=false` + `reason`，`components[].disposition` 正常计算 | 打印 `reason`，**立即中止**，不解析模板/不读 main tree/不建分支，退出码 `7` |
| 是否产生 GitHub 写 | 从不（无论 verified 与否，M2 D12） | 仅 `verified=true` 时才可能产生写 |
| 未提供 approval 引用 | 允许；`verified=false, reason="no approval reference supplied"` | 参数错误，退出码 `2`（`--architecture-pr`/`--architecture-merge-sha` 二选一为必填） |

这与 M1 对 `compile --dry-run`"可用于 Gate 评审，但必须醒目标注未批准输入，且不得产生
GitHub 写操作"的既有原则完全一致，只是把它从 backlog compile 场景搬到 scaffold 场景。

### 3.4 生成物如何绑定到批准（供审计复算）

真实执行成功后，每个新生成的 component 目录（`path`）根部都带一份 `template.lock`（§4），其中
`approved_by` 块**原样持久化** `verifyGateApproval` 返回的 `Provenance` 对象（`gate`,
`version`, `pr`, `approved_head_sha`, `merge_commit_sha`, `approved_at`,
`authorization_policy`）。Scaffold PR 的描述里同样摘录这组字段。这样：

- 人工审计只需打开 `apps/backend/template.lock`，无需搜索 issue/PR 历史，就能看到"这个目录
  是被 PR #42（merge commit `<sha>`）批准生成的"。
- 复算：审计者可以拿 `template.lock.approved_by.pr` 重新调用
  `verifyGateApproval({..., approval: {pr: 42}, artifactPath: 'projects.yaml'})`。**这不是
  "验证历史上曾经通过"，而是"验证按当前标准是否仍然通过"**——`authorization_policy:
  'current-codeowners'` 顾名思义是可撤销策略（`provenance/src/verify.ts` 的
  `resolveOwnersToLogins` 注释明确写了"intentionally a revocable policy"）：PR 本身、
  它的 merge commit、它当时的批准记录都是不可变历史，但复算时**重新判定**批准人是否
  **此刻**仍具有仓库 write 权限、team 成员资格是否**此刻**仍然有效。因此复算结果
  **不保证恒为 `ok:true`**——若原批准人此后离职、被移出 team，或 team 丧失了对该仓的
  write 权限，同一个 `{pr: 42}` 复算会合法地变成 `ok:false`。这不是缺陷、也不是"被篡改"
  才会发生的边界情况，而是策略本身刻意的设计：`template.lock` 记录的是"当时被谁批准"，
  但一个 component 的当前有效性是随组织成员变化而可能"过期"的活状态，不是永久定格的历史
  快照——这正是"current"-codeowners 名字里 current 的含义。
- 这不是"仓内账本"（plan §1 明确禁止的"可被后续 PR 改写的自证账本"）——`template.lock` 里
  的 `approved_by` 只是**复述** GitHub 上已经存在、不可变的批准事实，不构成新的信任源；
  真正的授权判定永远来自实时调用 `verifyGateApproval`，`template.lock` 只是给人看的摘要。

### 3.5 现状纠偏：`gate:<gate>` label 目前只查冲突，不查存在（D22）

本文早期版本曾声称"`verifyGateApproval` 会要求 PR 带 `gate:architecture` 与
`version:v1` label，否则判 fail"——这**与已合并的 `provenance/src/verify.ts` 实际行为
不符**，特此纠正并给出精确的修复方案。

实际代码（约第 54–71 行）：

```ts
const gateLabel = `gate:${gate}`;
const versionLabel = `version:${version}`;
const prLabels = pr.labels.map((l) => l.name);
for (const label of prLabels) {
  if (label.startsWith('gate:') && label !== gateLabel) {
    return { ok: false, reason: `PR label '${label}' conflicts with expected gate '${gateLabel}'` };
  }
  if (label.startsWith('version:') && label !== versionLabel) {
    return { ok: false, reason: `PR label '${label}' conflicts with expected version '${versionLabel}'` };
  }
}
```

这段循环只在**发现一个不等于期望值的同前缀 label**时才 fail；PR 完全没有任何
`gate:*`/`version:*` label 时，循环体从不执行，直接判过。也就是说：任何合并到 `main`、
在正确 CODEOWNERS 路径下拿到 CODEOWNER 批准的 PR，**即使从未打上 `gate:architecture`
label、从未真正走过 Architecture Gate 的流程/checklist**，只要恰好改过 `projects.yaml`，
就能让 `verifyGateApproval({ gate: 'architecture', ... })` 返回 `ok:true`。这弱于 Gate
机制本应提供的保证——"这份 `projects.yaml` 确实经过了 Architecture Gate 该有的评审"，
而不仅仅是"某个有权限的人批准了对这个文件的某次修改"。

**修复**（精确 diff 意图，供实现时对照 `verify.ts`）：在上面的循环前先加一句存在性检查——

```ts
if (!prLabels.includes(gateLabel)) {
  return { ok: false, reason: `PR does not have required label '${gateLabel}'` };
}
```

`version:<v>` **保持不要求存在**（只在存在时检查一致，即维持现状不变）：这不是疏漏，而是
对齐 M2 D5 的既有设计——版本的权威来源是 `specs/<version>/` 路径段 + PR marker，
`version:*` label 只是"按需 upsert"的辅助交叉核对，不是每个 Gate PR 都保证已经贴上（尤其
是版本标签机制上线前的历史 Gate PR）。只对 `gate:<gate>` 提高门槛，是因为这 5 个 label
在 M2 建仓时就**固定创建**（§3.1 M2"gate:spec/architecture/design/plan/contract 五个固定
label"），理论上每个 Gate PR 作者都能且应该打上，缺失是流程执行问题，不是标签基础设施
不存在的问题。

**这是 M3 实现前必须先合并的 M1 代码变更**（`provenance/src/verify.ts`，见 §9.1）。影响面
是全部五种 Gate（spec/architecture/design/plan/contract），不只 M3 用到的
`architecture`——修在源头能让 M5（backlog publish 的强制授权校验，届时会对全部五种 Gate
分别调用 `verifyGateApproval`）直接受益，不需要每个调用方各自重复一遍同样的防御。
`provenance/test/verify.test.ts` 需要新增一条回归测试：PR 完全不带任何 `gate:*`/
`version:*` label（既不冲突也不存在）→ 修复前 `ok:true`（缺陷复现）、修复后 `ok:false`。

### 3.6 三个授权校验时点，不要混淆（D18/D24 的关系）

本文的授权校验其实发生在三个不同时点，容易混为一谈，明确区分：

| 时点 | 校验什么 | 机制 | 覆盖的问题 |
|---|---|---|---|
| ① scaffold preflight（CLI 运行那一刻） | 本地 worktree == main 当前 HEAD == 指定 Architecture Gate PR 批准的内容 | `verifyGateApproval` + D18 的 main 新鲜度校验 | "引用一个已被取代的旧 PR 号"（重放） |
| ② 同一次运行内的生成阶段 | 不重新校验授权——preflight 已经确认过，生成阶段只管渲染/写分支/开 PR，全程发生在①的同一次进程调用里，中间没有"等待"窗口 | 无（复用①的结果） | 不适用；如果需要更长的等待，见③ |
| ③ merge 前（人工 review 期间，可能长达数小时/数天） | 两层：(a) Scaffold PR 里新增的每个 `<path>/template.lock` 所记录的 component，是否仍然存在于**此刻**的 main `projects.yaml` 里；(b) PR head 里该 component 的实际文件，是否仍与"用当前 main 的 component 信息独立重新渲染"得到的期望内容一致（D25） | `PR hygiene` 的 Scaffold PR 专属规则 + ruleset 的 `strict_required_status_checks_policy`（D24） | (a) "main 在 PR 存续期间被新 Gate 改写，但 PR 本身不碰 `projects.yaml` 所以不会显示冲突"（TOCTOU）；(b) "PR 打开后又推 commit 篡改应用文件（可能同时篡改 lock 文件让二者继续对得上）" |

①②发生在 CLI 一次调用内部，是"生成时"的授权证据；③发生在 GitHub 上、可能远晚于①，是
"合并时"的内容仍然有效性证据。两者验证的对象也不同：①②比对的是"本地/main 是否等于**某个
指定 PR** 批准的内容"（`verifyGateApproval` 需要一个明确的 `approval` 引用）；③(a) 比对的是
"main **当前**是否仍然包含这个 component"（不需要重新指定 PR，只需要读当前 `projects.yaml`
并查找匹配项）——这一层故意设计得更简单，因为它要解决的不是"这份内容曾被谁批准"，而是"这份
内容现在是否还作数"；③(b) 比对的是"PR 此刻的实际文件"，且**关键地不信任 PR 自己携带的
`template.lock`**——只把 main 的 `projects.yaml`（受 Gate 保护）和平台仓在被钉住的
`template_ref` 上的内容（不可变历史）当作真相来源，因为 PR 分支上的任何文件（包括
`template.lock` 自己）都可能被同一次篡改一并改掉。

## 4. per-component `template.lock`

每个 scaffold 生成的 component 目录根部带一份 `<path>/template.lock`（**不是**扩展 M2
写在产品仓根部的 `template.lock`——两者是平行的两层：根 lock 记录 monorepo-root 控制骨架的
来源，per-component lock 记录该平台模板的来源 + 批准它的 Gate）：

```yaml
schema_version: 1
generator:
  package: "@sdd/factory"
  version: "<x.y.z>"
  resolved_commit: "<40-hex>"     # CLI 构建嵌入值；必须等于 required PR hygiene workflow pin
source:
  repository: "<org>/sdd-platform"
  resolved_commit: "<40-hex>"      # projects.yaml 里该 component 的 template_ref 原值
template:
  name: "spring-boot"
  path: "templates/spring-boot"
  manifest_sha256: "sha256:..."
  source_tree_sha256: "sha256:..."
  output_tree_sha256: "sha256:..."
component:
  id: "backend"
  path: "apps/backend"
  owner: "backend-team"
approved_by:
  gate: "architecture"
  version: "v1"
  pr: 42
  approved_head_sha: "<40-hex>"
  merge_commit_sha: "<40-hex>"
  approved_at: "2026-05-01T12:00:00Z"
  authorization_policy: "current-codeowners"
  required_checks: []              # Provenance.required_checks；非 contract gate 恒为空数组，
                                    # 字段仍需存在——这是逐字持久化整个 Provenance 对象的一部分
files:
  - { path: "build.gradle.kts", mode: "100644", source_sha256: "sha256:...", output_sha256: "sha256:..." }
  # ... 其余渲染文件，按 path 排序
```

- canonical YAML（固定 key 顺序、无时间戳，除 `approved_at` 本身就是待记录的历史事实）；
  自身不计入 `output_tree_sha256`（同 M2 根 lock 的"避免递归"原则）。
- **owner 归属大多数情况下已由 M2 解决，但有已知边界（D23）**：Bootstrap PR 阶段写入的
  CODEOWNERS 已经包含 `/apps/backend/ @org/backend-team` 等四条 stanza（渲染自
  `product-init.yaml` 的 `owners.{backend,web,ios,android}` 映射，即使当时目录尚不存在）。
  M3 不需要再碰 CODEOWNERS——若某 component 的 `path` 恰好落在这四条之一（最常见情形），
  `<path>/template.lock` 落地时其归属规则已经生效。但若 `path` 不落在这四条覆盖范围内
  （同一模板类型的第二个 component、或更深层嵌套路径），required CODEOWNER 审查会退回到
  通配符 `* @org/<admins>`，`upsertScaffoldPull` 请求的 `team_reviewers` 仍正确指向该
  component 声明的 `owner` 团队（评审路由正确），但正式过 gate 需要 admins——这是 M2
  CODEOWNERS 设计的既有边界，M3 不在此处解决（详见 §0 D23）。
- **与 M8 `sdd sync --check` 的关系**：M8（非本文范围）读取根 `template.lock`
  判断根骨架层面的定向安全更新是否适用；读取每个 `<path>/template.lock` 独立判断该
  component 的平台模板是否有需要同步的安全更新——两层互不影响，一个 component 的
  `template_ref` 落后不会误报另一个 component 或根骨架的漂移。`template.lock` 只用于审计
  与"定向安全更新是否适用"的判断，不用于自动 diff/覆盖业务代码（沿用手册 §4.6）。

## 5. 与 CI 的接缝（M3 ↔ M4 边界）

### 5.1 平台模板不含任何 CI workflow 文件（D10）

M2 D7 的理由——"仅按 check name 要求可被伪造，任何 PR 可新增同名 workflow 自满足"——同样
适用于**任何**放在产品仓、由产品 PR 可编辑的 workflow 文件，不止根骨架的 `CI Gate`/
`PR hygiene`。若 `apps/backend/.github/workflows/java.yml` 存在于产品仓内，一次被攻陷或
误操作的产品 PR 就能直接改写它来伪造"平台 CI 通过"。因此四个平台模板**都不包含**
`.github/workflows/*`：真正执行各 component 目录（`path`）下构建/测试的 reusable
workflow（`java.yml`/
`web.yml`/`ios.yml`/`android.yml`）在 **M4** 于**平台仓**集中托管，通过 §3.6（M2）已建立的
"required workflows 固定 `repository_id + path + sha`"机制接入产品仓，产品仓 `apps/*`
自身永远是纯应用代码 + 构建配置，不是可执行的 CI 入口。

### 5.2 M3 交付的是"命令契约"，不是"CI 接线"

M3 对 M4 的承诺 = §1 每个模板表格里那四条固定命令（lint/typecheck-等效/test/build）——M4
的 reusable workflow 只需要 `checkout` 产品仓、`cd` 到该 component 的 `path`、按 `ci` 字段
（`java`/`web`/`ios`/`android`）选择对应命令族执行即可，不需要猜测或解析每个组件的实际
项目结构。这些命令必须都能在**本地**（无 CI 基础设施）跑通，是 M3 自身 DoD 的一部分
（§8），与 M4 是否已实现无关。M4 的 `detect`/`sdd impact`/平台矩阵聚合、以及把这四条命令
接进 CI 拓扑，明确留给 M4；M3 不预先创建 `detect` job、不修改 `ci-gate.yml`。

### 5.3 Scaffold PR 不是 Gate PR，但不是"纯通用 PR"——有自己专属的 hygiene 规则

Scaffold PR 不带任何 `gate:*` label（它不是 spec/architecture/design/plan/contract 中的
一种审批产物，而是**已批准输入的派生生成物**），不触发 M2 §3.5 的 Gate 专属规则（label/
marker/上游批准/CODEOWNER-路径匹配）——这一点与 Bootstrap PR 相同。但**不像** Bootstrap
PR 那样落进纯通用分支：`checkPrHygiene` 需要识别"这是一个 Scaffold PR"（依据：changed
files 里有新增的 `apps/**/template.lock`），并执行 §3.6/D24 描述的 merge-time 新鲜度
重验证——这是 hygiene 逻辑里第三类分支（Gate 专属 / Scaffold 专属 / 纯通用，三选一，
互斥）。Scaffold PR 依然要满足 `sdd-main` ruleset 的通用要求（PR + 人工 approval +
CODEOWNER review + 现有 required checks `CI Gate`/`PR hygiene` 通过，`PR hygiene` 现在
额外跑第三类分支的规则），这些在 M2 `--finalize-protection` 后已经就位；scaffold 不需要
新增任何保护**资源**（D5），只需要 ruleset 里已有的 `required_status_checks` 规则加一个
参数（D24）。

### 5.4 验收：Scaffold PR 落地后，（仍是 M2 stub 的）`CI Gate` 必须保持绿

手册 §12.4"根骨架和空 scaffold 的 `CI Gate` 成功"包含两层，M2 只覆盖前一层：

- **已覆盖（M2）**：根骨架 Bootstrap PR 上，`CI Gate` 成功。
- **本文补齐**：Scaffold PR 把 `apps/*` 从"不存在"变为"有真实平台代码"后，`CI Gate`
  **依然成功**——因为 M4 的 `detect`/平台矩阵聚合尚未实现，此时的 `CI Gate` 仍是 M2 交付的
  stub（`detect` 输出四平台全 `false`，`CI Gate` 的 `needs` 里没有任何平台 job，`if:
  always()` 读 `needs.*.result` 时没有 `detected=true` 的项，恒 pass）。这一验收场景的
  意义是确认：scaffold 引入的新文件（`apps/*` 下的构建配置、`<path>/template.lock` 等）
  不会意外触发某个隐藏的失败路径——例如被 `PR hygiene` 的通用校验误判、或被某个未预期的
  YAML/清单校验规则拒绝。M3 的测试套件需要显式覆盖这一场景（§6/§9）。

## 6. 测试

- **manifest / 模板自测**（vitest，四个模板各一份，镜像 M2 `factory/test/template.test.ts`）：
  manifest 存在且校验通过；用样例 token 渲染后到 scratch 目录，跑 §1 命令契约的四条命令，
  断言全部退出码 0（spring-boot/android/web 可在 Linux CI runner 跑；ios-tuist 需要 macOS
  runner，见 §11）；manifest 与磁盘树无漂移；四个模板均不含 `.github/workflows/*`（D10 的
  守卫测试，镜像 M2 `'no workflow files in the product template (D7)'` 用例）；均不含
  `apps/`（模板本身不应该嵌套 `apps/` 路径）。
- **`resolve.ts`/`render.ts` 放开验证**（D2）：`TEMPLATE_NAMES` 闭集内的五个名字都能通过
  `validateManifest`/`parseManifest`；闭集外的名字仍然拒绝；`renderTree` 对
  `spring-boot`/`web`/`ios-tuist`/`android` 四个输入各产出正确的 `template.lock.template.
  {name,path}`（不再硬编码 `monorepo-root`）。
- **`compileScaffoldPlan` 确定性**（镜像 M2 D12 测试）：固定排序、`operation_id` 只由
  pending components 决定（已存在的 noop component 变化不影响它）、每种 disposition、
  无 volatile 字段、text/json 同一 model；相同输入两次 **byte-identical**；recording
  transport 断言 dry-run **mutation count=0**。
- **`createLocalGitReader`**（新，真实 git 操作，非 mock）：在一个 scratch git 仓库 fixture
  上验证 `blobAt`/`blobWorktree`/`isClean`/`codeownersAt` 对"干净 worktree"、"脏
  worktree"、"worktree 内容与某历史 commit 一致/不一致"、"CODEOWNERS 含 team/个人写法"
  各种情况返回正确结果；这是 `GitReader` 接口的第一个非 mock 实现，需要独立于
  `provenance/test/verify.test.ts` 已有的 mock 测试。
- **provenance 接线**（mock `verifyGateApproval` 或用真实 `verifyGateApproval` + mock
  octokit/`GitReader`，二选一，偏向后者以验证真实接线）：approval 引用缺失/PR 未合并/
  label 与 gate 或 version 不符/`artifactPath` 不在该 PR changed files/blob 不一致/
  worktree 脏/非 CODEOWNER 批准/API 抛错 → 真实执行 fail closed、退出码 `7`、零写；
  dry-run 同样输入 → 仍出计划，`authorization.verified=false`；全部条件满足 → 真实执行
  继续到渲染/发布阶段。
- **`gate:<gate>` label 存在性回归**（D22，直接对应 §3.5 的 M1 修复）：PR 完全不带任何
  `gate:*`/`version:*` label（既不冲突也不存在）→ `verifyGateApproval` 必须 fail（修复前
  会是缺陷性的 `ok:true`，此用例本身即回归测试）；只带 `version:v1` 不带 `gate:architecture`
  → fail；只带 `gate:architecture` 不带任何 `version:*` → ok（version 不要求存在）。
- **main 新鲜度校验**（D18）：本地 worktree 的 `projects.yaml` 与 `--architecture-pr` 指定
  PR 的批准内容一致，但**当前 main** 的 `projects.yaml` 已被后续 Architecture Gate 改写
  （模拟"落后 checkout + 引用旧 PR 号"场景）→ preflight 必须 fail closed，退出码 `7`，零写
  （这是本节要防止的具体重放场景，需要一个显式的失败用例，不能只测"一切都新鲜"的正向路径）；
  main 与本地一致 → 继续正常流程。
- **`template_ref` 40-hex 校验**（D19）：`projects.yaml` 里某 component 的 `template_ref`
  是 tag/branch 名（如 `"v1.0.0"`）而非 40-hex → schema 校验阶段即拒绝，退出码 `2`，不到
  provenance/渲染阶段；是合法 40-hex 但在平台仓不可达的 commit → preflight `blocked`。
- **`owner` team 校验**（D23）：pending component 的 `owner` 指向不存在的 team → `blocked`；
  team 存在但 0 active member → `blocked`；team 存在且 ≥1 active member → 通过，且
  `upsertScaffoldPull` 用 `team_reviewers`（断言测试没有把它误传进 `reviewers`）。
- **可信重渲染上下文（D26）**：CLI 未嵌入 generator commit、嵌入值与受管 required workflow
  pin 不同、或找不到唯一受管 pin → 真实 scaffold `blocked`、零写；二者相等 → lock 写入该
  `generator.resolved_commit`。Architecture Gate PR 缺少 `version:<v>`、有多个 version
  label、或与 `--architecture-version` 不符 → exit `7`。hygiene 只把 PR lock 中的
  `approved_by.pr` 当候选 locator：候选 Gate/version/审批任一复核失败 → 红 check；成功时
  断言期望 lock 的 `approved_by` 来自 verifier 返回值，而非 PR lock 原值。
- **create-only / 幂等**（D3）：`projects.yaml` 含 3 个 approved components、`main` 上已
  存在其中 1 个的目录 → 只对另外 2 个生成；重跑（无 `projects.yaml` 变化）→ 全部 noop、
  零写、退出码 `0`；`projects.yaml` 移除一个已生成的 component → 该目录不被删除，只产出
  `warning`；已生成目录事后被人工修改 → 重跑 scaffold 不覆盖它（`disposition` 仍是
  `noop`，只看"该路径是否已有内容"，不比较内容与当前模板是否一致）。
- **`verifyComponentSubtree`（D25，独立单测，`scaffold/subtree.ts`）**：这是本轮修复的
  核心，需要专门测试而不是只在 D20/D24 场景里间接覆盖：
  - **哈希空间回归测试**：构造一个文件，其 Git blob SHA（`sha1("blob "+len+"\0"+content)`）
    与其 `sha256(content)` 的十六进制前几位恰好"看起来都像哈希"但数值不同——断言实现读的
    是 blob **内容**算 `sha256`，而不是直接拿 tree 条目的 blob SHA 去比 `output_sha256`
    （后者对任何输入都会不匹配，第 2 稿的原始 bug）；正向用例内容完全一致时必须判定通过，
    证明真的会去 fetch blob content，不是恰好蒙对。
  - **子树作用域**：目标 tree 在 `path` 前缀之外还有大量其它文件（`specs/**`、根
    `template.lock`、另一个已生成 component 的目录等）→ 这些一律不参与比对，不能导致
    误判失败；`path` 前缀**之内**缺一个期望文件、多一个计划外文件、或某文件内容不符 →
    这三种情况各自单独判定失败（不能只测"整体不通过"，要能定位具体是哪一类）。
- **`publishComponentBranch`/`upsertScaffoldPull` 与 D20 的 PR 身份核对、幂等**（mock
  octokit，镜像 M2 的 `publishSnapshot`/`upsertBootstrapPull` 测试风格）：只允许
  pending components 的 `path` 前缀，混入任何其它前缀的路径 → 拒绝；`base_tree` 取当前
  `main` 的实际 tree（不是空/seed tree）；
  - **查到的候选 PR 的 `base.repo`/`base.ref`/`head.repo` 与目标不符**（模拟"仅凭同名
    head 查错 PR"，例如构造一个 fork 上同名分支开出的 PR 混进 mock 返回列表）→
    `conflict`，不采信、不使用其 `head.sha`。
  - **分支和 PR 都不存在** → 全新构建（`createRef`，从不 force），随后 `upsertScaffoldPull`
    建 PR。
  - **分支存在、`verifyComponentSubtree` 全部通过、且找到身份核对通过的 `open` PR** →
    纯复用（disposition=`noop`），断言**不会**重新调用 blob/tree/commit（即使在两次调用
    之间人为推进 main，也不触发任何写——main 在两次调用之间前进不会导致误判 `conflict`，
    这是 D20 要直接覆盖的回归场景），且断言使用的是 PR 响应自带的 `head.sha`、没有另外
    调用 `git/ref/heads/{branch}`。
  - **分支存在、`verifyComponentSubtree` 全部通过、但没有任何 PR**（模拟"`createRef`
    成功、创建 PR 前崩溃"）→ **跳过重建分支，直接补建 PR**；断言不会重新调用
    blob/tree/commit，只调用 `upsertScaffoldPull`。这是第 2 稿修复的自相矛盾场景，必须
    有一条测试显式验证"崩溃在 createRef 之后、PR 创建之前"能收敛，且收敛路径是"补建 PR"
    而不是被误判 `conflict`。
  - **分支存在，但 `verifyComponentSubtree` 不通过**（模拟人工推了额外/不同的 commit，
    或 hash 派生分支名发生碰撞）→ 无论是否找到 PR，一律 `conflict`，零写，不覆盖、不
    删除、不强推。
  - **分支名对应的 PR 已 `merged`**（异常状态，正常流程不会到达）→ `conflict`；**分支名
    对应的 PR 已 `closed`（未合并）** → `blocked`。
  - 失败注入（blob 后/tree 后/commit 后/ref 创建前后/PR 创建前后各崩溃一次）+ 同输入
    重跑 → 每种崩溃点都必须收敛到"内容校验通过后走对应分支"，不能有任何崩溃点导致误判
    `conflict` 或重复写。
- **`checkPrHygiene` 的 Scaffold PR 专属规则（D24，两层都要覆盖）**（mock octokit）：
  - **第一层**：PR 新增 `apps/backend/template.lock`，无 `gate:*` label，当前 main 的
    `projects.yaml` 仍含匹配的 `{id, path, template, template_ref}` → 该层通过；main
    已被后续 Gate 改写、该 component 消失或 `template_ref` 变化 → 该层失败（红 check）。
  - **第二层（专门针对"协同篡改"设计的用例，回应本轮评审）**：第一层通过（main 里
    component 仍然批准）的前提下，PR 又推了一个额外 commit，**同时修改了某个应用文件
    （如 `build.gradle.kts`）和该 component 的 `template.lock` 里对应的 `output_sha256`
    字段（让两者继续互相"对得上"）**——断言第二层依然判定失败，因为它不读、不信 PR 里的
    lock 文件，而是用当前 main 的 component 信息独立重新渲染后比对 PR head 实际内容；
    只篡改应用文件、不改 lock 文件 → 第二层同样失败（更容易的情形）；PR 未被篡改 → 第二层
    通过。
  - PR 同时带 `gate:*` label（不应该发生，但需要断言此时走 Gate 专属规则而非 Scaffold
    专属规则，二者互斥）；PR 不含任何新增 `template.lock`（普通实现 PR）→ 不触发本规则，
    走纯通用校验。
  - 第二层重新渲染读平台仓模板时，断言走的是对 `template_ref` 这个历史 commit 的 API 读取
    （`resolveCommit`/`readTemplateTree`），不是 hygiene workflow 自己 checkout 出来的
    （为运行 `sdd` 而固定的）本地文件；同时断言运行中 generator commit 等于 required
    workflow pin，并用重新验证得到的 Provenance 重建完整 `template.lock`。generator commit
    或 `approved_by` 被篡改时，即使应用文件未变也必须失败。
- **`sdd-main` ruleset 的 `strict_required_status_checks_policy`（D24）**（mock
  octokit，验证 `reconcileRepositoryRuleset`/`finalizeProtection` 写入的
  `required_status_checks` 规则参数包含该字段且为 `true`）。
- **§12.4 第二层**（§5.4）：构造一个已完成 `--finalize-protection` 的产品仓 fixture（`CI
  Gate`/`PR hygiene` 已是 required check），运行一次 scaffold 生成非空 `apps/*` 后，
  该 PR 上的 `CI Gate`（M2 stub）与 `PR hygiene`（含新的 Scaffold PR 专属规则，因为 main
  未变化，规则应通过）仍然成功。
- **隔离 org E2E**（手动/CI 编排，非 vitest，镜像 M2 §5.1 风格，复用同一 test org 与
  harness）：在一个已 `--finalize-protection` 的测试产品仓上，先跑未批准输入的 dry-run
  （确认 `verified=false` 但仍出计划、零 mutation）；再用真实已合并 Architecture Gate PR
  的 `--architecture-pr` 真实执行，确认停在 `AWAITING_HUMAN`（exit 4）、PR 只含获批
  component 目录、`team_reviewers` 为对应 owner 团队；**在人工合并该 PR 前，先向该测试仓
  推一个与 scaffold 无关的普通 commit 到 main**（模拟"main 在两次调用之间前进"），重新跑一次
  同输入 dry-run 与真实执行，确认幂等收敛、不误判 `conflict`（D20 的端到端验证）；**再用
  真实的另一个 Architecture Gate PR 把该 Scaffold PR 正在生成的 component 从 main 的
  `projects.yaml` 中移除或改写 `template_ref`，尝试点击合并该 Scaffold PR**——因
  `strict_required_status_checks_policy` 要求先更新分支，更新后 `PR hygiene` 重新运行，
  断言该检查此时变红、合并被阻塞（D24 的端到端验证，这是本轮评审要求的关键场景）；人工
  批准并合并未受影响的 Scaffold PR；重跑 scaffold → 全 noop；修改（新批准）另一个平台后
  重跑 → 只生成新目录，旧目录不变、旧 PR 分支不受影响；未批准/被篡改的本地
  `projects.yaml`（worktree 脏或 blob 与批准版本不符）→ 真实执行 fail closed、零写；
  **引用一个已被后续 Architecture Gate PR 取代的旧 `--architecture-pr`**（本地 checkout
  停留在旧版本）→ main 新鲜度校验 fail closed、零写（D18 的端到端验证）；**在另一个
  Scaffold PR 上直接（人工/脚本）推一个 commit，同时修改其中一个应用文件和对应
  `template.lock` 的 `output_sha256`**，让二者继续互相一致——断言 `PR hygiene` 的
  Scaffold PR 专属规则第二层依然变红（D25/D24 第二层的端到端验证：不能靠篡改 lock 文件
  本身来绕过校验）。

## 7. 交付文件树

```text
sdd-platform/
├─ schemas/projects.schema.json                             # §9.1 前置补丁 #1/#2（D19/D23）
├─ provenance/src/verify.ts + test/verify.test.ts            # §9.1 前置补丁 #3（D22）
├─ factory/src/init.ts（或 finalize 逻辑所在文件）           # §9.1 前置补丁 #4：ruleset 加
│                                                             # strict_required_status_checks_policy（D24）
├─ templates/{spring-boot,web,ios-tuist,android}/**          # §1 四个平台模板
├─ templates/{spring-boot,web,ios-tuist,android}.manifest.json  # 生成（D2）
├─ scripts/build-template-manifest.ts                       # 参数化为 --template <name>（D2）
├─ factory/src/scaffold/{types,plan,render,publish,apply,subtree}.ts + test/**   # §2.4，
│                                                             # subtree.ts = D25 共用原语
├─ factory/src/{resolve,render}.ts                           # 放开 TEMPLATE_NAMES 闭集（D2）
├─ factory/src/gate-hygiene.ts + test/**                     # 新增 Scaffold PR 专属规则（D24，M3 自身范围）
├─ cli/src/commands/product/scaffold.ts + test/**            # §2.1
└─ cli/src/git-reader.ts + test/**                           # §3.2（D8）
```

前三项（M1/M2 补丁：schema 两处、`verify.ts`、ruleset 参数）建议独立成一个先行 PR，与
M3 主体实现解耦（§9.1）；`gate-hygiene.ts` 的 Scaffold PR 规则本身是 M3 的新增业务逻辑，
不是"补丁"，随 M3 主体一起交付。

## 8. M3 完成定义（DoD）

- 四个平台模板完整（§1 全部文件）并自校验（§1.5）：manifest 存在且无漂移；渲染样例 token
  后可实际 lint/typecheck/test/build（ios-tuist 允许在 macOS runner 或人工验证完成，见
  §11）；均不含 `.github/workflows/*` 与嵌套 `apps/`。
- `sdd product scaffold --dry-run` 对已批准与未批准输入均产出确定性报告（byte-identical、
  canonical JSON、零 GitHub 写），如实反映 `authorization.verified`。
- `sdd product scaffold`（真实执行）：未通过 `verifyGateApproval` → fail closed、零写、
  退出码 `7`；通过 → 只为 pending components 生成目录，经 `publishComponentBranch` +
  `upsertScaffoldPull` 落地为 Scaffold PR，停在人工 review/merge（退出码 `4`）。
- Create-only 语义（D3）全部测试通过：已存在目录 noop、移除的 component 不删除、重跑收敛。
- 幂等性在 main 于两次 scaffold 调用之间前进后依然成立（D20）：已开 Scaffold PR 不会被
  误判为 `conflict`，也不会被重建；`template_ref` 必须是 40-hex commit SHA（D19）在
  schema 层面强制，不接受可移动 ref。
- **已存在的分支/PR 在被复用或补建前，内容完整性均已校验，且校验本身用的是正确的哈希
  空间**（D20/D25，第 3 稿修复）：校验通过 `fetch blob content → sha256(content)`
  与 `output_sha256` 比较，**不**用 Git 自己的 blob SHA（两者是不同哈希函数、不同输入，
  数值永不相等）；校验范围严格限定在每个 pending component 各自的 `path` 子树内，子树
  外的既有内容（`base_tree` 继承来的）不参与也不影响判定；内容与预期不符（被篡改/子树内
  多出/缺少文件）→ `conflict`，不静默信任；候选 PR 的 `base`/`head` 仓库与 ref 经显式
  核对，不只凭同名 head 分支判定；"`createRef` 成功、PR 创建前崩溃"这一具体场景有测试
  证明可以补建 PR 收敛，不会被误判 `conflict`（修复第 2 稿的自相矛盾，§6）。
- **Scaffold PR 的 merge-time 新鲜度重验证已交付并测试覆盖，且验证的是 PR 的实际文件而
  不只是它自称的元数据**（D24，第 3 稿修复）：`sdd-main` 的 `required_status_checks`
  规则带 `strict_required_status_checks_policy: true`；`checkPrHygiene` 新增的
  Scaffold PR 专属规则两层都能在 main 于 PR 存续期间被后续 Architecture Gate 改写、或
  PR 自身文件被篡改（即使连带篡改了 `template.lock` 让二者继续互相一致）时，经"强制
  更新分支 → 重新触发 hygiene"正确阻止合并（隔离 org E2E 场景，§6）——第二层的期望内容
  完全独立重新渲染得出，不读取、不信任 PR 里 `template.lock` 自己的声明。
- **merge-time 独立重渲染的可信输入闭环**（D26）：真实 scaffold 的 generator commit 与
  required `PR hygiene` workflow pin 相等并写入 lock；Architecture Gate 有唯一匹配的
  version label；hygiene 将 lock 的 PR 号仅作候选定位，重新验证 Gate 并以 verifier 返回的
  Provenance 重建 lock，不信任 PR 自报的 `approved_by` 或 generator 字段。
- 每个生成的 `<path>/template.lock` 含完整 `source`/`template`/`component`/
  `approved_by`/`files`（含 `required_checks` 字段，即使为空数组），`approved_by` 与调用
  `verifyGateApproval` 得到的 `Provenance` 一致；复算说明文档准确描述其"按当前标准重判"
  语义，不声称恒定成功（§3.4）。
- §9.1 列出的四处 M1/M2 补丁（`template_ref`/`owner` schema pattern、`verify.ts` 的
  gate label 存在性修复、`sdd-main` ruleset 的 strict 参数）已先行合并；
  `createLocalGitReader` 作为 `GitReader` 的首个真实实现交付并测试覆盖 §6；main 新鲜度
  校验（D18）与 `owner` team 校验（D23）均有测试覆盖。
- factory 的 `TEMPLATE_NAMES` 闭集放开（D2）不引入回归：`monorepo-root` 相关既有测试
  （M2 全集）继续通过。
- Scaffold PR 落地后，既有（M2 stub）`CI Gate` 与（含 Scaffold PR 专属规则的）
  `PR hygiene` 仍然成功（§5.4/§12.4 第二层）。
- 工作区全绿：`pnpm install --frozen-lockfile` + `pnpm -r build && typecheck && test &&
  lint`，无生成漂移；四个平台模板各自的自测（§1.5）在其对应 runner 上通过。

## 9. 验收映射与依赖

**§12 场景**：

- **§12.3** —— Architecture Gate 批准平台后，Scaffold PR 只生成获批目录（§2.3 preflight
  第 5 步的 disposition 判定 + §6 create-only 测试 + §6 隔离 org E2E）。
- **§12.4（第二层）** —— Scaffold PR 落地真实 `apps/*` 内容后，`CI Gate` 依然成功
  （§5.4，本文补齐 M2 未覆盖的一半）。

**依赖 M1**：`@sdd/schemas` 的 `validateProjectsDocument`（scaffold 的第一道 preflight）——
**`projects.schema.json` 需要 §9.1 列出的两处 pattern 改动**（`template_ref`、`owner`），
`template`/`ci` 枚举与配对本身已完整覆盖四个平台、无需改动；`@sdd/provenance` 的
`verifyGateApproval`——**输入/输出签名不变，但需要 §9.1 的一处内部逻辑修复**（label
存在性）——与 `GitReader` 接口（§3.2 交付其首个实现）。

**依赖 M2**（**代码尚未合并 main，实现前须以最终代码复核接口**，见文首说明）：
`@sdd/factory` 的 ports 模式（`GitHubReadPort`/`GitHubWritePort` 的 `resolveCommit`/
`readTemplateTree` 直接复用）、manifest/checksum/render 机制（放开 `TEMPLATE_NAMES`
闭集后复用，D2）、canonical-JSON + `operation_id` 确定性模式（M2 D12 的思路照搬）、Git Data
blob→tree→commit→非 force ref 前进的写操作模式（`publishSnapshot`/`upsertBootstrapPull`
提供的结构性先例，D4/D20）、`withRetry`/分页 helper（`github-write.ts` 内部工具函数直接
复用）、`createLocalFsReadPort`（dry-run 零网络预览模式直接复用）、CLI oclif 命令风格
（`product/init.ts` 的参数解析/校验/文本渲染模式）；M2 Bootstrap PR 阶段已写入的
CODEOWNERS `apps/*` stanza（M3 不需要再碰 CODEOWNERS）；M2 `--finalize-protection` 后
已生效的 `sdd-main` ruleset + required checks（Scaffold PR 原生复用，**只需要 §9.1 #4
一处参数补丁**，不新增保护资源）；`checkPrHygiene`/`sdd gate hygiene`（M3 在其内部新增
Scaffold PR 专属规则分支，D24，函数签名不变）。

### 9.1 实现前必须先合并的 M1/M2 补丁（阻塞项）

评审发现本文早期版本对现状的若干描述不准确（"无需改动"），实际需要以下四处精确、小范围
的 M1/M2 变更，**均建议独立于 M3 本身先合并**（改动小、风险低、影响面清楚）：

| # | 文件 | 改动 | 对应决策 | 理由 |
|---|---|---|---|---|
| 1 | `schemas/projects.schema.json` | `components[].template_ref` 加 `"pattern": "^[0-9a-f]{40}$"` | D19 | 否则 Architecture Gate 批准的只是一个可能被移动的 ref 字符串，不是真正 pin 住的内容 |
| 2 | `schemas/projects.schema.json` | `components[].owner` 加 `"pattern": "^[a-z][a-z0-9-]*$"`（与 `id`/`product` 同风格） | D23 | 否则 scaffold 无法安全判断 `owner` 是 team slug 还是用户名，无法正确选择 `team_reviewers` 还是 `reviewers` |
| 3 | `provenance/src/verify.ts` | label 一致性检查前加 `gate:<gate>` **存在性**断言（§3.5 给出精确 diff 意图） | D22 | 现状只查冲突不查缺失，任何 CODEOWNER 批准的 `projects.yaml` 修改都能冒充 Architecture Gate 批准 |
| 4 | `factory/src/github-write.ts`（`reconcileRepositoryRuleset`，已核实的确切行号见下） | **修正一个已存在的字段名拼写**：当前代码在 `required_status_checks` 规则的 `parameters` 里写的是 `strict_required_status_checks: true`；根据 GitHub 官方 OpenAPI schema（`github/rest-api-description` 仓库，2026-07 核实），正确字段名是 `strict_required_status_checks_policy`（且该字段在 schema 里被标为 `required`——当前拼写等于完全没设置这个必需属性，请求大概率被 GitHub 拒绝或该属性被静默忽略）。改一个字符串即可，不是新增字段 | D24 | 否则 Scaffold PR 在人工 review 期间，main 若被新 Architecture Gate 改写，PR 本身不碰 `projects.yaml`、无冲突，仍可合并已被取代的旧组件（TOCTOU），且没有任何机制会在合并前重新触发校验 |

前两项零迁移成本（当前无生产 `projects.yaml` 实例）；第三项影响全部五种 Gate，建议连同
其单测（新增"label 完全缺失"回归用例）一起合并，让 M3（architecture）与未来 M5（spec/
design/plan/contract）都直接受益；第四项是通用分支保护最佳实践（"合并前要求分支最新"），
不只是为了 Scaffold PR，对 Gate PR、实现 Issue PR 同样适用，且几乎没有副作用（只在 main
于 review 期间前进时，多要求一次"Update branch"点击）。四项都不改变任何已导出的
TypeScript 类型签名，只收紧校验规则或补一个已有 API 支持的布尔参数，属于"让通过校验
变难"而非"让通过校验变容易"的方向，回归风险低。`checkPrHygiene` 新增的 Scaffold PR
专属规则（D24 的另一半）**不在此表**——那是 M3 自身的新增业务逻辑，不是对既有代码的
"补丁"，随 M3 主体一起交付（见 §7）。

## 10. 不在 M3 范围

- reusable 平台 workflows（`java`/`web`/`ios`/`android.yml`）+ `detect` 路径规则 +
  `sdd impact` + `CI Gate` 平台矩阵聚合 → **M4**（§5.2）。
- Contract Gate（OpenAPI lint/breaking-change diff/`$ref`/examples/operationId 完整性/
  生成 client 编译）与 hygiene 的 contract 专属规则 → **M4.5**。M3 生成的 `web`/
  `ios-tuist`/`android` 模板均不含任何网络/API 调用代码，等 Contract Gate 落地、合同存在
  后由实现 Issue 添加。
- Provider conformance（Backend Implemented Gate）→ **M6**。
- Backlog compiler / Issue upsert / `sdd impact` 的 Issue 归并 / publish 处的强制授权
  校验 → **M5**。
- Release / 各平台 tag / 签名材料隔离 → **M7**。
- `sdd sync --check`（含 per-component `template.lock` 的定向安全更新判断）→ **M8**；
  M3 只负责把 `<path>/template.lock` 写对，不实现读取/比对它的漂移检测逻辑。
- **已生成 component 的模板版本升级/覆盖**（D3）：即使 `projects.yaml` 后续修改某 component
  的 `template_ref`，scaffold 也不会更新已存在的 `path` 目录——这是 M8 sync 或人工 PR 的
  范畴,不是 M3 的职责。
- **移除已生成的 component 目录**：`projects.yaml` 移除某 component 不触发 scaffold 删除
  对应目录（D3），只产出 warning；实际删除由人工 PR 完成。
- **自动发现候选 Gate PR**（`listGateApprovals` 式的 label 搜索辅助工具）：保持 M1 中
  "非强制"的定位，M3 不实现，见 §3.1。
- 修改 `contracts/openapi.yaml`、`specs/*/architecture.md` 或 CODEOWNERS——scaffold 只读
  `projects.yaml`，不产出这些文件的变更（CODEOWNERS 的 `apps/*` stanza 已由 M2 预注册）。
- 平台仓自身的 TS workspace CI（与产品模板无关，沿用 M2 §9 的既有排除）。

## 11. 待决事项（实现前需确认）

1. **Tuist 版本钉死机制**：`.tuist-version` 是本文假设的钉死文件名，需要在实现时对照 Tuist
   当时的官方文档确认当前推荐的版本管理方式（Tuist 的 CLI 分发/版本管理机制在不同大版本间
   有过调整）。
2. **iOS 模板本地验证的运行环境**：`ios-tuist` 模板的 §1.5 自测（渲染后 `tuist build` /
   `tuist test`）需要 macOS + Xcode + Tuist，若 Codex 实现环境是 Linux sandbox，无法在
   本地完成这一验证；需要通过 GitHub Actions macOS runner 跑一次，或人工在 Mac 上验证后
   才能确认该模板真实可构建。这不阻塞其余三个模板与 scaffold 命令本身的实现/测试，但会
   阻塞 §8 DoD 中"四个模板自测全部通过"这一条针对 `ios-tuist` 的部分。
3. **四个模板具体 patch 版本号**：§0/§1 锁定的是主版本 + 工具选型 + 锁定机制（Java 21、
   Gradle 8.10、Spring Boot 3.3.x、AGP 8.5.2、Kotlin 2.0.20、Vite 5.4.x、Tuist 4.x、
   Xcode 16.x 等），实现时应按当时最新稳定版核实并在模板文件与本文档中同步记录精确版本号。
4. **`ScaffoldReadPort`/`ScaffoldWritePort` 与既有 `GitHubReadPort`/`GitHubWritePort` 的
   最终并列方式**：本文建议新增平行接口并共享底层 octokit 适配器实现（§2.4），但最终是否
   把 `resolveCommit`/`readTemplateTree` 提炼成一个更小的共享基接口（而不是在两个 port
   类型上重复声明相同方法签名）留给实现时的类型设计判断，不影响行为。
5. **`git-reader.ts` 与 `local-reader.ts` 的代码复用程度**：§3.2 提到两者都需要"从 CWD
   向上找 git 仓根 + 读 remote owner/repo"，是否抽取共享小工具留给实现时判断。

> 原第 6 项（"PR reviewers 的团队解析"）已在评审中定案，不再是待决事项：`owner` 必须是
> 已校验的 team slug，见 §0 D23 与 §9.1。

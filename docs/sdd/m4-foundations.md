# M4 实施细案：CI Gate 平台矩阵 + detect + impact

> 本文是 [implementation-plan.md](implementation-plan.md) 中 **M4** 里程碑的文件级实施方案，
> 评审通过后据此交 Codex 实现。M4 完成 = 把 M2 交付、已合并 `main` 的最小 / no-op
> `CI Gate`（`.github/workflows/ci-gate.yml`）扩展成手册 §9 描述的完整平台矩阵：新增
> `java`/`web`/`ios`/`android` 四个 reusable workflow，把 `detect` job 从"输出恒 false 的
> stub"改造成"读路径规则 + 条件调用 `sdd impact` + 并入 PR 标签"的真实判定，并把 `CI Gate`
> 聚合 job 从"只看 `needs.detect.result`"扩成读四个平台 job 各自 `needs.*.result` 的完整
> 真值表。
>
> 依据手册（[single-repo-implementation-runbook.md](single-repo-implementation-runbook.md)）
> §9（CI Gate 操作规则）、§10.1（`sdd impact` 报告，本里程碑只做"受影响平台"部分）、§4.1
> （`.github/workflows/` 目录结构）；以及 implementation-plan §M4、贯穿性的 §1（授权溯源——
> **M4 不新增强制校验点**，`detect`/`sdd impact` 是只读分析逻辑，不是特权写操作）、§3（先搭
> 会走路的骨架）。格式与详细程度对齐 [m1-foundations.md](m1-foundations.md) /
> [m2-foundations.md](m2-foundations.md) / [m3-foundations.md](m3-foundations.md)（**尤其是
> m3 §0 D18–D26 那一轮"修复本身引入新 bug"的自查方式**，本文写作时已对每条新引入的规则做过
> 同等级别的自查，见各节内联的"自查"标注）。
>
> **依赖状态说明**：M1（schemas / `sdd validate` / `@sdd/provenance`）与 M2（factory
> `product init` + 最小 CI Gate / PR hygiene）均已实现并合入 `main`（PR #2、PR #4）。本文
> 所有对 `.github/workflows/{ci-gate,pr-hygiene}.yml`、`schemas/{projects,impact}.schema.json`、
> `schemas/src/{index,validators}.ts`、`factory/src/{index,gate-hygiene}.ts`、
> `cli/src/commands/gate/hygiene.ts`、`cli/package.json`、`factory/package.json` 的引用均已
> 实机核对 `main` 上的当前内容（2026-07-01），不是转述早期文档描述。M3（Scaffold 平台骨架）
> 的**文件级方案**已在分支 `m3-foundations` 完成四轮评审并通过，但**代码尚未实现/合并**；
> 本文引用 M3 的地方（§1、§5.1）只依赖 M3 方案文档里对**外部契约**的承诺（四个平台模板各自
> 固定的 lint/typecheck/test/build 命令、模板不含任何 workflow 文件），不依赖 M3 的任何
> factory 内部实现细节——即使 M3 实现阶段有调整，只要这两条契约不变，本文设计不受影响。
>
> **核心设计难点（全文最花篇幅的部分，见 §2）**：`sdd impact` 要把 `specs/**`、`design/**`、
> `contracts/**` 的变更映射到四个平台布尔值，但 M4 阶段**没有** task/Issue 级别的关联图（那是
> M5 `sdd backlog compile` 才建立的东西，依赖稳定 task ID 与 marker）。本文第一次起草时曾
> 想过给 `specs/**` 做"按 requirement 分块 diff"的精细化方案，自查后发现它在"改的是
> spec.md 里不挂在任何 REQ 编号下的段落（如 In/Out scope、风险与未决问题）"这一常见场景下
> 会漏判——这类改动不会被任何 REQ-ID 锚点捕获，会被误判为"无变化"。这正是 sdd-review-rigor
> memo 里"看起来更精细的修复反而在一个不起眼的合法输入下悄悄失效"的那类问题，已在 §2.5
> 改为更朴素、但不会漏判的"整篇文档内容 diff"方案，放弃了按 REQ-ID 分块的设计。

## 0. 已定决策

沿用 M1–M3 已定的运行时与工具链（Node 24 LTS + TS strict、pnpm/tsup/vitest/oclif/biome、
provenance 只认 PR/merge 元数据、不建仓内账本），不复述。M4 新增决策：

- **D1 — 四个 reusable workflow 用同仓库 `workflow_call`，不是新的固定/pin 机制**：
  `java.yml`/`web.yml`/`ios.yml`/`android.yml` 与 `ci-gate.yml`/`pr-hygiene.yml` 同置于
  **平台仓** `.github/workflows/`；`ci-gate.yml` 内以**相对路径** `uses:
  ./.github/workflows/java.yml` 调用。GitHub 对同仓库相对路径的 `workflow_call` 引用，解析
  时使用**调用方工作流自身当前所在的仓库 + ref**——即 `ci-gate.yml` 运行在 M2 D7/D10 已建立
  的"专用 organization ruleset 固定 `repository_id + path + sha`"这个大前提下已经钉住的那个
  commit，四个 reusable workflow 因为是同一次 checkout/同一个 ref 下的相对路径引用，**自动
  继承同一枚 pin**，不需要为它们单独注册/维护第二套 pin。M4 不新增任何 required-workflow
  级别的信任锚点。
- **D2 — D10 的"不 checkout/执行产品 PR 内容"边界，只覆盖判定类 job，不覆盖构建类 job**：
  M2 D10 与 M3 D10 的原文都在说"仅按 check name 要求可被伪造"这一类威胁——`detect` 与
  `PR hygiene` 的职责是**代表平台对产品 PR 作出可信裁决**（"这个 PR 该不该过 Gate/该测哪些
  平台"），它们的裁决过程本身不能被产品 PR 编辑或影响，因此不 checkout/执行产品仓任何内容，
  只经 API 读元数据/文本。**四个平台 reusable workflow 不是裁决类 job，是被裁决的对象
  本身**——"`ci: java` 的这个 component 能不能编译/测试通过"这件事,除了真的
  checkout 产品 PR 的 head 内容、用真实工具链跑一遍之外没有第二种确定方法,这正是 CI
  存在的意义。两者不矛盾：
  - `detect`/`PR hygiene`：**决定信不信这个 PR**——永远不 checkout 产品仓，只读 API。
  - `java`/`web`/`ios`/`android`：**就是被拿来测的对象**——必须 checkout 产品仓 head SHA
    并执行真实构建命令，这是它们唯一的职责。
  安全性不靠"不跑代码"来保证（那是 `detect`/`PR hygiene` 的手段），而靠别的、独立的机制：
  (a) 四个 reusable workflow 的**定义本身**（YAML 步骤）来自平台仓，被 D1 的同一枚 pin
  钉住,产品 PR 无法编辑它们的执行逻辑；(b) `ci-gate.yml` 用 `on: pull_request`（非
  `pull_request_target`），fork 来源的 PR 下 `GITHUB_TOKEN` 是 GitHub 默认的只读、无仓库
  secret 访问权限,这是 GitHub 自带的 fork 安全网,不需要本文额外实现；(c) M4 的四个平台
  job 不需要、也不请求任何签名 / 发布类 secret（那些在 M7 才出现，且严格隔离在
  `ios-release`/`android-release` environment，与 M4 的 CI job 完全无关）。**结论**：
  build/test job 执行产品代码是被设计如此、且安全的；`detect`/hygiene 不执行产品代码是
  因为它们的判定逻辑不需要执行任何代码就能完成，属于"没必要就不做"，不是"不能做"。
- **D3 — 平台判定的唯一权威来源是 `projects.yaml`（PR head 版本）的 `components[].path` +
  `.ci`，不是任何硬编码的 `apps/<platform>/` 路径**：手册 §9 给出的路径影响建议表
  （`apps/backend/** -> backend` 等）是**示例**，不是可硬编码的常量——M1/M3 从未保证
  `component.path` 的叶子目录名等于 `id` 或 `ci`（M3 D21 已经把"目录只认 `path`、不由 `id`
  推导"钉死，`path` 允许任意合法子路径，如 `apps/services/api`）。因此 `detect` 必须在**每次
  运行时**读取 PR head SHA 的 `projects.yaml`，构造 `{path, ci}` 列表，再对每个改动路径做
  **带路径分隔符边界的前缀匹配**（`changedPath === c.path || changedPath.startsWith(c.path +
  '/')`，不能用裸 `startsWith(c.path)`——否则 `apps/api-gateway/x` 会被误判匹配到
  `apps/api`，这是名字互为前缀但不构成 M1 语义校验所禁止的"路径嵌套"的兄弟目录场景，M1
  的"`components[].path` 全局唯一且互不为前缀"只防真正的嵌套关系，不防这种共享字符串前缀的
  兄弟名）。同一 `ci` 值可能对应多个 component（如两个 `ci: java` 服务），因此每个平台的
  "受影响 component 路径"是一个**列表**，不是一个值，见 §1.3/§2.3。
- **D4 — `declared[platform]`（该产品是否声明了这个平台）是最后一步无条件 AND，路径规则 /
  impact / PR 标签都不能绕过**：`declared[platform] = projects.yaml(head) 中存在 ≥1 个
  `ci == platform` 的 component`。**自查**：手册 §9 的路径表与 §9 的"`platform:*` 标签只能
  强制 false→true"这条规则,字面读都隐含"四个平台永远都在"这个前提——但 schema 从
  M1 起就允许 `components: []` 逐步增长，一个只做 backend+web 的产品完全合法（无 `minItems`
  约束，无"四选四"要求）。若不加这一步 AND，`design/**` 改动会把一个从未声明 `ios`
  component 的产品的 `ios` 判成 `true`，下游 `ios` job 尝试 checkout 一个不存在的目录、
  构建失败,把整条 `CI Gate` 拖红——这是"表面上遵循了手册字面表格,但在一个手册没有明说、
  却完全合法的输入（并非四平台俱全的产品）下悄悄产生假阳性故障"的问题，必须在设计阶段堵上。
  精确顺序（§2.6）：`final[platform] = (pathRule[platform] OR impact[platform] OR
  labelForce[platform]) AND declared[platform]`——`declared` 是最后一步，对三个信号源的
  并集统一生效，不在每个信号源内部各自重复判断。
- **D5 — 保守性原则（贯穿 §2.5 全部规则的统一表述，只写一次，后文引用）**：**当 M4 阶段
  掌握的信息不足以把一次 spec/design/architecture 变更精确归因到具体平台时（没有 M5 才建立
  的 task 级关联图），一律把该变更归为"影响该变更所在 track 语义范围内的全部
  `declared` 平台"，绝不缩小到"看起来更合理"的子集**。允许的例外只有一种：变更范围经过
  **规范化文本比较后确认为零内容差异**（如纯 whitespace、行尾差异）。这条原则直接决定了
  §2.5 每条规则"该不该、能不能进一步收窄"的判断，包括为什么最终放弃了"按 REQ-ID 分块
  narrow"的更精细方案（见本文档首行的自查记录）。
- **D6 — `changed.requirements` / `.screens` / `.operations`（报表字段）与"该平台是否受
  影响"（gating 字段）分开计算，互不依赖**：前者是 base/head 之间 **ID 集合的对称差**
  （新增 ID ∪删除 ID，通过既有的 `REQ-*`/`SCR-*`/`operationId:` 行级正则提取，与
  `factory/src/gate-hygiene.ts` 里 `extractReqIds`/`extractScrIds`/`extractOperationIds`
  用的是同一批正则——见 §4.5 的复用/搬迁），单纯是"改动前后 ID 有什么增减"的审计信息，供
  §10.1 报告与未来 M5 消费；后者（平台布尔）用**整篇文档规范化文本 diff**（spec.md /
  design.md 各自作为一个整体比较，见 §2.5），不尝试按 REQ-ID 分块授权哪部分文本"属于"哪个
  需求——D5 的自查已经说明这种更精细的尝试在"改动不挂在任何 REQ-ID 下的段落"时会漏判。
  两套算法故意不同源，因为它们回答的是不同的问题："改了什么"（可以精确）vs
  "因此该测什么"（M4 阶段做不到精确，只能保守）。
- **D7 — `breaking` 字段是窄口径的结构性启发式，不是 M4.5 的完整 OpenAPI breaking-diff**：
  M4 对 `breaking` 的定义仅为"某个 `operationId` 在 base 存在、在 head 不存在"（增/改
  operation 一律不算 breaking，只有"消失"才算，且消失包含"改名"，因为改名在没有显式
  `x-sdd-renamed-from` 之类标注时,从 ID 集合角度和删除无法区分,保守地都算 breaking）。
  真正的字段级/schema 级 breaking-change 分析（参数类型收窄、必填字段新增等）是 **M4.5**
  Contract Gate 的职责（用 spectral/oasdiff 等专门工具，工具选型见 implementation-plan §5待决
  事项）。M4 的 `breaking` 字段只是 impact 报告里一个保守、诚实、明确标注"非最终结论"的
  信号,不是任何 gating 逻辑的输入（`detect` 的平台布尔不读这个字段）。
- **D8 — `contract_changed` 精确 scope 到 `contracts/openapi.yaml`，与平台矩阵用的宽口径
  `contracts/**` 是两个不同粒度的信号，不要混用**：手册 §8.1 明确"Gate 由
  `contracts/openapi.yaml` 的路径变化强制触发"——只提 `openapi.yaml`，不含
  `contracts/events.yaml`/`contracts/README.md`。而 §9 路径表里"`contracts/** ->
  backend+web+ios+android`"是**平台矩阵**要用的宽口径（events.yaml 变化同样可能是
  Architecture Gate 相关的跨平台契约变化，值得保守触发全部平台 CI）。`contract_changed`
  是 M4 唯一需要留给 **M4.5** 使用的输出，必须精确匹配 `contracts/openapi.yaml`
  这一条路径的 added/modified 状态，不能偷懒复用宽口径的 `contracts/**` 判断结果——否则
  M4.5 会在只改了 `events.yaml` 时被错误触发,或者反过来在语义上不该被触发时被触发,这是
  两个"看起来很像但不该混用"的字段,必须在文档里明确分开定义（对应 sdd-review-rigor
  memo 里"两个相似字段可能在合法输入下分道扬镳"的自查项）。
- **D9 — `sdd impact` 的读取抽象有两种后端，CI 路径是权威判定，本地路径只是预览**：手册
  §9（CI 用法：`sdd impact --base <base-sha> --head <head-sha>`）与 §10.1（本地用法：
  `sdd impact --base origin/main --head HEAD`）是两种不同的调用场景——CI 里 `detect` job
  遵循 D2 的"不 checkout 产品仓"，只能经 GitHub API 读 base/head 两个 SHA 各自的文件内容；
  本地开发者在自己的 checkout 里跑，直接用本地 `git` 更简单也更符合直觉。`sdd impact`
  因此需要一个 `ImpactReader` 接口 + 两个实现（§4.2）。**这两个实现不保证逐字节行为一致**
  （尤其是文件重命名判定、超大 diff 截断阈值等边界情况），本文明确 CI 里跑的 API-backed
  版本才是唯一影响 `CI Gate` 判定结果的路径；本地版本仅供人工在打开 PR 前或评审 Gate PR 时
  预览，不作为任何 Gate 的判定依据（与 M1 对 `compile --dry-run` "可预览、不代表批准"的
  既有原则一致）。
- **D10 — 命令分两层，镜像 `sdd validate` vs `sdd gate hygiene` 的既有先例**：`sdd impact`
  （通用分析命令，人和 CI 都能调用，业务逻辑落在 `@sdd/factory` 的 `computeImpact`）+
  `sdd gate detect`（**CI 专用编排命令**：路径分类 + 条件调用 `computeImpact` + 并入 PR
  标签 + 应用 D4 的 declared-AND，业务逻辑落在 `@sdd/factory` 的 `detectPlatforms`）。这精确
  复刻 `cli/src/commands/gate/hygiene.ts`（CI 专用编排）委托给
  `factory/src/gate-hygiene.ts` 的 `checkPrHygiene`（业务逻辑）这一现有模式，而不是把编排
  逻辑散落在 workflow YAML 的 bash 脚本里。见 §4.1/§4.3。
- **D11 — 修好 M2 stub 里断连的 `detect` outputs（本里程碑最直接的一处 bug 修复）**：
  `main` 上 `ci-gate.yml` 当前的 `detect` job，`outputs:` 字段写的是字面量字符串 `'false'`
  （4 处），与同一 job 里那个把 `backend=false` 等写进 `$GITHUB_OUTPUT` 的 step **完全没有
  引用关系**——该 step 甚至没有 `id:`，所以 `steps.<id>.outputs.*` 语法根本无法指向它，这个
  step 是死代码，只是 M2 阶段两条路径（写死的字面量、和这个 step 算出来的值）碰巧都是
  `false` 才看不出问题。**修复**：给该 step 加 `id: detect`，把 job 级 `outputs:` 从字面量
  改写成 `${{ steps.detect.outputs.backend }}` 等表达式（外加新增的 `contract_changed`、
  `*_paths` 四个 JSON 数组输出、以及供 §1.1 四个平台 job 使用的 `product_repo`/
  `head_sha` 两个透传输出，共 11 个字段全部走同一条 `steps.detect.outputs.*` 接线，
  不是只修好原有 4 个、新增的 7 个又重蹈覆辙）。这不是"加检测逻辑"，是先把这根接线接上，
  否则 M4 加的所有
  判定逻辑都会像 M2 一样被这根断线吞掉——这正是用户在起始需求里特别点名的一处，必须显式
  在文档里写出"改之前"和"改之后"两版对照（见 §2.9）。
- **D12 — `CI Gate` 真值表化简为两条规则，可证明覆盖手册 §9 表格的全部可达状态，且额外
  安全地处理了手册没写的状态**：手册 §9 给出的表：
  ```text
  detected=false + skipped   -> pass
  detected=true  + success   -> pass
  detected=true  + skipped   -> fail
  detected=true  + failure   -> fail
  detected=true  + cancelled -> fail
  ```
  本文的实现改写为等价、但更容易正确实现的两条规则（对 backend/web/ios/android 四个平台
  job 各自应用）：
  1. 该平台 job 的 `result` 是 `failure` 或 `cancelled` → **无条件失败**（不看 `detected`）。
  2. `detected[platform]=true` 且 `result=skipped` → **失败**。
  其余情况（`detected=false` 且 `result` 是 `skipped` 或 `success`；`detected=true` 且
  `result=success`）→ 通过。**等价性自查**：手册表格的 5 行被规则 1/2 精确覆盖（`detected=
  true+failure`、`detected=true+cancelled` 落在规则 1；`detected=true+skipped` 落在规则
  2；`detected=false+skipped`、`detected=true+success` 落在"其余通过"）；手册没写的两个
  状态——`detected=false+success`（job 意外跑了但成功,判过,合理,没有安全代价）、
  `detected=false+failure`（正常 `if:` 门控下不可达，因为 GitHub Actions 对
  `if:` 为假的 job 只会产生 `skipped`,不会产生 `failure`；若因为某处 `if:` 表达式写错等
  异常原因真的出现,规则 1 仍然会判它失败）——都被规则 1/2 安全地处理,不需要为它们单独
  写第三条规则,新表格是手册原表格的**保守超集**，不是不同的判定标准。
- **D13 — `detect` 自身失败必须让 `CI Gate` 无条件失败，独立于、且先于对任何平台 job 的
  判断**：这是用户起始需求里明确点名的一条,必须单独成一条决策，不能被 D12 的平台
  真值表悄悄带过。原因：`ci-gate.yml` 的四个平台 job 各自的 `if:` 条件读
  `needs.detect.outputs.<platform> == 'true'`——若 `detect` job 本身失败（`sdd impact`
  执行报错、输出不合法、`projects.yaml` 校验失败等），根据 GitHub Actions 语义，一个失败
  job 未必执行到写 `$GITHUB_OUTPUT` 的那一行，此时 `needs.detect.outputs.*` 对下游 job 而言
  是**空字符串**，不是 `'false'`——四个平台 job 的 `if:` 条件求值为假（空字符串 ≠
  `'true'`），于是四个平台 job **全部被跳过**（`skipped`，不是 `failure`）。如果 `CI
  Gate` 的聚合逻辑只看"平台 job 是否全部 `skipped` 且没有任何 `detected=true`"，会得出
  "一切正常、全部跳过、通过"的错误结论——这是把"detect 彻底挂了、什么都没判定出来"和
  "detect 正常判定为四个平台都不需要跑"这两种性质完全不同的状态混为一谈,前者必须失败,
  后者才是合法的 pass。**修复**：`CI Gate` 聚合 step 的第一行代码就是检查
  `needs.detect.result`（不是 `outputs`,是 job 的整体 `result`,GitHub Actions 保证这个
  字段无论 job 内部是否走到写 output 的那一步都会被正确报告为 `success`/`failure`/
  `cancelled`/`skipped` 之一），非 `success` 立即判 `CI Gate` 失败,在触碰任何平台 job 的
  结果之前就短路返回。M2 stub 已经有这行检查的雏形（只判断字符串 `"failure"`），M4 需要
  把它扩成 `!= 'success'`（同时覆盖 `cancelled`，M2 stub 遗漏了这个分支）并且**保证它在
  聚合逻辑里排在最前面、不会被后续新增的平台真值表判断绕过或覆盖**，见 §3.3。
- **D14 — iOS runner 只在 `detected=true` 时才分配**：`ci-gate.yml` 里代表 iOS 平台的外层
  job（`uses: ./.github/workflows/ios.yml` 的调用方）本身带 `if:
  needs.detect.outputs.ios == 'true'`；`runs-on: macos-*` 只出现在被调用的 `ios.yml`
  内部的实际构建 job 上。外层 job 一旦被 `if:` 判假，GitHub Actions 根本不会去调度它引用的
  reusable workflow,内部 job（含 macOS runner 分配）自然也不会发生——这不需要额外机制,是
  `if:` 门控通过 `workflow_call` 自然级联的标准行为，只需要在文档里明确写出"外层 if 在
  哪一层"，避免实现时把 `if:` 错放在 `ios.yml` 内部的 job 上（那样 GitHub 仍然要先调度
  `ios.yml` 这个 workflow 本身，`runs-on` 求值和 runner 排队在更早的阶段发生，起不到"不
  分配 macOS runner"的效果）。
- **D15 — 已存在的产品仓升级到 M4 版 `ci-gate.yml`，遵照 M2 自己定的"M4 迁移护栏"，不新增
  机制**：M2 §3.6 已经写明"扩 CI 时保留 `CI Gate` context，先让新平台 workflow 在 PR 上
  真实成功，再更新 required workflow 的 pinned SHA，避免再次制造 required-check 自举
  死锁"。M4 落地时的操作顺序：(1) 新版 `ci-gate.yml`/四个 reusable workflow 先合入平台仓
  `main`，本身过平台仓自己的 TS workspace CI；(2) 对**已经跑过 `--finalize-protection`**
  的产品仓，人工/运维在该产品仓开一个不受影响的普通 PR，观察新版 `CI Gate`（含四个平台
  job）真实产生绿色 check；(3) 确认后，用 M2 已经交付的、幂等的
  `reconcileOrgWorkflowRuleset` 把该产品仓关联的专用 org ruleset 的 pinned SHA 前移到
  新版本。M4 不需要新建一个"升级"命令——复用 M2 现成的 reconcile 语义（幂等、按目标 state
  收敛），只是这次目标 state 的 pinned SHA 换成了新版本。这一步是运维时序说明，不是本文要
  设计的新代码路径,見 §5.4。
- **D16 — 抽取共享 helper，避免 `detect.ts`/`impact.ts` 重新拷贝 `gate-hygiene.ts` 已有的
  三个函数**：`factory/src/gate-hygiene.ts` 已经私有实现了 `fetchAllChangedFiles`、
  `fetchBlobContentStrict`，以及一个仅用于 CLI 层的 `createMinimalOctokit`
  （`cli/src/commands/gate/hygiene.ts` 内联，未导出）。M4 新增的
  `detect.ts`/`impact.ts` 需要几乎相同的"读 PR 变更文件列表"、"按 ref 读 blob 内容（含
  404→null 的区分）"能力，第二次原地重新实现是不必要的重复。**新增
  `factory/src/github-minimal-client.ts`**（导出 `MinimalOctokit` 接口 + `fetchPullRequest`
  / `fetchChangedFiles` / `fetchBlobAtRef`，`fetchBlobAtRef` 对 404 返回
  `null`、其余错误照常抛出——这个 null/throw 的区分很重要，见 §2.5 对"文件在某个 ref
  不存在"和"读取本身失败"两种情况必须分开处理的说明），`gate-hygiene.ts` 改为从这个新模块
  导入并删除自己的私有实现；**新增 `cli/src/octokit-client.ts`**（把
  `createMinimalOctokit` 从 `gate/hygiene.ts` 内联搬出），`gate/hygiene.ts` 与新增的
  `gate/detect.ts`/`impact.ts` 都从这里导入。这是"发现第二处真实需要、而不是预先假设"的
  抽取，符合"不要为假设的未来需求过早抽象"的原则——这里已经是第二个具体调用点,不是假设。
- **D17 — M4 不修改 `checkPrHygiene`，不新增 `@sdd/provenance` 调用点**：`detect`/`sdd
  impact` 是只读分析（回答"这个 PR 的路径/内容看起来影响哪些平台"），不是任何形式的
  批准/合并授权判断，不涉及"这份工件是否被正确的 Gate PR 批准"这类问题（那是
  `verifyGateApproval` 的职责,M1 定义、M3 首次强制调用）。M4 的 CI 只是"该不该跑这个平台
  的构建测试"，跑不跑、过不过都不构成任何授权声明——即使 `detect` 判定错误（比如误判某平台
  不需要测），最坏后果是该平台的 bug 没被这次 CI 抓到，而不是绕过了某个批准要求。这条决策
  用来在评审时明确划清边界，防止把 M4 的 `detect` 误读成需要走 provenance 校验的特权操作。

## 1. 四个 reusable platform workflow

### 1.1 调用关系（D1/D2 的落地）

```text
sdd-platform/.github/workflows/
├── ci-gate.yml         # 已存在（M2），本里程碑扩展
├── pr-hygiene.yml       # 已存在（M2），本里程碑不改
├── java.yml             # 新增：workflow_call，供 ci-gate.yml 以 backend job 调用
├── web.yml              # 新增：workflow_call
├── ios.yml              # 新增：workflow_call，runs-on: macos-*
└── android.yml          # 新增：workflow_call
```

`ci-gate.yml` 内新增四个"外层 job"，各自通过相对路径 `uses:` 调用对应 reusable workflow：

```yaml
jobs:
  detect:
    # ...（§2 详述）

  backend:
    needs: [detect]
    if: needs.detect.outputs.backend == 'true'
    uses: ./.github/workflows/java.yml
    with:
      product_repo: ${{ needs.detect.outputs.product_repo }}
      head_sha: ${{ needs.detect.outputs.head_sha }}
      paths: ${{ needs.detect.outputs.backend_paths }}

  web:
    needs: [detect]
    if: needs.detect.outputs.web == 'true'
    uses: ./.github/workflows/web.yml
    with: { product_repo: ..., head_sha: ..., paths: ${{ needs.detect.outputs.web_paths }} }

  ios:
    needs: [detect]
    if: needs.detect.outputs.ios == 'true'      # D14：外层 if，macOS runner 不因此被分配
    uses: ./.github/workflows/ios.yml
    with: { product_repo: ..., head_sha: ..., paths: ${{ needs.detect.outputs.ios_paths }} }

  android:
    needs: [detect]
    if: needs.detect.outputs.android == 'true'
    uses: ./.github/workflows/android.yml
    with: { product_repo: ..., head_sha: ..., paths: ${{ needs.detect.outputs.android_paths }} }

  CI Gate:
    needs: [detect, backend, web, ios, android]
    if: always()
    # §3 详述聚合逻辑
```

`product_repo`/`head_sha` 作为 `detect` 的**额外两个输出**（不只是四个平台布尔 +
`contract_changed` + 四个 `*_paths`），值直接取自 `detect` job 内部已经读到的
`github.event.pull_request.base.repo.full_name` / `.head.sha`（与 `pr-hygiene.yml`
现有的"用 `base.repo`，永远不用 `head.repo`（fork 场景下属于 fork 本身，不可信）"
的既有原则完全一致，见 §2.9）。

**为什么显式传参、不依赖隐式 `github` 上下文穿透（自查项，待实现时验证）**：`ci-gate.yml`
运行在"产品仓 PR 触发、但 workflow 文件定义在平台仓"这一层间接（专用 org ruleset 的
required workflow 机制）之上，`pr-hygiene.yml` 的既有注释已经证明——在这一层间接下，
`github.event.pull_request.*` 正确反映**产品仓**（不是平台仓）。但四个平台 job 还叠加了
**第二层间接**（`workflow_call`：`ci-gate.yml` 用 `uses:` 调用 `java.yml`）——`java.yml`
内部的 `github` 上下文是否还能正确穿透并反映产品仓，本文没有直接证据（既有代码只验证到
第一层间接，没有第二层的先例）。为了不依赖一个未经验证的假设，本文选择让 `java.yml` 等
四个 reusable workflow 完全通过 `on.workflow_call.inputs` 接收 `product_repo`/`head_sha`/
`paths`，checkout 时显式使用这些 `inputs.*` 值，不读被调用 workflow 内部的 `github.event`/
`github.repository`。这样无论第二层间接的隐式上下文穿透行为具体如何，结果都不受影响。
**§11 待决事项 #1** 记录了"验证默认 `GITHUB_TOKEN` 能否 checkout `inputs.product_repo`
指向的仓库"这一具体的、需要在隔离测试环境验证的假设（`pr-hygiene.yml` 已经证明该 token
能经 API **读** 产品 PR，但没有证明它能 **checkout** 产品仓的 git 内容——读 API 和
checkout 走的是 GitHub 两套不同的权限判定路径，不能想当然认为前者成立后者就一定成立）。

### 1.2 从 `projects.yaml` 解析 component 路径（D3/D4 的落地）

`detect` job（§2.3）读 PR head SHA 的 `projects.yaml`，为每个 `ci` 值分别收集匹配
component 的 `path`，产出：

```json
{
  "backend": true,
  "backend_paths": ["apps/backend"],
  "web": false,
  "web_paths": [],
  "ios": false,
  "ios_paths": [],
  "android": false,
  "android_paths": []
}
```

`backend_paths` 等作为 JSON 数组字符串，四个平台 job 用它驱动 `strategy.matrix`：

```yaml
# java.yml（片段）
on:
  workflow_call:
    inputs:
      product_repo: { type: string, required: true }
      head_sha: { type: string, required: true }
      paths: { type: string, required: true }   # JSON array string, e.g. '["apps/backend"]'
jobs:
  build:
    strategy:
      matrix:
        path: ${{ fromJSON(inputs.paths) }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: ${{ inputs.product_repo }}
          ref: ${{ inputs.head_sha }}
      - name: lint
        working-directory: ${{ matrix.path }}
        run: ./gradlew spotlessCheck
      - name: typecheck
        working-directory: ${{ matrix.path }}
        run: ./gradlew compileJava compileTestJava
      - name: test
        working-directory: ${{ matrix.path }}
        run: ./gradlew test
      - name: build
        working-directory: ${{ matrix.path }}
        run: ./gradlew build
```

`paths` 为空数组时，`strategy.matrix` 产生零个 matrix 实例，`build` job 自然不运行任何
实例（GitHub Actions 标准行为），不需要额外的空值判断——这与外层 `if:
needs.detect.outputs.backend == 'true'` 是两道独立的保险：正常情况下 `backend=false` 时
外层 job 整个被跳过，根本不会调用到 `java.yml`；`paths` 为空数组这层只在"detected=true
但 paths 计算出空列表"这种理论上不该出现的不一致状态下起兜底作用。

四条命令族（lint / typecheck-等效 / test / build）严格对应 M3 §1 表格里各平台模板承诺的
命令契约（`spring-boot`→Gradle 四条；`web`→`pnpm biome check .`/`pnpm tsc --noEmit`/
`pnpm vitest run`/`pnpm vite build`；`ios-tuist`→`swiftlint`/`tuist build`/`tuist test`/
`tuist build`；`android`→`./gradlew lint`/随 build 触发/`./gradlew testDebugUnitTest`/
`./gradlew assembleDebug`），`java.yml`/`web.yml`/`ios.yml`/`android.yml` 各自硬编码
对应平台的四条命令，不做"通用命令 + 参数化"的抽象——四个平台的工具链、命令语法完全不同，
硬编码四份短 YAML 比"猜哪些部分可以参数化"更简单可靠,符合"不要为不存在的多态需求增加
抽象"的原则。

### 1.3 iOS runner（D14 落地）

```yaml
# ios.yml（片段）
on:
  workflow_call:
    inputs: { product_repo: ..., head_sha: ..., paths: ... }
jobs:
  build:
    strategy:
      matrix:
        path: ${{ fromJSON(inputs.paths) }}
    runs-on: macos-14   # 具体版本在实现时按 GitHub-hosted runner 当时可用版本核实，
                         # 与 M3 §1.3 `.xcode-version` 锁定的 Xcode 版本相容（镜像 M3
                         # "版本号在实现时可按当时最新稳定版微调"的既有做法）
    steps:
      - uses: actions/checkout@v4
        with: { repository: ${{ inputs.product_repo }}, ref: ${{ inputs.head_sha }} }
      - name: lint
        working-directory: ${{ matrix.path }}
        run: swiftlint
      - name: build
        working-directory: ${{ matrix.path }}
        run: tuist build
      - name: test
        working-directory: ${{ matrix.path }}
        run: tuist test
```

外层 `ios` job（§1.1）的 `if: needs.detect.outputs.ios == 'true'` 已经保证：只有
`detected=true` 时才会调度到这个 workflow；只要没被调度,`runs-on: macos-14` 这一行永远
不会被求值,自然不占用 macOS runner 配额——对应手册 §12.5"只改 backend 时，iOS macOS
runner 不启动"。**不要**把 `if:` 挪到 `ios.yml` 内部的 `build` job 上（那样
`ios.yml` 本身仍会被调度、`runs-on` 仍会被 GitHub Actions 求值排队，即使最终 `if:` 判假
让 job 变成 `skipped`，runner 分配这一步的开销已经发生）。

### 1.4 权限与 secrets

四个 reusable workflow 不声明 `permissions:` 提权（继承 `ci-gate.yml` 顶层已有的最小
权限），不读取任何 `secrets.*`（M4 阶段不需要；iOS/Android 签名 secret 严格属于 M7 的
`ios-release`/`android-release` environment，与这里的纯本地 lint/typecheck/test/build
无关）。`on: pull_request`（而非 `pull_request_target`）保证 fork 来源 PR 下
`GITHUB_TOKEN` 是 GitHub 默认的只读、无 secret 权限 token,这是 D2 里"为什么 build job
checkout 执行产品代码是安全的"这一论证的关键前提,不需要本文额外实现，但如果**未来**
`ci-gate.yml` 因为其他原因改成 `pull_request_target`，D2 的安全论证会失效——本文明确
把"必须保持 `on: pull_request`"记录为一条不可回退的约束，任何后续里程碑改动这个触发器
之前必须重新过一遍 D2 的论证。

## 2. `detect` job 与 `sdd impact`

### 2.1 现状（M2 stub）与断连 bug

`main` 上 `.github/workflows/ci-gate.yml` 的 `detect` job（已实机读取，非转述）：

```yaml
detect:
  name: detect
  runs-on: ubuntu-latest
  outputs:
    backend: 'false'    # 字面量，与下面的 step 无引用关系
    web: 'false'
    ios: 'false'
    android: 'false'
  steps:
    - name: detect platforms     # 没有 id，steps.<id>.outputs.* 无法引用它
      run: |
        echo "backend=false" >> "$GITHUB_OUTPUT"
        echo "web=false" >> "$GITHUB_OUTPUT"
        echo "ios=false" >> "$GITHUB_OUTPUT"
        echo "android=false" >> "$GITHUB_OUTPUT"
```

M2 阶段两条路径巧合地都产出 `false`，所以断连不可见；M4 一旦让 step 算出真实值，若不接好
这根线，job 级 `outputs` 仍然会固定输出字面量 `'false'`，检测逻辑白写。**修复**（D11）：

```yaml
detect:
  name: detect
  runs-on: ubuntu-latest
  outputs:
    backend: ${{ steps.detect.outputs.backend }}
    web: ${{ steps.detect.outputs.web }}
    ios: ${{ steps.detect.outputs.ios }}
    android: ${{ steps.detect.outputs.android }}
    contract_changed: ${{ steps.detect.outputs.contract_changed }}
    backend_paths: ${{ steps.detect.outputs.backend_paths }}
    web_paths: ${{ steps.detect.outputs.web_paths }}
    ios_paths: ${{ steps.detect.outputs.ios_paths }}
    android_paths: ${{ steps.detect.outputs.android_paths }}
    product_repo: ${{ steps.detect.outputs.product_repo }}
    head_sha: ${{ steps.detect.outputs.head_sha }}
  steps:
    - name: resolve trusted workflow source   # 与 pr-hygiene.yml 完全一致的模式（§2.9）
      id: workflow-source
      # ...
    - name: checkout platform repo
      uses: actions/checkout@v4
      with: { repository: ..., ref: ${{ github.workflow_sha }}, path: platform }
    - name: setup node / install / build
      # ...
    - name: detect platforms
      id: detect        # <- 关键修复：没有这个 id，上面 outputs 全部解析成空字符串
      working-directory: platform
      env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
      run: |
        REPO="${{ github.event.pull_request.base.repo.full_name }}"
        PR_NUMBER="${{ github.event.pull_request.number }}"
        HEAD_SHA="${{ github.event.pull_request.head.sha }}"
        node cli/bin/run.js gate detect --repo "$REPO" --pr "$PR_NUMBER" > /tmp/detect.json
        cat /tmp/detect.json   # 便于排障时在 Actions 日志里直接看到完整判定结果
        {
          echo "product_repo=$REPO"
          echo "head_sha=$HEAD_SHA"
          echo "backend=$(jq -r '.backend' /tmp/detect.json)"
          echo "web=$(jq -r '.web' /tmp/detect.json)"
          echo "ios=$(jq -r '.ios' /tmp/detect.json)"
          echo "android=$(jq -r '.android' /tmp/detect.json)"
          echo "contract_changed=$(jq -r '.contract_changed' /tmp/detect.json)"
          echo "backend_paths=$(jq -c '.backend_paths' /tmp/detect.json)"
          echo "web_paths=$(jq -c '.web_paths' /tmp/detect.json)"
          echo "ios_paths=$(jq -c '.ios_paths' /tmp/detect.json)"
          echo "android_paths=$(jq -c '.android_paths' /tmp/detect.json)"
        } >> "$GITHUB_OUTPUT"
```

`jq` 在全部 GitHub-hosted runner（ubuntu/macos/windows）预装，不需要额外安装步骤——这与
M2/M3 对标准工具可用性的既有假设一致，不专门测试。选择"CLI 打印 JSON 到 stdout，workflow
step 用 `jq` 精确取 5+4+2 个已知标量/数组字段"而不是给 `sdd gate detect` 专门加一个
`--format github-output` 模式：`sdd gate hygiene` 从未需要过第三种输出格式，`sdd impact`
的 `--format json|text` 服务两种真实受众（人/CI），而"GITHUB_OUTPUT 专用格式"只有一个
调用点（这个 workflow step 自己），不构成"第二个真实需要"，加一个新格式模式属于为单一调用
点定制 CLI 接口,不如让 workflow 侧写几行显式 `jq` 提取来得直接（也更容易在 workflow YAML
里一眼看出到底暴露了哪 11 个字段）。

### 2.2 `detect` 整体流程

```text
1. 读 PR：base_sha、head_sha、labels、（本步骤同时提供 product_repo 供 §1.1 的四个平台
   job 使用）——一次 GitHub API 调用（GET /pulls/{pr}），复用 §4.5 抽取出的
   fetchPullRequest 共享 helper。
2. 读 PR head SHA 的 projects.yaml，用 @sdd/schemas 的 validateProjectsDocument 校验；
   不合法 → detect 立即失败（fail closed，退出码 3，见 §2.9），不进入后续任何步骤——
   一个不合法的 projects.yaml 意味着"这个产品当前声明了哪些平台"这件事本身无法确定，
   任何下游判断都建立在流沙上。
3. 由 projects.yaml 构造 declared[platform] 集合与 {path, ci} 列表（D3/D4）。
4. 读 PR 变更文件路径列表（GET /pulls/{pr}/files，复用 §4.5 的 fetchChangedFiles，与
   步骤 1 是两次不同的 API 调用，见 §4.2 对"detect 用 PR-files 端点、sdd impact 用
   compare 端点"这两个端点不完全等价的自查说明）。
5. 对每条变更路径分类（§2.4 的表），累积出一个"路径规则贡献的平台信号"+ 一个
   needs_impact 布尔（specs/**、design/**、contracts/** 任一命中即为 true）。
6. needs_impact 为 true → 调用 computeImpact（同进程函数调用,不是子进程/不是重新调用
   sdd impact CLI）：
     - 失败或输出未通过 impact.schema.json 校验 → detect 立即失败（fail closed，
       退出码 3）——这是用户起始需求里明确要求的一条：sdd impact 失败绝不能被悄悄吞掉
       变成"detect 判成什么都不需要跑"。
     - 成功 → 把 impact.platforms.{backend,web,ios,android} 并入累积信号。
7. 并入 PR 标签：每个 platform:<x> 标签只能把对应位从 false 强制为 true（§2.6）。
8. 最终 AND declared[platform]（D4），得到 4 个最终布尔。
9. 计算 contract_changed（§2.7，与上述判定完全独立的一条窄口径规则）。
10. 打印 JSON 到 stdout，退出码 0。
```

### 2.3 路径 → 平台映射（D3 的算法）

```ts
interface ComponentRef { path: string; ci: 'java' | 'web' | 'ios' | 'android' }

function mapPath(changedPath: string, components: ComponentRef[]): ComponentRef | undefined {
  return components.find(
    (c) => changedPath === c.path || changedPath.startsWith(`${c.path}/`),
  );
}
```

`ci` 枚举值到 `detect` 输出字段名的映射是固定的：`java→backend`、`web→web`、
`ios→ios`、`android→android`（沿用 `projects.schema.json` 里 `ci` 字段本身就是这四个
值、`detect` 输出字段名沿用手册 §9/M2 stub 已经使用的 `backend/web/ios/android` 四个
名字——两者不是同一个词表，`ci: java` 映射到输出字段 `backend`，这一处易错的换名点在
`schemas/projects.schema.json` 与 `implementation-plan.md`/`single-repo-implementation-
runbook.md` 里本来就是一致的既有约定，本文只是显式点出，不是新增规则）。

**未匹配到任何 component 的 `apps/**` 路径**（理论上不应出现——scaffold 只在获批 component
的 `path` 下生成内容，M3 D3 明确"移除的 component 不删除已生成目录，只产出 warning"，
所以`apps/**` 下出现一个不对应任何当前 component 的路径，只可能来自：该 component 曾经
被批准过、后来从 `projects.yaml` 移除、但目录留存后又被人工继续修改；或者是人工/攻击者在
`apps/**` 下新建的、从未经过 scaffold 的目录）→ 按 D5 保守性原则，**归入全部
`declared` 平台**，不归入"该路径看起来最像哪个平台"这类猜测,也不单独判 `detect` 失败
（这不是一个明确的错误状态,只是一个信息不足的状态,处理方式与其他"信息不足"场景一致，
统一用 D5 兜底,不为它单开一条失败路径）。

### 2.4 路径分类规则表（扩展手册 §9，标注是否需要调用 impact）

| 变更路径 | 平台信号 | 是否需要 `sdd impact` |
|---|---|---|
| `apps/**`，能匹配到某 component | 该 component 的 `ci` 对应平台 | 否 |
| `apps/**`，未匹配任何 component | 全部 `declared` 平台（D5 兜底，§2.3） | 否 |
| `contracts/openapi.yaml` 或 `contracts/events.yaml`（`contracts/**`） | 全部 `declared` 平台（静态规则，不依赖 impact 结果） | 是（用于 `changed.operations`/`breaking`/审计，见 §2.5；`contract_changed` 单独按 D8 窄口径计算，见 §2.7） |
| `design/tokens/**` | `declared` 中的 web/ios/android（不含 backend） | 是（用于 `changed.screens`；平台布尔仍是静态规则） |
| `specs/<version>/design.md` | 同上（`design.md` 虽然物理路径在 `specs/` 下，但按 `track:design` 的语义与 `design/tokens/**` 同等对待，见 §2.5） | 是 |
| `specs/<version>/architecture.md` 或根级 `projects.yaml` | 全部 `declared` 平台（保守，D5） | 是（用于 `changed.requirements`/`changed.operations` 审计；`projects.yaml` 本身变化还决定了 `declared` 集合自身，见下方说明） |
| `specs/<version>/spec.md`（且同一 PR 未出现上一行的 architecture.md/projects.yaml 变化） | 由 impact 的整篇文档 diff 结果决定：有实质内容变化 → 全部 `declared` 平台；规范化后无变化 → 均不选中 | 是 |
| `.github/**` 或任何未落入以上任何一类的路径 | 全部 `declared` 平台（D5 兜底——产品仓模板按 M2/M3 设计不含任何 workflow 文件，此处出现变化即为反常状态，不额外发明"workflow validation" 类新 job，直接保守处理即可，不构成 M4 范围扩张） | 否 |

**`projects.yaml` 变化与 `declared` 集合自身变化的说明**：`detect` 每次运行都用**当前
这次判定的 PR head SHA** 读 `projects.yaml` 来算 `declared`（§2.2 步骤 2/3），所以即使
这次 PR 本身就是一次 Architecture Gate（改了 `projects.yaml`，新增/移除了某个平台），
`declared` 集合已经自动反映了"这次变更之后"的拓扑,不需要额外区分"变更前/变更后"两套
`declared`——**自查**：这里唯一需要注意的是,若这次 PR **新增**了一个此前不存在的平台
（如首次引入 `ios`），此时 `apps/ios/**` 目录还不存在（Scaffold PR 是另一个、通常在后
的独立 PR，M3 D5"Scaffold 只开 PR，不直推 main"），单纯的 Architecture Gate PR 不会有
任何 `apps/**` 路径变化，只会摸到 `architecture.md`/`projects.yaml`——按上表第五行，
这类变化归入"全部 declared 平台"（此时 `declared` 已经把新平台算进去了）,`ios` 会被
判 `true`，但 `ios_paths` 是空数组（`projects.yaml` 里新 component 的 `path` 目录尚未
生成）——回到 §1.2 的说明，空 `paths` 数组下 `strategy.matrix` 产生零个实例，`ios`
job 不会因为"目录不存在"而报错,只是没有任何 matrix 实例地"成功"（GitHub Actions
对零实例矩阵 job 的默认行为是该 job 判定为 `success`）。这个结果是良性的——手册 §12.3
关心的是"Scaffold PR 落地后 CI Gate 仍然绿"，而不是"Architecture Gate PR 自己必须真的
跑一次刚批准但还不存在的平台的构建"，这里不需要额外特殊处理。

### 2.5 核心难题：没有 task 图时如何把变更映射到平台

M4 阶段 `sdd impact` 唯一能看到的输入是：两个 ref 各自的 `specs/**`/`design/**`/
`contracts/**`/`projects.yaml` 文本内容,以及从中能提取的 ID（`REQ-*`/`SCR-*`/
`operationId`）。它**看不到**"哪个 task 实现了哪个 REQ、影响哪个平台"这张图——那是 M5
`sdd backlog compile` 才建立、依赖稳定 task ID 与 Issue marker 的东西。以下逐类说明
M4 阶段"能诚实地做到多精确"，以及为什么不能再精确。

**`contracts/**` 变化**：手册 §9 静态表已经给出"全部四平台"——这是唯一不需要 impact
帮忙判断布尔值的一类（任何客户端平台理论上都可能调用任何 operation，M4 没有"哪个平台
调用哪个 operation"的映射，全平台是唯一诚实的答案）。impact 仍然要跑，但只是为了算
`changed.operations`（操作 ID 的集合对称差,§2.5 下方"审计字段"小节）与 `breaking`
（D7 的窄口径启发式），这两个字段的值不影响布尔判定,纯粹是报告内容。

**`design/tokens/**` 与 `specs/<version>/design.md` 变化**：手册 §9 给出"web+ios+
android"（不含 backend，设计不直接影响后端服务逻辑，这条排除是合理的、不依赖 impact
精细化）。是否可以按 Figma 页面惯例（手册 §6.5 提到的"10 iOS/20 Android/30 Web"分区）
把改动进一步收窄到具体某一个客户端平台？**不行**——M2 模板里 `design/tokens/` 只有一个
占位 `README.md`,没有任何已确立的、`detect` 可以安全依赖的子路径命名约定（Design Gate
落地时具体怎么组织 `design/tokens/` 下的文件是留给实现时决定的,不是本文档能引用的
既有契约）。在没有稳定子路径约定的前提下尝试收窄，一旦某产品的实际目录结构和这里假设的
不一致，会静默漏判——这正是 D5 保守性原则要求避免的方向,因此保持"web+ios+android"这个
不收窄的静态规则，不在 M4 尝试更细的路径级收窄。

**`specs/<version>/architecture.md` 或根级 `projects.yaml` 变化**：架构文档描述组件
边界、依赖方向、数据/安全/性能策略——这些内容结构上可能牵涉任何一个已声明的 component，
M4 没有可靠的子结构可以用来判断"这次架构改动只涉及某个特定平台"。保守处理为全部
`declared` 平台。

**`specs/<version>/spec.md` 变化（且未同时改 architecture.md/projects.yaml）**——
本节是全文最难的判断，也是本文档起草时唯一被自查推翻重写过一次的部分：

最初设计尝试按 `REQ-<AREA>-<n>` ID 出现的位置把 spec.md 切成若干"块"（从一个 REQ-ID
出现处到下一个 REQ-ID 出现处之间的文本算作该 REQ 的内容），只对"块内容有变化"的
REQ-ID 计入"有实质变化"，否则判定为"纯文档整理，不触发任何平台"——这是对手册 §9
"specs/** -> sdd impact 决定，不默认运行所有重型 CI"这句话的字面呼应,希望做出比
"整篇文档变了就全触发"更精细的结果。

**自查发现的问题**：spec.md 模板固定要求的必填小节里，"非功能需求"、"In/Out
scope"、"风险与未决问题"（见 M2 §1.1 表格）这几类内容**不一定**紧跟在某个 REQ-ID
之后，可能整段位于全部 REQ-ID 之前、之后，或作为独立小节存在，不被任何 REQ-ID
"锚定"。如果有人实质性地修改了"Out of scope"一段（比如把原本排除的一个场景重新
纳入范围）——这显然是应该触发下游 CI 的实质变化——按"只看 REQ-ID 锚定块"的算法，
这段文本改动不属于任何 REQ 块,会被错误归类为"无实质变化"，从而错误地判定为
"不触发任何平台"。这是一个**在完全合法、常见的输入下静默漏判**的问题（sdd-review-
rigor memo 描述的"看起来更精细的方案在不起眼的合法输入下失效"这一类），比"不够
精细但不会漏判"的方案更危险。

**改用的方案**：不按 REQ-ID 分块，改为对整篇 `spec.md` 内容做**规范化文本比较**
（去除首尾空白、把连续空行折叠为一行，不做任何 markdown 语义解析）：base 与 head
的规范化文本**完全相同** → 判定"无实质变化"（典型场景：文件路径被 rename 但内容
字节不变、纯粹的 diff 噪音）；**存在任何差异** → 判定"有实质变化"，归为全部
`declared` 平台（D5）。这确实牺牲了"能不能只触发受影响的那一两个平台"这个更理想的
目标,但这个目标在没有 task 图的 M4 阶段本来就无法诚实地达成——**保留"至少不会
漏判"这个更基本的正确性属性，优先于"看起来更精确但可能漏判"**。手册"不默认运行所有
重型 CI"这句话的实际含义，在本文档的理解里，是相对于"specs/** 一律无条件触发全部
CI，不区分是否真的有内容变化"而言的——本文档的方案确实做到了"内容未变则不触发"，
只是"有变化时应该触发多少"选择了保守而非精细。

**`changed.requirements`/`.screens`/`.operations`（报表字段）的独立算法（D6）**：与
上述"是否触发平台"完全独立计算，定义为**ID 集合的对称差**——用既有正则
（`REQ_ID_RE`/`SCR_ID_RE`/operationId 行提取，§4.5 从 `gate-hygiene.ts` 搬到共享
模块后两处复用同一份）分别提取 base、head 各自出现的 ID 集合，`changed.requirements
= (head 集合 \ base 集合) ∪ (base 集合 \ head 集合)`（新增的 ∪ 消失的；一个 ID 在
两侧都存在但其周围文本变化,不算作该 ID "变化"——这类"内容变了但 ID 集合不变"的
情况完全由上一段的整篇文档 diff 结果来触发平台信号，`changed.requirements`只负责
诚实地回答"哪些 ID 是新增/消失的"，不试图回答"哪些 ID 的内容变了"，避免重新引入
上面被推翻的按 ID 分块尝试）。`changed.operations` 用同样的对称差算法应用于
`contracts/openapi.yaml` 提取出的 `operationId` 集合。

**`breaking`（D7）**：`base 中存在、head 中不存在的 operationId 集合`非空 → `true`，
否则 `false`。改名在没有显式标注时与"删除+新增"在 ID 集合层面无法区分，保守地按
"删除"计入 breaking——这与 D5 的保守性原则一致方向（宁可误报 breaking、不可漏报）。

### 2.6 PR 标签并入

```ts
const label = pr.labels.find((l) => l.name === `platform:${platformName}`);
// platformName ∈ {backend, web, ios, android}——注意这里用的是 detect 输出字段名，
// 不是 ci 枚举值（java/web/ios/android），两个词表在这一处再次需要小心不要混用。
if (label) forced[platformName] = true;
```

手册明确"`platform:*` 标签只能把对应输出从 `false` 强制为 `true`，不得用于跳过本应
执行的检查"——因此标签只做 OR，不做 AND/NOT；即使某平台的路径规则和 impact 都判定为
`false`，打上对应标签也能强制为 `true`（人工介入，比如怀疑 detect 的静态规则有遗漏，
想手动确保某平台也测一遍）。最终仍然经过 D4 的 `declared` AND——给一个从未声明过的
平台打标签不会凭空让 CI 去构建一个不存在的目录（§0 D4 已详细论证原因）。

### 2.7 `contract_changed` 输出（留给 M4.5）

```ts
const contractChanged = changedFiles.some(
  (f) => f.filename === 'contracts/openapi.yaml' && f.status !== 'removed',
);
```

精确匹配单一路径（D8），不复用 §2.4 表格里"contracts/**"这个宽口径 bucket 的结果——
两者服务不同的下游（前者是 M4.5 Contract Gate 的触发条件，后者是本里程碑平台矩阵的
触发信号）。`status !== 'removed'`：文件被删除不应触发"合同变化需要 Contract
Gate"（M4.5 的合同变更 Gate 是为了审查新/改的合同内容，纯删除是另一个话题，不在手册
§8.1 描述的触发范围内；M4 不必也不应该替 M4.5 决定"删除 openapi.yaml 该怎么处理"这个
问题,只需要如实透传"这条路径是否发生了 added/modified 意义上的变化"）。M4 本身没有任何
job 消费 `contract_changed`——它是一个**现在就接好、但暂时没有订阅者**的输出，M4.5
落地时直接读它，不需要回头再改 `detect` 的输出结构。

### 2.8 触发事件类型需要扩展

`ci-gate.yml` 当前 `on: pull_request: branches: [main]`（未显式写 `types:`，等同于
GitHub 默认的 `[opened, synchronize, reopened]`）。**问题**：`platform:*` 标签是 §2.6
里唯一能"事后强制"平台信号的机制,但给一个已打开的 PR **添加/移除标签**这个操作本身
不属于默认的三种触发类型——如果一个 PR 已经跑过一次 `detect`（比如四个平台都判 false），
之后人工加上 `platform:ios` 标签、但没有推新 commit，`ci-gate.yml` **不会自动重新
运行**，required check 停留在旧的判定结果上,标签形同虚设。这是一个在完全正常的人工
操作流程下（"看了一眼 PR，决定手动强制多测一个平台"）会静默失效的问题,必须修：

```yaml
on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, labeled, unlabeled]
```

只改 `ci-gate.yml` 的触发器,不改 `pr-hygiene.yml`（hygiene 的规则不读 `platform:*`
标签，不受影响，两个 workflow 的 `on:` 各自独立声明，互不干扰）。

### 2.9 `detect` job 新增的 checkout/构建步骤

M2 stub 的 `detect` job 目前没有任何 checkout/构建步骤（纯 bash echo）。M4 需要让它
真正跑 `sdd` CLI，因此新增的步骤序列**逐字复用 `pr-hygiene.yml` 已经建立并经过 M2
验收的模式**（解析 `github.workflow_ref` 得到平台仓 source、用 `github.workflow_sha`
checkout 平台仓自身、安装依赖、构建、运行 CLI），不再发明新的可信来源解析方式——这既是
复用既有工程，也是保持"两个平台 job（`PR hygiene`、`detect`）用同一套已验证过的可信
checkout 模式"这一属性，任何一处的安全性论证（§3.6 系列文档）天然适用于两者。唯一
不同点：`pr-hygiene.yml` 调 `gate hygiene`，`detect` 调 `gate detect`；`detect` 的
`GITHUB_TOKEN` 权限需求与 `pr-hygiene.yml` 完全相同（`contents:read` 读 blob 内容、
`pull-requests:read` 读 PR 元数据/标签/变更文件列表），`ci-gate.yml` 现有的顶层
`permissions:` 块已经声明了这两项，**不需要扩权**。

## 3. CI Gate 聚合扩展

### 3.1 扩展后的结构

```yaml
CI Gate:
  name: CI Gate
  needs: [detect, backend, web, ios, android]
  if: always()
  runs-on: ubuntu-latest
  steps:
    - name: aggregate
      run: |
        # 第一步（D13）：detect 自身必须成功，与任何平台 job 的判断无关，
        # 排在最前面，不能被下面的平台真值表逻辑绕过。
        if [ "${{ needs.detect.result }}" != "success" ]; then
          echo "detect job did not succeed (result: ${{ needs.detect.result }})"
          exit 1
        fi

        # 第二步（D12）：对四个平台 job 分别应用化简后的两条规则——
        #   规则 1：result 是 failure/cancelled → 无条件失败；
        #   规则 2：detected=true 且 result=skipped → 失败。
        # 四段几乎相同的 shell 判断，不用循环抽象（见下方说明）。
        FAILED=0

        # backend
        if [ "${{ needs.backend.result }}" = "failure" ] || [ "${{ needs.backend.result }}" = "cancelled" ]; then
          echo "backend failed"; FAILED=1
        elif [ "${{ needs.detect.outputs.backend }}" = "true" ] && [ "${{ needs.backend.result }}" = "skipped" ]; then
          echo "backend was detected but skipped"; FAILED=1
        fi

        # web（与 backend 同构，job 名/output 名换成 web）
        if [ "${{ needs.web.result }}" = "failure" ] || [ "${{ needs.web.result }}" = "cancelled" ]; then
          echo "web failed"; FAILED=1
        elif [ "${{ needs.detect.outputs.web }}" = "true" ] && [ "${{ needs.web.result }}" = "skipped" ]; then
          echo "web was detected but skipped"; FAILED=1
        fi

        # ios（与 backend 同构，job 名/output 名换成 ios）
        if [ "${{ needs.ios.result }}" = "failure" ] || [ "${{ needs.ios.result }}" = "cancelled" ]; then
          echo "ios failed"; FAILED=1
        elif [ "${{ needs.detect.outputs.ios }}" = "true" ] && [ "${{ needs.ios.result }}" = "skipped" ]; then
          echo "ios was detected but skipped"; FAILED=1
        fi

        # android（与 backend 同构，job 名/output 名换成 android）
        if [ "${{ needs.android.result }}" = "failure" ] || [ "${{ needs.android.result }}" = "cancelled" ]; then
          echo "android failed"; FAILED=1
        elif [ "${{ needs.detect.outputs.android }}" = "true" ] && [ "${{ needs.android.result }}" = "skipped" ]; then
          echo "android was detected but skipped"; FAILED=1
        fi

        if [ "$FAILED" = "1" ]; then
          echo "CI Gate failed"
          exit 1
        fi
        echo "CI Gate passed"
```

**为什么四个平台各写一遍而不是循环**：GitHub Actions 的 `${{ needs.<job>.result }}`
这类表达式在 job 名是字面量时才能被解析，不能用 shell 变量在运行时拼出
`needs.$p.result` 这样的表达式（那是纯 bash 字符串，不会被 Actions 表达式引擎二次
求值）。真正可行的循环写法需要借助一个 JSON 中间结构（例如先把四个
`needs.*.result`/`needs.detect.outputs.*` 值组装成一个 JSON 对象、再用 `jq`
遍历），这样在可读性上不比直接展开四段更好，且引入了额外的 JSON 拼装步骤本身的
出错面。M2/M3 目前的 YAML 风格（大量重复但直白的 bash 判断，例如
`gate-hygiene.ts` 里 architecture/design/plan 三个分支手工分别处理而非泛化循环）
也倾向于"清楚优先于精简"，本文与之保持一致。

### 3.2 真值表等价性（复述 D12，落到实现）

见 §0 D12 的完整论证；此处只强调实现层面的直接后果：聚合 step 对每个平台只问两个
问题——"它失败/被取消了吗"（无条件失败）、"它被跳过了、但 detect 说它应该跑吗"
（失败）。不需要显式处理 `detected=false` 的任何分支（`false` 时无论平台 job 是
`skipped` 还是意外 `success`，两条规则都不会触发失败）。

### 3.3 detect 失败的短路检查必须在最前面（复述 D13，强调实现顺序）

`needs.detect.result` 检查必须是聚合 step 的**第一条可执行语句**（`exit 1` 在四个
平台判断之前）。这不是风格偏好——如果这行检查被误放在四个平台判断**之后**（比如
Codex 实现时把它当成"最后再兜底检查一下"），考虑这个场景：`detect` 因为
`sdd impact` 报错而失败,四个平台 job 的 `if:` 条件全部求值为假（§0 D13 已经论证
`needs.detect.outputs.*` 在这种情况下是空字符串,不是 `'false'`）,于是 backend/
web/ios/android 全部 `skipped`——四条平台规则在"`detected` 值为空字符串（不等于
`'true'`）且 `result=skipped`"的组合下,两条规则都不触发失败（第一条看
`result`，`skipped` 不是 `failure`/`cancelled`；第二条要求 `detected='true'`，
空字符串不满足）——如果这时候 `detect` 检查还没执行到，聚合 step 会一路判断到底、
输出"CI Gate passed"，而 `exit 1` 那行本该在最前面执行、根本不会让代码走到这里。
**结论**：检查顺序本身就是正确性的一部分，不是"反正最后都会检查所以无所谓"，必须在
文档和实现里都明确写出"这行必须在最前面"，并在测试里覆盖"detect 失败 + 四个平台
因此全部 skipped"这一具体场景断言 `CI Gate` 判失败（见 §6）。

## 4. `sdd impact` 命令、包结构与接口

### 4.1 CLI 接口

```bash
# 通用分析命令：人和 CI 都能调用
sdd impact --base <ref-or-sha> --head <ref-or-sha> [--repo <owner/name>] [--format json|text]

# CI 专用编排命令：只在 detect job 里调用
sdd gate detect --repo <owner/name> --pr <number>
```

`sdd impact`：
- 给了 `--repo`：API-backed 模式（D9），`--base`/`--head` 必须是完整 40 位 commit
  SHA（不满足 → 退出码 2），需要 `GITHUB_TOKEN` 环境变量；对应手册 §9 的 CI 用法
  （尽管手册 §9 的示例文字没有显式写 `--repo`，这与手册对 §5.1
  `sdd product init demo --mode monorepo --dry-run` 省略 `--owner` 是同一类
  "示例性省略"，M2/M3 已经多次做过这类"把手册示例落成完整 CLI 签名"的补齐,不是
  对手册的偏离）。
- 不给 `--repo`：本地 git 模式（D9），`--base`/`--head` 可以是任意本地 git 版本
  表达式（`origin/main`、`HEAD`、分支名等），对应手册 §10.1 的本地用法，需要在一个
  真实 git 仓库的工作目录里执行。
- `--format`：默认 `json`；`text` 是同一份数据的人类可读渲染（受影响 requirement/
  screen/operation 列表、受影响平台、breaking 与否——§10.1 报告内容里"受影响
  Issues"/"建议的 Change Issues"两项本里程碑不产出，见 §5.3）。
- 退出码：`0` 成功产出报告（无论内容是否为空,都算成功）；`2` 输入错误（如
  `--repo` 模式下 `--base`/`--head` 不是合法 40-hex）；`3` 分析失败（fail closed，
  如 `projects.yaml` 不合法、Git/API 读取报错）。

`sdd gate detect`：
- 恒定 API-backed（CI 专用，不支持本地模式），恒定输出 JSON（无 `--format`
  flag——只有一个消费者，即 `ci-gate.yml` 里那个用 `jq` 解析的 workflow step，不需要
  为它另外支持文本渲染）。
- 退出码：`0` 判定完成（无论四个平台是 true/false）；`2` 输入错误；`3` 判定失败
  （fail closed，如 impact 调用失败、`projects.yaml` 不合法）。

### 4.2 `ImpactReader`：两个后端（D9）

```ts
// factory/src/impact.ts
export interface ChangedPath {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
}

export interface ImpactReader {
  listChangedPaths(base: string, head: string): Promise<ChangedPath[]>;
  /** null = 文件在该 ref 不存在（正常情况，如新增文件在 base 侧不存在），
   *  不是错误；只有真正的读取失败（网络、鉴权、ref 不存在等）才抛异常。
   *  这个 null/throw 的区分是有意的（D9/D16）：调用方需要能区分
   *  "这个文件在这个版本里本来就没有"和"我们没能读到这个文件"，
   *  两者处理方式完全不同（前者是 impact 分析的正常输入，后者要 fail closed）。 */
  readFileAt(ref: string, path: string): Promise<string | null>;
}

export function createApiImpactReader(
  octokit: MinimalOctokit, repo: RepoRef,
): ImpactReader;   // GET /compare/{base}...{head} + GET /contents/{path}?ref=

export function createLocalGitImpactReader(repoRoot: string): ImpactReader;
  // shells out to `git diff --name-status base head` + `git show ref:path`
```

`createApiImpactReader` 用**compare API**（`GET /repos/{o}/{r}/compare/{base}...
{head}`），不是 `sdd gate detect` 自己读变更文件用的 **PR-files API**——两者概念上
都是"base 和 head 之间变了什么"，但服务于不同调用形状：`sdd gate detect` 已经有一个
PR 号（CI 场景），直接查该 PR 的 files 端点最自然；`sdd impact`/`computeImpact` 只有
两个 ref、完全不假设存在 PR（本地模式下确实没有 PR），只能用 compare 端点或本地
`git diff`。**自查**：这两个 GitHub 端点各自有自己的文件数截断阈值（compare API
默认 300 个文件截断、PR-files 端点分页上限 3000），理论上对同一对 base/head SHA，
两者报告的"变更文件集合"在正常 PR 规模下应当一致,但这不是本文能验证的代码级保证
（这是两个独立 GitHub REST 端点各自的实现细节,不是本仓库能控制的行为）。这是一个
诚实记录、但评估为低风险的假设（典型 Gate PR 的改动文件数远低于两个阈值），不是
掩盖不谈；若未来出现改动文件数逼近阈值的异常大 PR，两个信号来源可能出现不一致，
这一风险已经记录在 §11 待决事项。

### 4.3 包结构

```text
factory/src/
├── github-minimal-client.ts   # 新增（D16）：MinimalOctokit + fetchPullRequest /
│                               #   fetchChangedFiles / fetchBlobAtRef（404→null）；
│                               #   REQ_ID_RE / SCR_ID_RE / operationId 提取正则
│                               #   从 gate-hygiene.ts 搬到这里，供三处共用
├── gate-hygiene.ts             # 改为从 github-minimal-client.ts 导入，删除自己的
│                               #   私有 fetchAllChangedFiles/fetchBlobContentStrict
│                               #   实现；行为不变，纯内部重构
├── impact.ts                   # 新增：ImpactReader 接口 + 两个实现 + computeImpact()
└── detect.ts                   # 新增：detectPlatforms()，内部按需调用 computeImpact()

cli/src/
├── octokit-client.ts           # 新增（D16）：createMinimalOctokit 从
│                               #   commands/gate/hygiene.ts 搬到这里
├── commands/
│   ├── impact.ts               # 新增：sdd impact
│   └── gate/
│       ├── hygiene.ts           # 改为从 ../../octokit-client.ts 导入
│       └── detect.ts            # 新增：sdd gate detect
```

`factory/src/index.ts` 新增导出（追加到既有列表，不移除/不改名任何现有导出）：

```ts
export { computeImpact, createApiImpactReader, createLocalGitImpactReader } from './impact.js';
export type { ChangedPath, ImpactReader } from './impact.js';
export { detectPlatforms } from './detect.js';
export type { DetectInput, DetectResult } from './detect.js';
export { fetchBlobAtRef, fetchChangedFiles, fetchPullRequest } from './github-minimal-client.js';
export type { MinimalOctokit } from './github-minimal-client.js';
```

`computeImpact`/`detectPlatforms` 的函数签名（镜像 `checkPrHygiene` 的注入风格）：

```ts
export interface ComputeImpactInput {
  reader: ImpactReader;
  base: string;
  head: string;
}
export async function computeImpact(input: ComputeImpactInput): Promise<SDDImpact>;
// SDDImpact 直接复用 @sdd/schemas 已生成的类型，不重新定义同形状的本地类型

export interface DetectInput {
  octokit: MinimalOctokit;
  repo: RepoRef;   // 复用 @sdd/factory 已导出的 RepoRef（{owner, repo}），不新造类型
  pr: number;
}
export interface DetectResult {
  backend: boolean; web: boolean; ios: boolean; android: boolean;
  backend_paths: string[]; web_paths: string[]; ios_paths: string[]; android_paths: string[];
  contract_changed: boolean;
  product_repo: string; head_sha: string;
}
export async function detectPlatforms(input: DetectInput): Promise<DetectResult>;
```

`cli/package.json` 的 tsup 构建脚本与 `cli/src/index.ts` 需要各自追加两个新命令入口
（`src/commands/impact.ts`、`src/commands/gate/detect.ts`），镜像现有的
`src/commands/gate/hygiene.ts` 那一份已有条目——这是纯机械的登记步骤,容易在实现时
漏掉（新命令文件写好了但忘记加进 tsup 的入口列表/`index.ts` 的具名导出，导致构建产物
里没有这个命令），在此明确点出以免遗漏。

### 4.4 与 `impact.schema.json` 的关系

**结论：不需要修改**（已实机核对 `main` 上 `schemas/impact.schema.json` 当前内容，
非转述早期文档）。M1 定稿的字段——`base`/`head`（必填 string）、
`changed.{requirements,screens,operations}`（必填 string[]）、
`platforms.{backend,web,ios,android}`（必填 boolean）、`breaking`（必填
boolean）、`affected_issues`/`suggested_change_issues`（可选 array，item 结构已
定型）——与本文 §2 设计产出的字段一一对应：M4 产出前五组必填字段的真实值，后两个
可选数组字段留空（`[]`）或省略（schema 未要求必填），M5 直接往同一份 schema 里
填充，不破坏兼容性。`@sdd/schemas` 也已经导出 `validateImpactDocument`（实机核对
`schemas/src/index.ts`/`validators.ts`），`computeImpact` 产出结果后应在返回前
自校验（`validateImpactDocument(result)`，校验失败视为内部 bug、抛异常——不应该
发生，属于"代码本身产出了不符合自己 schema 的东西"这类不应通过 fail-open 掩盖的
错误,而是让它像别的分析失败一样传播成 `sdd impact`/`sdd gate detect` 的退出码
`3`）。

### 4.5 共享 helper 抽取（D16 的落地细节）

`factory/src/gate-hygiene.ts` 当前私有实现的 `fetchAllChangedFiles`（分页读 PR
变更文件）、`fetchBlobContentStrict`（按 ref 读 blob，任何失败都抛异常）需要
搬到新的 `github-minimal-client.ts`；`fetchBlobContentStrict` 搬迁时改名/改造为
`fetchBlobAtRef`，语义从"严格失败"改为"404 时返回 `null`，其余错误照常抛出"——
这不是原地照搬，是刻意收窄：`gate-hygiene.ts` 原本所有读取场景（artifact/
CODEOWNERS）都要求文件必须存在，"读不到"本来就该算失败，語义上"严格"是对的；
但 `computeImpact` 里"base 侧文件不存在"（新增文件、新引入的 openapi.yaml 等）
是完全正常的情况,不能被当成失败。`gate-hygiene.ts` 里原来调用
`fetchBlobContentStrict` 的地方需要相应改为"调用 `fetchBlobAtRef`，若返回
`null` 则视为违规"（因为在 hygiene 的场景下文件确实必须存在),这样两处消费方各自
在自己的语义层面决定"null 算不算错误"，底层 helper 只负责如实区分"不存在"与
"读取失败"两种情况，不替调用方预设。`REQ_ID_RE`/`SCR_ID_RE`/operationId 提取
正则同样从 `gate-hygiene.ts` 搬到 `github-minimal-client.ts`（或专门的
`id-patterns.ts`，具体文件划分留给实现时判断,不影响行为），供 §2.5 的
`changed.requirements`/`.screens`/`.operations` 计算复用，不重新定义一套等价
的正则（重新定义会带来"两处正则未来某次修改只改了一处"的漂移风险）。

## 5. 与 M3 / M4.5 / M5 的接缝

### 5.1 与 M3 的接缝复核

M3 方案文档 §5（"与 CI 的接缝"）已经把边界写得很清楚，本文核对后**完全一致，不
重新定义**：

- M3 §5.1："四个平台模板都不包含 `.github/workflows/*`" —— 本文 §1 的四个
  reusable workflow 全部位于**平台仓**，与 M3 的模板边界不冲突（M3 的模板只提供
  应用代码+构建配置，M4 的 workflow 只从平台仓侧引用这些命令契约,从不假设产品仓
  里存在任何 workflow 文件）。
- M3 §5.2："M3 交付的是命令契约,不是 CI 接线" —— 本文 §1.2 的四条命令族
  （lint/typecheck-等效/test/build）逐字对应 M3 §1 各平台模板表格,没有引入 M3
  未承诺的新命令。
- M3 §5.3/§5.4：Scaffold PR 落地后，M2 stub 版本的 `CI Gate` 必须保持绿——这条
  验收（手册 §12.4 第二层）在 M3 的时间线上早于 M4 实现,本文不影响它；M4 实现
  之后，同一份验收场景需要在**新版** `CI Gate` 下重新跑一遍（一个新增了
  `apps/*` 目录的 Scaffold PR，落在 M4 版 `detect` 之下,应该被正确路由到对应
  平台 job 并通过——见 §6 测试小节）。这是本文档新增的、M3 没有也不需要覆盖的
  一条回归测试，不代表 M3 的验收范围发生了变化。

### 5.2 与 M4.5（Contract Gate）的接缝

M4 只负责：(a) `detect` 输出 `contract_changed`（§2.7，精确 scope 到
`contracts/openapi.yaml`）；(b) `sdd impact` 报告里的 `changed.operations`/
`breaking` 用窄口径启发式计算（§2.5/D7，明确标注非最终结论）。**M4 不实现**
Contract Gate 本身——OpenAPI lint、真正的 breaking-change 结构化 diff、生成
TS/Swift/Kotlin client 并编译，这些都是 M4.5 的职责（依据手册 §8.1）。M4.5
落地时，`CI Gate` 的聚合逻辑（§3）需要再扩一次——增加 `Contract Gate` 到
`needs:` 列表,并把"`contract_changed=true` 时 `Contract Gate` 必须成功"这条
规则接进真值表（implementation-plan §M4.5 已经写明这条规则,本文不重复展开，
只确认 `contract_changed` 这个前置输出已经就位、字段名与语义足够支撑 M4.5
直接消费,不需要 M4.5 回头再改 `detect`）。

### 5.3 与 M5（Backlog Compiler / 受影响 Issues）的接缝

`impact.schema.json` 的 `affected_issues`/`suggested_change_issues` 两个字段
M4 阶段保持空数组或省略（schema 允许，见 §4.4）。手册 §10.1 描述的完整报告内容
里"受影响 Issues"、"建议创建的 Change Issues"两项，依赖稳定 task ID 与 Issue
marker（M5 `sdd backlog compile`/`publish` 才建立），M4 的 `computeImpact` 不
读取、也不试图猜测任何 GitHub Issue 状态。§10.2 的同步规则表（"未开始 Issue→
update diff"、"In Progress→Change Issue"等）整体是 M5 的职责,M4 的
`sdd impact` 只回答"这次变更看起来影响哪些平台"这一层,不回答"因此应该对哪些
现有 Issue 做什么操作"。

### 5.4 已存在产品仓的升级顺序（D15 的操作说明）

对已经完成 `--finalize-protection` 的既有产品仓（如 demo-product），M4 的
`ci-gate.yml`/四个新 workflow 生效需要两步、且有先后依赖：

1. 平台仓 `main` 先合入本里程碑全部改动，平台仓自身 TS workspace CI 通过。
2. 对每个既有产品仓：开一个内容无关紧要的验证 PR，观察新版 `CI Gate`（含
   `detect` 真实判定 + 按需调度的平台 job）产出真实绿色 check；确认后用 M2
   已交付的 `reconcileOrgWorkflowRuleset`（幂等）把该产品仓关联的专用 org
   ruleset 的 pinned SHA 前移到新 commit。

这条顺序直接复用 M2 §3.6"M4 迁移护栏"那句话，不是本文新发明的机制,本文只是把
"届时具体怎么操作"写清楚,避免实现或运维时需要重新推导。

## 6. 测试

- **`detect` outputs 接线回归**（vitest，针对 `ci-gate.yml` 本身的 YAML 结构做
  静态断言，镜像 M2 已有的"job name 冻结"守卫测试风格）：断言 `detect` job 的
  `outputs:` 每个字段值都形如 `${{ steps.<id>.outputs.* }}`（不是字面量字符串），
  且引用的 `<id>` 与 detect 步骤自身声明的 `id:` 一致；这是 D11 修复的直接回归
  测试，防止未来有人重新引入同类断连。
- **路径→平台映射**（`detect.ts` 单测，纯函数，注入假的 `ComponentRef[]`）：
  `apps/api-gateway/x` 不误判匹配 `path: apps/api`（D3 的路径分隔符边界测试，
  正向：`apps/api/x` 正确匹配 `apps/api`；负向：`apps/api-gateway/x` 不匹配）；
  多个 component 共享同一个 `ci` 值时，两者的 `path` 都出现在对应平台的
  `*_paths` 输出里；未匹配任何 component 的 `apps/**` 路径 → 归入全部
  `declared` 平台。
- **`declared` AND 门控**（`detectPlatforms` 单测，mock octokit + 固定
  `projects.yaml` fixture）：`projects.yaml` 只声明 backend+web 两个平台，`design/
  tokens/**` 变化 → `web=true` 但 `ios=false`/`android=false`（不因为 design
  静态规则包含 ios/android 就无视 `declared`）；对未声明的平台打
  `platform:ios` 标签 → 仍然 `ios=false`（标签不能绕过 `declared`）。
- **`sdd impact` 整篇文档 diff（D5/spec.md 场景，`impact.ts` 单测，fake
  `ImpactReader`）**：spec.md 在 base/head 之间字节完全相同 → 全部平台
  `false`；仅追加一个空行/尾随空白差异（规范化后相同）→ 全部平台 `false`；
  修改一段不挂在任何 `REQ-*` ID 下的"Out of scope"文本 → 全部 `declared`
  平台 `true`（这是本文档明确记录的、曾被推翻的按 REQ-ID 分块方案会漏判的
  具体场景，必须作为回归测试存在，不能只在文档里描述而不落实成测试）；修改
  一个 `REQ-*` 块内的验收标准文本 → 同样全部 `declared` 平台 `true`（与上一条
  用同一条整篇 diff 规则，不应该有不同结果）。
- **`changed.requirements`/`.screens`/`.operations`（ID 对称差，`impact.ts`
  单测）**：head 新增一个 REQ-ID、base 独有一个 REQ-ID 消失 → 两者都出现在
  `changed.requirements`；同一个 REQ-ID 在两侧都存在、且该 ID 本身只是恰好
  被提及两次（不视为新增/消失）→ 不出现在 `changed.requirements`（即使其
  周围文本发生变化——D6 的字段分离在测试里必须体现：这条用例应该同时断言
  `changed.requirements` 不含该 ID、但整篇文档 diff 判定为"有变化"，证明两套
  算法确实独立）。
- **`breaking`（`impact.ts` 单测）**：base 有、head 无的 operationId → `breaking
  =true`；仅新增 operationId、或仅修改现有 operation 的其余内容（operationId
  本身不变）→ `breaking=false`（M4 窄口径的诚实边界，注释里说明这类情况留给
  M4.5）。
- **`contract_changed`（`detect.ts` 单测）**：只改 `contracts/events.yaml`
  （不改 `openapi.yaml`）→ `contract_changed=false`，但平台布尔仍按 `contracts/
  **` 宽口径全部 `declared` 平台 `true`（两个字段在同一输入下给出不同结果，
  直接验证 D8 两者不应混用）；`openapi.yaml` 被删除（status=removed）→
  `contract_changed=false`。
- **`sdd impact` 失败传播（`detect.ts` 单测，mock `computeImpact` 抛异常）**：
  `needs_impact=true` 场景下 `computeImpact` 抛错 → `detectPlatforms` 本身
  抛错（不吞掉、不返回一个"看似正常"的默认结果），CLI 层相应退出码 `3`。
- **`CI Gate` 聚合真值表（针对 `ci-gate.yml` 聚合 step 的 bash 逻辑本身，用
  shell 层面的表驱动测试或等效的 workflow 单元测试工具）**：覆盖 §0 D12 表格
  全部 5 行 + 2 个手册未列出但需要安全处理的状态（`detected=false+success`→
  pass；`detected=false+failure` 模拟异常状态 → fail）。
- **detect 失败 + 全平台被跳过 → CI Gate 必须失败（§3.3 场景的直接回归
  测试）**：`needs.detect.result=failure`、四个平台 job 的 `result` 全部
  `skipped`、`needs.detect.outputs.*` 全部为空字符串 → 聚合 step 判定失败，
  且断言检查 `needs.detect.result` 的语句先于四个平台判断执行（避免未来重构
  把顺序打乱又不被测试捕获，例如通过检查一个"提前退出"的副作用标记来验证
  执行到达的确实是最前面那行,而不是巧合地在别处也失败了）。
- **iOS runner 门控（§12.5 场景，隔离环境 / GitHub Actions 实测,非 vitest）**：
  只改 `apps/backend/**` 的 PR → 观察 Actions 运行记录，确认 `ios` job 状态为
  `skipped` 且从未产生任何 macOS runner 排队记录（区别于"运行了但很快返回"）。
- **iOS/多组件矩阵（GitHub Actions 实测）**：`ios_paths` 为空数组时，`ios` 外层
  job 因 `if:` 为假直接跳过（不会走到 `fromJSON('[]')` 这一步）；`declared`
  含 ios 但目录未生成（新批准平台、Scaffold PR 尚未落地）时，`ios_paths=[]`
  且 `ios` job 以零 matrix 实例的方式"成功"（§2.4 说明的良性场景）。
- **Scaffold PR 回归（呼应 §5.1，M3 代码合并后可执行）**：一个新增 `apps/
  android/**` 的 Scaffold PR，在 M4 版 `detect` 下正确路由到 `android=true`、
  其余三平台 `false`（因为只有 android 的 `apps/**` 路径变化，且未触碰
  specs/design/contracts），`android` job 成功、其余三个 `skipped`，`CI
  Gate` 整体通过。
- **迁移路径（隔离测试环境，镜像 M2 §5.1/M3 §6 的隔离 org E2E 风格）**：对一个
  已 `--finalize-protection` 的产品仓,先在旧版 pinned SHA 下确认现状（M2 stub
  行为），推进平台仓到新版本、走 §5.4 的两步升级顺序，确认升级后同一产品仓的
  新 PR 能观察到完整平台矩阵生效，旧 PR（若仍打开）不受影响（required workflow
  的 pin 只在 org ruleset 显式前移后才切换，不会对已有 PR 运行历史产生追溯性
  影响）。

## 7. 交付文件树

```text
sdd-platform/
├── .github/workflows/
│   ├── ci-gate.yml                       # 扩展：detect 真实判定 + 四个平台 job +
│   │                                      #   CI Gate 完整真值表（§2/§3）
│   ├── java.yml · web.yml · ios.yml · android.yml   # 新增：reusable workflow（§1）
│   └── pr-hygiene.yml                    # 不改动
├── factory/src/
│   ├── github-minimal-client.ts          # 新增（D16）+ test/**
│   ├── gate-hygiene.ts                   # 重构：改用共享 helper，行为不变
│   ├── impact.ts                         # 新增：ImpactReader + computeImpact + test/**
│   ├── detect.ts                         # 新增：detectPlatforms + test/**
│   └── index.ts                          # 追加导出（§4.3）
├── cli/src/
│   ├── octokit-client.ts                 # 新增（D16）
│   ├── commands/impact.ts                # 新增 + test/**
│   ├── commands/gate/detect.ts           # 新增 + test/**
│   ├── commands/gate/hygiene.ts          # 改用 ../../octokit-client.ts
│   └── index.ts                          # 追加两个命令具名导出
└── cli/package.json                      # tsup 构建入口追加 impact.ts / gate/detect.ts
```

## 8. M4 完成定义（DoD）

- `detect` job 的 `outputs:` 全部由 `${{ steps.detect.outputs.* }}` 驱动，不含任何
  写死的字面量（D11 回归测试通过）。
- `sdd impact --base --head`（API 模式与本地 git 模式各自）产出符合
  `impact.schema.json` 的报告（`validateImpactDocument` 校验通过），`--format
  json|text` 均可用。
- `sdd gate detect --repo --pr` 产出四平台布尔 + 四个 `*_paths` + `contract_changed`
  + `product_repo`/`head_sha`，且：
  - 路径规则、`sdd impact` 结果、`platform:*` 标签的并集经 `declared[platform]`
    AND 门控（D4），测试覆盖"未声明平台不会被任何信号强制为 true"。
  - `sdd impact` 失败或输出非法 → `detectPlatforms` 抛错、CLI 退出码 `3`
    （不吞错、不静默降级为全 false）。
- `CI Gate` 聚合 job：`needs.detect.result != 'success'` 时无条件失败（检查顺序
  在最前面，§3.3 回归测试覆盖）；四个平台 job 按 D12 化简真值表判定，等价性覆盖
  手册 §9 全部 5 行 + 2 个未列出状态。
- 四个 reusable workflow 各自：`runs-on` 对应平台（`ios.yml` 为 `macos-*`）；
  `strategy.matrix` 按 `paths` input 驱动；显式 `with:` 传参，不依赖穿透
  `workflow_call` 的隐式 `github` 上下文（§1.1 自查项，§11 待验证假设除外）；
  外层 `if:` 门控保证未检测到的平台不分配 runner（iOS 尤其，§12.5 场景实测通过）。
- `ci-gate.yml` 触发器新增 `labeled`/`unlabeled` 事件类型，`platform:*` 标签
  仅打标签、不推新 commit 也能触发重新判定（D13/§2.8 场景实测通过）。
- 共享 helper 抽取完成（D16）：`gate-hygiene.ts` 不再包含私有的
  `fetchAllChangedFiles`/`fetchBlobContentStrict`/`createMinimalOctokit`
  实现，行为经既有 M2 测试套件回归验证不变。
- 工作区全绿：`pnpm install --frozen-lockfile` + `pnpm -r build && typecheck &&
  test && lint`，无生成漂移。
- §6 测试小节列出的全部用例（含 spec.md 整篇 diff 的具体回归场景、detect 失败
  传播场景）都已落实为可执行测试，不是仅停留在文档描述。

## 9. 验收映射与依赖

**§12 场景**：

- **§12.4** —— 根骨架和空 scaffold 的 `CI Gate` 成功：M2 已覆盖前一半（Bootstrap
  PR）与 M3 补齐的后一半（Scaffold PR 落地后仍绿，均基于 M2 stub）；本文新增
  "M4 版 `detect` 下 Scaffold PR 仍正确路由并通过"这一具体回归（§6）。
- **§12.5** —— 只改 backend 时，iOS macOS runner 不启动：§1.3/D14，隔离环境
  实测（§6）。
- **§12.7** —— specs-only PR 的 `detect` 使用 `sdd impact` 输出平台矩阵；
  impact 失败时 CI 失败：§2.5（spec.md 整篇 diff）+ §2.2 步骤 6 + §3.3（本文
  最核心的两块设计）。
- **§12.8** —— 平台 job 意外 skipped 时，`CI Gate` 失败：§0 D12 真值表第 3 行，
  §3 聚合实现。

**依赖 M1**：`@sdd/schemas` 的 `validateProjectsDocument`（`detect`/`computeImpact`
读取 `projects.yaml` 后的校验入口）、`validateImpactDocument`（`computeImpact`
自校验输出）、`SDDProjects`/`Component`/`SDDImpact` 生成类型（直接复用，不重新
定义同形状类型）——均已实机核对存在且签名符合本文假设。

**依赖 M2**（已合并 `main`，非规划文档）：`.github/workflows/{ci-gate,pr-
hygiene}.yml` 的既有结构与"required workflow 固定 `repository_id+path+sha`"
机制（D1 的四个 reusable workflow 直接依附这套已验证的 pin,不新增机制）；
`factory/src/gate-hygiene.ts` 的 `checkPrHygiene`/`HygieneOctokit` 风格（D16
抽取共享 helper 的重构基础）；`cli/src/commands/gate/hygiene.ts` 确立的
"CI 专用编排命令,业务逻辑委托 `@sdd/factory`"模式（D10 直接复刻）；
`reconcileOrgWorkflowRuleset` 的既有幂等语义（D15/§5.4 迁移路径复用，不新增
"升级"命令）。

**依赖 M3（方案已定，代码待实现，仅依赖其外部契约）**：四个平台模板各自固定的
lint/typecheck/test/build 命令契约（§1.2，M3 §1 各表格）；平台模板不含任何
workflow 文件这一约束（§1.1 的 D2 论证前提）；`component.path` 允许任意合法
子路径、不由 `id` 推导（D3，M3 D21 已钉死,本文与之保持一致）。**本文明确不
依赖** M3 factory 内部的 `verifyGateApproval` 调用细节、Scaffold PR 的
D18–D26 一系列授权/幂等修复——那些是 M3 自己的强制授权校验机制，M4 的
`detect`/`sdd impact` 不做任何形式的授权判断（D17）。

## 10. 不在 M4 范围

- **Contract Gate 本身**（OpenAPI lint、真正的结构化 breaking-change diff、生成
  TS/Swift/Kotlin client 并编译）→ **M4.5**。M4 只交付 `contract_changed` 输出
  （§2.7/§5.2）与窄口径、明确标注非最终结论的 `breaking` 启发式（D7）。
- **"受影响 Issues"/"建议的 Change Issues"**（依赖稳定 task ID 与 Issue
  marker）→ **M5**。`impact.schema.json` 的 `affected_issues`/
  `suggested_change_issues` 字段本里程碑保持空/省略（§5.3）。
- **`sdd impact`/`detect` 的授权强制校验**：两者是只读分析,不新增
  `@sdd/provenance` 调用点（D17）。
- **Provider conformance（Backend Implemented Gate）** → **M6**。
- **Release / 各平台 tag / 签名材料隔离** → **M7**。iOS/Android 的 CI job（本文
  §1.3/§1.2）只做未签名的本地构建/测试，不涉及任何签名 secret。
- **`sdd sync --check`** → **M8**。
- **设计 token 目录下按平台细分子路径的收窄规则**（§2.5 的 `design/tokens/**`
  讨论）：目前没有稳定的子路径约定可以安全依赖,本文选择不收窄；未来若 Design
  Gate 落地时确立了稳定的子目录约定，可以作为后续里程碑的收窄优化,不是 M4 的
  遗留缺陷。
- **`contracts/events.yaml` 是否也应该有自己的 Gate**：手册 §8.1 字面只提
  `openapi.yaml`，本文的 `contract_changed` 精确匹配这一条路径，不替 M4.5
  决定 `events.yaml` 要不要有类似机制（§0 D8 已说明）。
- **已存在产品仓自动升级到 M4 版 `ci-gate.yml`**：§5.4 只描述人工/运维操作顺序，
  不新增自动化"批量升级"命令或机制。

## 11. 待决事项（实现前需确认）

1. **验证默认 `GITHUB_TOKEN` 能否 checkout `inputs.product_repo` 指向的产品仓**
   （§1.1 自查项）：`pr-hygiene.yml` 已经证明该 token 能经 API **读**产品 PR，
   但读 API 与 `actions/checkout` 走的是 GitHub 两套不同的权限判定路径,没有
   直接证据证明后者对一个"required workflow 定义在别的仓库、通过 `workflow_
   call` 再调用一层"的场景同样成立。需要在隔离测试环境（复用 M2/M3 已经建立
   的隔离 org E2E 习惯）实测：一个产品仓 PR 触发 `ci-gate.yml`（专用 org
   ruleset pin 到平台仓）,`java.yml` 内的 `actions/checkout@v4` 用
   `repository: <product-repo>` + 默认 `GITHUB_TOKEN` 能否成功 checkout。若
   不能，需要引入一个专门 scope 到"读取同组织内产品仓内容"的 GitHub App
   token（比 M2 §2.7 已经讨论过的 Factory 生产身份问题多一层：不仅要能建仓/
   配置，还要能在 CI 运行时 checkout）。
2. **compare API 与 PR-files API 在同一 base/head 上的变更文件集合是否可能
   不一致**（§4.2 自查项）：本文评估为低风险（正常 PR 规模远低于两个端点各自
   的截断阈值），但没有代码级保证。若未来观察到因此产生的 detect 误判,需要
   收敛为统一使用其中一个端点（可能需要 `sdd gate detect` 也改用 compare
   API，放弃 PR-files 端点,以求两处"变更路径"定义完全同源）。
3. **四个平台模板具体的 `runs-on` 版本**（如 `macos-14` 的具体可用性）：与
   M3 §11 待决事项 #3 同类,实现时按 GitHub-hosted runner 当时实际支持的
   镜像版本核实，需要与 M3 模板锁定的 `.xcode-version` 相容。
4. **`design/tokens/**` 子路径按平台收窄的可行性**：见 §10，非本里程碑阻塞项，
   记录以便 Design Gate 实现细节确定后重新评估。

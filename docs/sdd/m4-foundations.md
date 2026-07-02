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
>
> **本版（第 2 稿）据 Codex 评审修正 5 处 P1（均为第 1 稿自身的实现细节问题，不是新维度）**：
> `*_paths` 的定义与"新批准平台但未 scaffold 时 `ios_paths=[]`"的断言互相矛盾——第 1 稿从未
> 给出"路径是否已在 head 实际存在"的检查算法，两处描述在实现时必然二选一地打自己的脸。新增
> **D18**：引入 `existing[platform]`（declared 且至少一个 component 的 `path` 在 head tree
> 里真实存在）取代 D4 原来的 `declared[platform]` 作为最终 AND 门，`*_paths` 的定义直接绑定
> 到同一次存在性检查的结果,不再是两个可能分道扬镳的独立断言。`ImpactReader`/`ChangedPath`
> 完全没有 rename 的"原路径"信息，导致"内容不变的 spec.md rename"会被误判为内容变化、
> "整个 component 目录搬迁"会漏掉源路径——新增 **D19**，两个 reader 后端都要提供
> `previousPath`。把 `changed.requirements`/`.screens`/`.operations` 定义成纯 ID 集合对称差
> 是对"变更 requirement"这个报表字段本身语义的误读（一个 REQ-ID 全文重写但 ID 不变,报告
> 应该说"变了"而不是空）——新增 **D20**，报表字段改回按 ID 分块 diff（第 1 稿放弃这个算法
> 是因为**平台布尔判定**不能靠它，不是因为它不适合用来回答"哪些 ID 变了"这个问题本身，
> 两个字段现在各自用对自己正确的算法，互不干扰）。路径分类表遗漏了 `specs/<version>/plan.md`
> 与"该目录下其它合法但未枚举的文件"，两者会落进完全不同、且不调用 impact 的兜底桶——新增
> **D21**，把 `specs/<version>/**` 处理成一个统一 bucket；同一条决策里也正面回应"spec.md
> 实质变化即触发全部平台"事实上约等于"specs/\*\* 默认跑全部重型 CI"这一评审意见——本文选择
> 明确承认这是**需要与 implementation-plan.md 对齐的一条有名有姓的解释**，不是可以悄悄绕过
> 的实现细节。已知 GitHub compare API 有文件数截断,第 1 稿只记成低风险待决事项,但这与手册
> "无法判定时 detect 必须失败"直接冲突——新增 **D22**，`detectPlatforms` 改为把自己已经全量
> 分页读到的 PR 变更文件列表直接传给 `computeImpact`（不再让它经 compare API 独立再读一遍），
> 顺带修掉 `gate-hygiene.ts` 现有 `fetchAllChangedFiles` 静默停在 1000 个文件的截断 bug（改
> 为超过硬上限即抛错），只有本地/预览模式仍经 compare API 或本地 git，按 D9 本就非权威判定。
> 另有两处非阻塞但需要补齐：四个 reusable workflow 缺工具链安装/版本锁定步骤（M3 的"命令
> 契约"从不等于 runner 已装好对应工具）——补进 **D23**；默认 `GITHUB_TOKEN` 能否在"required
> workflow + 嵌套 workflow_call"这层间接下 checkout 产品仓，第 1 稿只当作实现期待验证项，
> 评审认为这决定整个方案是否可行、应在批准前验证——**D24** 把它提升为实现前必须完成的隔离
> 环境验证,并要求设计对"验证失败、需要换 GitHub App token"这一结果保持可插拔、不推倒重来。
>
> **本版（第 3 稿）据 Codex 评审修正 4 处 P1 + 1 处 P2（均为第 2 稿修复本身的问题，符合
> sdd-review-rigor memo"修复本身要用同等严格程度审查"的既有规律）**：D18 的存在性检查只看
> head，会把"仍在 `projects.yaml` 声明中的 component 被整个删光"误判成"尚未 scaffold"，
> 两者在 head-only 检查下无法区分,前者会让平台 CI 被跳过并判 pass——新增 **D25**，改为
> 同时检查 base 与 head，只有"base/head 都不存在"才是良性场景,"base 存在、head 消失、
> 但仍被声明"必须让 `detect` 直接失败。D19 补上了 `previousPath` 数据，但分类时仍然只拿
> head 派生的 component 列表去匹配它,导致"改路径的同时更新了声明"这一常见场景下旧路径
> 依然找不到归属，等于没修——新增 **D26**，`previousPath` 改用 **base** `projects.yaml`
> 派生的 component 列表分类,`path` 与 `previousPath` 从此用两份不同的列表。D22 的"分页到
> 不满一页就算读完、否则报一个自设的 10000 硬上限"仍然不成立,因为 GitHub PR-files 端点
> 真实的硬上限（3000）比自设的上限更早触发，且不保证产生可辨识的"不满一页"信号——D22 改为
> 与 PR 自身的 `changed_files` 计数比对，这是一个独立于分页行为、可验证"是否读完"的信号。
> D24 此前把"若默认 token 不可行,只需要改一行 checkout 的 token"说得过于乐观——已收回，
> 如实列出需要的 `workflow_call` secrets 声明与传递、App token 铸造步骤、组织级凭据配置、
> fork PR 拿不到 secret 这一限制,并据此显式记录"本方案不支持 fork 发起的产品仓贡献"这条
> 此前没写明的假设。另修正一处 P2：上一轮编辑在插入 D18 时误删了 D5 的标题文字，导致 D18
> 内容与 D5 正文直接拼接；D6 也一直保留着被 D20 取代的"ID 集合对称差"这句话,与 D20 正面
> 矛盾却从未回头修正——两处均已修复，D6 现在只陈述架构性原则并指向 D20 作为唯一权威定义。
> D21 的"M4 阶段 spec 实质变化保守运行全部 existing 平台"解释已被接受，并已同步写入
> `implementation-plan.md`（M4 小节）与 runbook（§9 路径表之后），不再只停留在本文档里。

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
  "受影响 component 路径"是一个**列表**，不是一个值——这个列表具体如何计算、与 D18 的
  `existing[platform]` 是同一次读取,见 §1.2/§2.3。
- **D4 — `existing[platform]` 是最后一步无条件 AND，路径规则 / impact / PR 标签都不能
  绕过**（本条与 D18 合并阅读；第 1 稿这里写的是 `declared[platform]`，评审指出它与
  `*_paths` 的关系没有真正定义，已改写为下面的 `existing[platform]`）：`declared
  [platform]`（`projects.yaml(head)` 中存在 ≥1 个 `ci == platform` 的 component）只回答
  "这个产品有没有声明这个平台"，不回答"这个平台的目录现在是不是真的存在"——Architecture
  Gate 批准一个新平台、Scaffold PR 尚未落地这段窗口期里,`declared=true` 但目录不存在，
  若仅用 `declared` 做最终 AND，`design/**` 之类的静态规则会把这个还没有任何代码的平台判
  `true`，下游 job checkout 到一个不存在的目录、构建失败,把整条 `CI Gate` 拖红。**修复
  （D18）**：最终 AND 门改用 `existing[platform] = declared[platform] 且该平台至少一个
  component 的 path 在 head tree 里确有内容`，精确顺序（§2.6）：`final[platform] =
  (pathRule[platform] OR impact[platform] OR labelForce[platform]) AND
  existing[platform]`——`existing` 是最后一步，对三个信号源的并集统一生效，不在每个信号源
  内部各自重复判断。
- **D18 — `existing[platform]` 与 `*_paths` 用同一次存在性检查计算，两者不可能分道扬镳
  （修复第 1 稿的自相矛盾）**：第 1 稿一边说"`*_paths` 来自 `projects.yaml` 的
  `{path,ci}` 列表"（隐含 `*_paths` 只要 declared 就非空），一边在 §2.4 断言"新批准平台
  但未 scaffold 时 `ios_paths` 是空数组"——这两句话不可能同时为真，因为算法里从来没有一步
  去检查"这个 `path` 现在是否真的存在"。**修复**：`detect` 读到 `projects.yaml(head)` 的
  `{path, ci}` 列表后，对**每个 component**（不止 pending/changed 的那些，因为存在性检查
  与"这次 PR 改没改这个平台"无关）做一次存在性判定，与 M3 D25"component 子树完整性校验"
  同源的读取方式：一次性拉取 head SHA 的完整 tree（`GET /git/trees/{head_sha}?recursive=1`），
  对每个 component 检查该 tree 里是否存在任意路径等于或以 `path + '/'` 为前缀的条目；tree
  过大触发 `truncated: true` 时，改为对每个 component 逐个调用 Contents API
  （`GET /contents/{path}?ref=head_sha`，200=存在、404=不存在，其余状态码 fail closed）
  ——component 数量有限（大致与平台数同量级），逐个调用的成本可接受。**`*_paths[platform]`
  精确定义为"该平台全部 declared component 里，这次存在性检查判定为存在的那些 `path`"**；
  `existing[platform] = *_paths[platform].length > 0`——两者由构造保证一致，不是分别断言、
  可能不同步的两个事实。这也让 §2.4"新批准 ios 但未 scaffold"那条说明从"断言"变成"由算法
  必然得出的结论"：`ios` 存在性检查为假 → `existing.ios=false` → `ios_paths=[]` →
  `final.ios` 恒为 `false`（不再依赖"空 matrix 恰好是良性的"这个次要论证,§1.2 的空
  matrix 说明改为"不会被触发到"的兜底注释,不再是主要的正确性依据，见 §2.3）。
- **D5 — 保守性原则（贯穿 §2.5 全部规则的统一表述，只写一次，后文引用）**：**当 M4 阶段
  掌握的信息不足以把一次 spec/design/architecture 变更精确归因到具体平台时（没有 M5 才建立
  的 task 级关联图），一律把该变更归为"影响该变更所在 track 语义范围内的全部
  `declared` 平台"，绝不缩小到"看起来更合理"的子集**。允许的例外只有一种：变更范围经过
  **规范化文本比较后确认为零内容差异**（如纯 whitespace、行尾差异）。这条原则直接决定了
  §2.5 每条规则"该不该、能不能进一步收窄"的判断，包括为什么最终放弃了"按 REQ-ID 分块
  narrow"的更精细方案（见本文档首行的自查记录）。
- **D6 — `changed.requirements` / `.screens` / `.operations`（报表字段）与"该平台是否受
  影响"（gating 字段）分开计算，互不依赖**（本条只陈述这一架构性原则；具体算法在 D20，
  **此处不复述、也不与 D20 冲突**——第 2 稿曾在这里遗留一句"前者是 ID 集合的对称差"，
  与后来 D20 改用的按 ID 分块 diff 正面矛盾，属于修订时的疏漏，已删除，D20 是唯一权威
  定义）：报表字段回答"哪些 ID 变了"，可以也应该精确回答；平台布尔回答"因此该测哪个
  平台"，在没有 M5 task 图时做不到精确、只能保守（§2.5）。两者用不同算法是因为它们是
  两个不同的问题，不是同一个问题的两种精度。
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
  标签 + 应用 D4/D18 的 existing-AND，业务逻辑落在 `@sdd/factory` 的 `detectPlatforms`）。这精确
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
- **D19 — `ChangedPath` 必须携带 rename 的原路径，两个 reader 后端都要提供**（修复第 1 稿
  遗漏、只在 D9 里含糊提了一句"文件重命名判定"是边界情况，但从未真正设计）：`status:
  'renamed'` 的条目如果只有新路径、没有旧路径，会导致两个具体错误——(a) 内容完全不变的
  rename（如 `specs/v1/spec.md` 因整理目录被移动到别处但字节不变）：§2.5 的整篇文档 diff
  会读 `readFileAt(base, headPath)`，而 `headPath` 在 base 侧根本不存在，被误判为"新增
  文件"→"有实质变化"→ 触发全部平台，即使内容一字未改；(b) 整个 component 目录搬迁：只看
  新路径会漏掉"旧路径所属平台也发生了变化（该目录下东西消失了）"这一半信息。**修复**：
  `ChangedPath` 增加 `previousPath?: string`（仅 `status === 'renamed'` 时出现）；
  `createApiImpactReader` 从 GitHub API 响应的 `previous_filename` 字段读取（compare API
  与 PR-files API 的 `files[]` 条目对 rename 均提供此字段）；`createLocalGitImpactReader`
  用 `git diff --name-status -M <base> <head>` 解析 `R<score>\t<old>\t<new>` 格式的输出行。
  两处消费方相应更新：(a) §2.5 的整篇文档 diff，对带 `previousPath` 的条目用
  `readFileAt(base, previousPath)` 而非 `readFileAt(base, path)` 作为 base 侧比较对象；
  (b) §2.3 的路径分类（`mapPath`），对带 `previousPath` 的条目同时对 `path` 与
  `previousPath` 各做一次分类，命中的平台都并入信号（两者不同时才有意义，相同则是一次
  匹配）。
- **D20 — `changed.requirements`/`.screens`/`.operations`（报表字段）改回按 ID 分块 diff，
  与 §2.5 的平台布尔判定使用不同算法（修复第 1 稿对 D6 的错误设计）**：第 1 稿把这三个
  报表字段定义成纯 ID 集合对称差（只报告新增/删除的 ID），理由是"避免重蹈按 REQ-ID 分块
  在平台布尔判定上会漏判的覆辙"——评审指出这个理由被错误地应用到了报表字段上：`REQ-AUTH-001`
  整段验收标准被重写、ID 本身未变，一个名叫"变更 requirement"的字段报告"没有变化"，这不是
  保守，是**语义错误**——读者（人工审查 Gate PR，或未来 M5）合理预期这个字段回答"哪些
  requirement 被实质性改动了"，而不是"哪些 ID 是这次新打的标签"。第 1 稿放弃按 ID 分块的
  真正原因是它不能安全地驱动**平台布尔判定**（漏判不挂在任何 ID 下的段落，如 In/Out
  scope），这个顾虑对"仅仅报告某个 ID 内容是否变了"这个更窄的问题不成立——报告"REQ-AUTH-001
  变了"从来不需要覆盖"没有 REQ-ID 的段落变没变"这个问题。**修复**：新增共享算法
  `diffAnchoredBlocks(baseText, headText, anchorRegex): { added: Set<string>;
  removed: Set<string>; changed: Set<string> }`（按锚点 ID 的出现位置切出"从该 ID
  出现处到下一个锚点或文档末尾"的文本块，规范化后逐 ID 比较）：某 ID 只在 head 出现→
  `added`；只在 base 出现→ `removed`；两侧都出现但块文本不同→ `changed`；两侧都出现
  且块文本相同则三个集合都不含它。`changed.requirements`/`.screens`/`.operations`
  报表字段取三个集合的并集（`added ∪ removed ∪ changed`），分别用
  `REQ_ID_RE`/`SCR_ID_RE`/operationId 行正则调用同一个函数（§4.5）；`breaking`
  （D7）单独只取 `removed` 这一个子集,不是三者的并集，见下方。
  §2.5 的平台布尔判定**不受影响，继续用整篇文档规范化 diff**——两个字段现在故意用不同算法，
  是因为它们的正确定义本来就不同："哪些 ID 变了"是能够、也应该精确回答的问题；"因此该测
  哪个平台"在没有 task 图时做不到精确，只能保守。旧的"两套算法分开计算"表述（原 D6）改为
  "两套算法分开计算、且分别选用对各自问题正确的算法"。
- **D21 — `specs/<version>/**` 是统一 bucket，不是四个枚举文件名 + 兜底两级；`spec.md`
  "实质变化即触发全部平台"是需要与 implementation-plan.md 对齐的一条有名有姓的解释，不是
  可以悄悄绕过的实现细节**（修复第 1 稿 §2.4 路径表的两个问题）：第 1 稿的路径表只枚举了
  `architecture.md`/`design.md`/`spec.md` 三个文件名，`specs/<version>/plan.md`（四个
  Gate 产物之一，手册 §6.6/M2 模板明确存在）和"该目录下其它未枚举但合法的文件"都会落进
  表格最后一行的**通用兜底**（"全部 declared 平台，不调用 impact"）——这与手册 §9 本身把
  `specs/**` 描述成一个**路径前缀规则**、而不是"四个精确文件名各自处理、其余归入完全不同
  的无 impact 兜底"矛盾，也意味着 `plan.md` 变化时 `changed.*` 报表字段永远拿不到内容
  （因为从未调用 impact）。**修复**：把 `specs/<version>/**` 当一个统一 bucket 处理——
  bucket 内按已知文件名（`architecture.md`/`design.md`/`plan.md`/`spec.md`）分流到 §2.4/
  §2.5 各自的规则；bucket 内任何**其它**文件（未来可能出现的补充文档等）默认视同
  `architecture.md`（保守、全部 `existing` 平台），但仍然 `needs_impact=true`（用于
  `changed.*` 报表尽力提取该文件里可能存在的 ID，提取不到就是空集合，不算错误）——不会再
  落到 `.github/**` 那种"完全不了解、彻底兜底"的桶。**同时正面回应评审第二点**：`spec.md`
  只要规范化后有实质变化就触发全部 `existing` 平台，实践中确实约等于"多数 spec-only PR
  会跑全部平台"，这与手册 §9"不默认运行所有重型 CI"的字面愿望存在真实张力——本文不假装
  这个张力不存在，也不在这里发明一个看起来更精细、实际会漏判的算法（那正是本文档开头已经
  推翻过一次的错误方向）。**本文的立场**：这是 M4 阶段（没有 M5 task 图）唯一诚实、不漏判
  的选择，请求把这一条作为**独立于本文档批准之外的、需要 implementation-plan.md 或 runbook
  层面正式确认的解释**对待——即"§9'不默认全跑'这句话在 M4 阶段的可执行含义是'只有零内容
  差异才不跑，任何实质编辑都保守全跑，精确收窄留给 M5 task 图'"，而不是本文单方面悄悄改写
  上层文档的验收语义。若评审不接受这个解释，M4 需要的是重新讨论范围（比如把"specs-only
  精确影响分析"整体挪到 M5 之后），而不是在本里程碑内再造一个不安全的收窄算法。
- **D22 — `detect` 必须对 GitHub API 的文件数截断 fail closed，且必须用一个能真正证明
  "读完了"的信号，不能只靠"分页到不满一页就算完"（修复第 1 稿对已知风险的处理方式，且
  第 2 稿的修复本身仍不够——评审第 2 点）**：第 1 稿已经知道 compare API 与 PR-files API
  都有各自的文件数上限，却只在 §4.2/§11 记成"评估为低风险的待决事项"，与手册"`sdd
  impact` 执行失败、输出非法或无法判定时，`detect` 必须失败"直接冲突。第 2 稿的修复
  （"持续分页直到不满一页，触及一个如 10000 的硬上限才报错"）**仍然不成立**：PR-files
  端点本身有一个官方文档记录的硬上限（截至评审时是 3000 个文件），超过这个数字后 GitHub
  不会返回错误、也不保证返回"不满一页"这种可辨识的信号来提示"还有更多但拿不到了"——继续
  分页可能就是直接停止返回新内容,而这在我们的分页循环看来和"确实读完了"没有可靠区别。
  换句话说,第 2 稿自己设的 10000 上限从未起作用，因为真正的截断发生在 GitHub 的 3000
  这一步，比自设的安全阀更早，第 2 稿的"抛错"分支实际上永远不会被触发,问题原样保留。
  **修复**：改用一个可以独立验证"是否读完"的信号，而不是从分页行为本身猜测——PR 资源
  本身（`GET /pulls/{pr}`，`detect` 已经在步骤 1 读取过）带有 `changed_files` 字段，是
  该 PR 变更文件总数的权威计数，与"按页读取"这条路径完全独立。`fetchChangedFiles` 分页
  读完后，**要求实际读到的文件条目数等于 `pr.changed_files`**；不相等（无论是因为撞上
  GitHub 的硬上限、网络在中途出错、还是任何其它原因）→ 抛错，不返回部分结果。这个
  校验不关心截断具体发生在哪个阈值、以什么形式表现——只要计数对不上就是"无法证明读完
  了"，直接 fail closed，天然覆盖 3000 这个具体数字，也不依赖它今后是否变化。旧版
  "10000 硬上限"仍保留作为纯防御性的分页次数上限（防止 `changed_files` 本身异常导致
  死循环），但不再是判断"是否读完"的依据。§6 的对应测试需要真实模拟"计数与实际抓取
  不一致"这个场景，不能像第 2 稿那样只测自设的硬上限（评审明确指出第 2 稿的测试没有
  覆盖 GitHub 真实的 3000 上限，只测了自己发明的数字）。
  (2) **`computeImpact` 不再独立通过 compare API 重新读一遍变更文件列表**——`detectPlatforms`
  已经用 (1) 的、修好的全量分页方法读到了一份可信的变更路径列表，直接把它作为**已知输入**
  传给 `computeImpact`（新增可选入参 `changedPaths?`，见 §4.3），只有在没有这份预取列表时
  （即独立、无 PR 上下文的 `sdd impact --base --head` 本地/API 调用）`computeImpact` 才
  退回到自己经 reader 读取（compare API 或本地 `git diff`）。这样 CI 里唯一真正影响
  `CI Gate` 判定的路径（`detect` → `computeImpact`）全程只有一次、已验证完整的文件列表，
  不再存在"`detect` 与 `computeImpact` 各自独立读、可能corner-case 不一致"的风险（§11 原
  待决事项 #2 因此解决大半，剩余的只是"独立本地预览模式"这个本就非权威的路径，见 §11）。
- **D23 — 四个 reusable workflow 需要显式的工具链安装/版本锁定步骤，"M3 命令契约"不等于
  "runner 已装好对应工具"（非阻塞但需要在实现前补齐，评审第 6 点）**：M3 §1 承诺的四条
  命令（如 `./gradlew build`、`tuist build`）假设执行环境已经有正确版本的 JDK/Node/Tuist/
  SwiftLint/Xcode/Android SDK——这是 M3 自己本地验证时的前提，不是 GitHub-hosted runner
  的默认状态。§1.2/§1.3 需要为每个 reusable workflow 补上：`java.yml`/`android.yml` 用
  `actions/setup-java@v4`（`java-version: '21'`，与 M3 §0 D1 锁定的 Java 21 LTS 一致；
  Gradle 本身经 wrapper 自解析,不需要单独 setup，但 wrapper 联网下载在 CI 里应配合
  `actions/cache` 或等效缓存，避免每次运行都重新下载）；`android.yml` 额外需要确认 Android
  SDK platform/build-tools 版本（GitHub-hosted `ubuntu-latest` runner 预装 Android SDK，
  但预装的具体版本不一定覆盖 M3 锁定的 `compileSdk 35`/AGP 8.5.2，需要显式
  `sdkmanager` 步骤或等效方式补齐，实现时核实）；`web.yml` 用 `actions/setup-node@v4`
  （`node-version: '24'`）+ 显式 `corepack enable`（`packageManager` 字段要求的 pnpm
  版本经 corepack 分发，不能假设它已经在 PATH 上）；`ios.yml` 需要选定与 M3
  `.xcode-version` 一致的 Xcode（macOS runner 预装多个版本，需 `xcode-select`/等效步骤
  切换）、安装 Tuist（与 M3 §11 待决事项 #1"Tuist 版本钉死机制"是同一个待确认项，实现时
  按当时 Tuist 官方安装方式确定）、安装 SwiftLint（`brew install swiftlint` 或 SPM
  plugin）。这些步骤的具体版本号/安装命令留给实现时按 M3 模板最终锁定的版本核实（不是
  M4 自己的新决策——M4 只需要"确保 runner 环境与 M3 锁定版本一致"这个要求，落到 §1 的
  workflow YAML 里）。
- **D24 — 默认 `GITHUB_TOKEN` 能否 checkout 产品仓,提升为实现前必须验证的前置事项；
  若验证失败,应对方案是一次独立的、需要在验证结果出来后才动手设计的多部分改动，不是
  "改一行 token"（第 2 稿在这里的"爆炸半径限定在一行"的说法被评审指出过于乐观，已收回，
  评审第 4 点）**：第 1 稿把这个假设记成"实现时验证"的待决事项，评审指出这个假设决定
  D1/D2 的整个可行性——如果默认 `GITHUB_TOKEN`（在"required workflow +
  `workflow_call` 嵌套一层"这个具体场景下）不能 `actions/checkout` 一个显式指定的、
  不同于当前 workflow 文件来源仓库的产品仓，需要换成 GitHub App installation token。
  **要求（不变）**：这项验证必须在 M4 代码实现**开始前**、用隔离测试 org 完成（复用
  M2/M3 已经建立的隔离 org E2E 习惯，见 §11 #1 的具体步骤），不是写完四个 workflow 之后
  才发现方案不可行。

  **若验证失败,诚实列出的改动范围（第 2 稿的错误在于假装这里只有一行改动）**：
  1. `ci-gate.yml` 自身需要新增一步（可能在 `detect` job 之后、四个平台 job 之前），
     用 App ID + 私钥（组织级 secret）换取短时效 installation token（如
     `actions/create-github-app-token` 或等效 action），而不是假设 token 从天而降。
  2. 四个 reusable workflow 各自的 `on.workflow_call` 需要新增
     `secrets:` 声明（GitHub Actions 的既有约束：`workflow_call` 不会自动继承调用方的
     secret，除非显式声明或调用处写 `secrets: inherit`），调用处（§1.1 的 `uses:` job）
     相应传递该 token。这是四个文件 + 一处调用点的联动改动，不是一行。
  3. App 的 ID/私钥需要作为**组织级** secret 存在（不能是单一产品仓的 repo secret，
     因为这个 token 要在所有产品仓的 CI 里复用），且需要配置对哪些仓库/workflow 可见——
     这是一次性的组织管理员操作，不是 Factory 代码能自动完成的（类比 M2 §2.7 已经讨论
     过的 Factory 生产身份权限问题，但这次是 CI 运行时的身份，不是 Factory 建仓时的身份，
     两者需要的是两把不同的钥匙）。
  4. **fork PR 的限制需要显式面对，不能略过**：GitHub Actions 默认不会把仓库/组织
     secret 暴露给来自 fork 的 PR 触发的 workflow 运行（这正是 D2 依赖的同一个安全
     机制）——如果 (1) 的 token 铸造步骤需要读取组织 secret，fork PR 触发的运行拿不到
     它，四个平台 job 在 fork PR 上会失败（无法 checkout）。**本文档在这里明确一条此前
     未写明的假设**：产品仓默认 `visibility: private`（M2 D2），贡献者是通过组织内分支
     参与，不是跨仓库 fork——这与 CODEOWNERS/team 权限模型（`backend-team`/`ios-team` 等
     组织内团队）本来就是同一套假设，本方案（包括默认 `GITHUB_TOKEN` 路径本身）不支持
     fork 发起的产品仓贡献。若某产品仓的可见性被设为 `public` 且确实需要接受 fork PR，
     这类 PR 的四个平台 job 在两种 token 方案下都无法 checkout/构建——这是一个需要人工
     决定"是否支持"的产品层面限制，不是 M4 能在代码里解决的问题。

  **结论**：验证通过（默认 token 可行）→ 以上 4 点都不需要，§1.2 的 checkout 步骤维持
  原样。验证失败 → 以上 4 点是一次独立的设计任务（有自己的组织配置、secret 传递、
  fork 限制需要处理），应该在验证结果出来后单独立项，不能假设它只是实现阶段顺手能填的
  一行空白。
- **D25 — `existing[platform]` 的存在性检查必须同时看 base 与 head，不能只看
  head（修复第 2 稿 D18 引入的 fail-open，评审第 1 点）**：D18 只检查 head tree 里
  `component.path` 是否有内容,用来区分"批准了但还没 scaffold"（benign）——但这个
  检查同时会把"这个 component 之前有代码、这次 PR 把它删光了"误判成同一种情况：
  - **单 component 平台**：该平台唯一 component 的目录被整个删除 → head 存在性检查
    为假 → `existing[platform]=false` → `final[platform]` 恒 `false` → 平台 job
    被跳过、判定为 `detected=false+skipped` → **CI Gate 通过**。删光一个平台的代码
    反而让它连 CI 都不用跑,这是明确的 fail-open。
  - **多 component 平台**：只删掉其中一个 component 的目录、其余 component 还在 →
    `existing[platform]` 仍为 `true`（其它 component 撑住），但 `*_paths` 里已经
    不含被删的那个 path → matrix 只测剩下的 component，被删的那个从头到尾没有任何
    信号——比单 component 场景更隐蔽，因为平台整体看起来"仍在正常运行"。

  两种场景的共同根因：D18 的检查只问"head 现在有没有"，没有问"这本来应不应该有、
  之前有没有"。**修复**：对**每个 head 声明的 component**，除了检查
  `existsAtHead(path)`，**额外检查 `existsAtBase(path)`**（对 base SHA 的 tree/
  Contents API 做同一种存在性检查，与 head 侧共用同一套读取机制，只是换一个 ref）,
  按三种组合分类：

  | existsAtBase | existsAtHead | 判定 |
  |---|---|---|
  | 否 | 否 | 从未存在——该 component 尚未 scaffold，`existing` 对它判 `false`，**不报错**（D18 原本设计要保留的 benign 场景） |
  | 否 | 是 | 新 scaffold 出来的——正常，计入 `*_paths` |
  | 是 | 是 | 一直都在——正常，计入 `*_paths` |
  | **是** | **否** | **异常：之前存在、现在消失，但 `projects.yaml` 仍然声明它** → `detect` **立即失败**（fail closed，退出码 3），不静默判 `existing=false` 然后放行 |

  最后一行是本条修复的核心：这种状态意味着"声明"和"实际内容"互相矛盾（还在
  `projects.yaml` 里、但代码没了），本文不去猜测这是误删、恶意行为还是遗漏更新
  `projects.yaml`——按 D5 的保守性原则，无法判定意图时必须失败，把决定权交还给
  人（要么恢复代码，要么在同一个 PR 里显式从 `projects.yaml` 移除该 component，
  那样它就不再出现在 head 声明列表里，根本不会走到这张表）。**这不与 M3 D3"scaffold
  不删除已生成目录"冲突**：D3 说的是 scaffold 工具自己不做删除，不代表任何人在
  任何 PR 里手动删除该目录都应该被静默接受——两者是不同的关注点（工具的职责边界 vs.
  detect 该如何应对一个客观发生的删除）。
- **D26 — 分类"改动路径属于哪个平台"时，`previousPath` 必须对 base 的
  component 列表分类，不能对 head 的列表分类（修复第 2 稿 D19 的不完整修复，
  评审第 3 点）**：第 2 稿加上了 `previousPath` 字段，但 `classify()` 仍然对
  `path` 和 `previousPath` 用**同一份**（head 派生的）component 列表做匹配——
  如果这次 PR 恰好也把某个 component 的 `path` 从旧值改成新值（并相应更新了
  `projects.yaml`），旧路径已经不在 head 的声明列表里了，`mapPath(previousPath,
  headComponents)` 找不到任何匹配,"这次改动也影响了旧路径所属的那个平台"这个
  信息照样丢失——第 2 稿只是把数据（`previousPath` 字符串本身）补上了，却没有
  把它接到正确的地方，实际效果和第 1 稿一样。**修复**：`detect` 额外读取**
  base SHA** 的 `projects.yaml`（与 D25 的 base 存在性检查是同一次"读 base"，
  但这里读的是内容、解析出的是 component 列表，不是判断某个路径是否存在，两者
  数据不同，服务于不同用途，见 §2.2/§2.3）；`classify()` 改为对 `path` 用 head
  component 列表分类、对 `previousPath` 用 **base** component 列表分类：

  ```ts
  function classify(
    entry: ChangedPath, headComponents: ComponentRef[], baseComponents: ComponentRef[],
  ): ComponentRef[] {
    const hits = [mapPath(entry.path, headComponents)];
    if (entry.previousPath) hits.push(mapPath(entry.previousPath, baseComponents));
    return hits.filter((c): c is ComponentRef => c !== undefined);
  }
  ```

  base 侧 `projects.yaml` 若无法解析/校验失败，按与 head 侧同等的 fail-closed
  处理（`detect` 失败，退出码 3）——这里只用于分类富化，但"读不到 base 状态"本身
  已经是"无法判定"的一种,不应该静默降级为"就当没有 previousPath 信息"。

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
**D24** 把"验证默认 `GITHUB_TOKEN` 能否 checkout `inputs.product_repo` 指向的仓库"这一
具体假设提升为**实现前必须在隔离测试环境验证**的前置事项，不是"待实现时再看"（
`pr-hygiene.yml` 已经证明该 token 能经 API **读**产品 PR，但没有证明它能 **checkout**
产品仓的 git 内容——读 API 和 checkout 走的是 GitHub 两套不同的权限判定路径，不能想当然
认为前者成立后者就一定成立）；验证失败时需要的改动不止 `with:` 里加一行 `token:`，
完整范围见 D24（token 铸造、`workflow_call` secrets 传递、组织级凭据、fork PR 限制）。

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
# java.yml（片段，D23 补齐工具链安装）
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
          # token: 省略 = 默认 GITHUB_TOKEN（D24：本行前提是隔离环境验证通过；
          #   若验证失败，这里换成的不只是一个 secret 名字，还需要 D24 列出的
          #   四项配套改动——token 铸造步骤、workflow_call secrets 声明与传递、
          #   组织级 App 凭据、fork PR 限制，见 §0 D24 的完整讨论）
      - name: setup java (D23)
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'   # 与 M3 §0 D1 锁定的 Java 21 LTS 一致
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

Gradle 本身经 wrapper 自解析（`gradle-wrapper.properties` 的 `distributionSha256Sum`
已经锁定版本），不需要单独一个 setup 步骤，但首次运行会联网下载 Gradle 发行包，建议配合
`actions/cache`（key 覆盖 `~/.gradle/wrapper`）避免每次 CI 都重新下载，非阻塞的性能优化，
不影响正确性。`web.yml` 对应改成 `actions/setup-node@v4`（`node-version: '24'`）+ 显式
`corepack enable` 步骤（`package.json` 的 `packageManager` 字段指定的 pnpm 版本经
corepack 分发，不能假设 runner 默认 PATH 上已有 pnpm）；`android.yml` 同样需要
`actions/setup-java@v4`（Android/Gradle 构建同样需要 JDK）,并在实现时核实
GitHub-hosted `ubuntu-latest` runner 预装的 Android SDK platform/build-tools 版本是否
覆盖 M3 锁定的 `compileSdk 35`/AGP 8.5.2，不覆盖则需要显式 `sdkmanager` 步骤补齐（D23）。

`paths` 为空数组时，`strategy.matrix` 产生零个 matrix 实例，`build` job 自然不运行任何
实例（GitHub Actions 标准行为）。**这只是一层防御性兜底，不是正确性的主要依据**（D18 已
把 `paths` 的定义直接绑定到"该平台是否存在"的检查，`existing[platform]=false` 时
`paths` 恒为 `[]` 且外层 `if: needs.detect.outputs.backend == 'true'` 恒不满足，job
根本不会被调度到——"空 matrix 恰好安全"这件事现在是由构造保证的，不再是一个需要单独
祈祷成立的假设）。

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
# ios.yml（片段，D23 补齐工具链安装）
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
        with:
          repository: ${{ inputs.product_repo }}
          ref: ${{ inputs.head_sha }}
          # token: 省略 = 默认 GITHUB_TOKEN（D24，见 java.yml 片段的同一条注释）
      - name: select xcode (D23)
        run: sudo xcode-select -s /Applications/Xcode_16.x.app   # 具体版本对齐
                                                                  # M3 `.xcode-version`
      - name: install tuist (D23)
        run: curl -Ls https://install.tuist.io | bash   # 具体安装方式待实现时按 Tuist
                                                          # 官方当时的推荐方式核实，
                                                          # 与 M3 §11 待决事项 #1 同一项
      - name: install swiftlint (D23)
        run: brew install swiftlint
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
   fetchPullRequest 共享 helper。同一次响应也带出 changed_files 计数，供步骤 4 的
   完整性校验使用（D22）。
2. 读 PR head SHA 的 projects.yaml，用 @sdd/schemas 的 validateProjectsDocument 校验；
   不合法 → detect 立即失败（fail closed，退出码 3，见 §2.9），不进入后续任何步骤——
   一个不合法的 projects.yaml 意味着"这个产品当前声明了哪些平台"这件事本身无法确定，
   任何下游判断都建立在流沙上。**同时读 base SHA 的 projects.yaml 并同等校验**（D26）
   ——用于 previousPath 分类（步骤 5），base 侧解析失败同样 fail closed，不降级为
   "当没有 previousPath 信息"。
3. 由 head projects.yaml 构造 declared[platform] 集合与 headComponents（{path, ci}
   列表）；对**每个** component（不限于这次变更涉及的）做 D25 的 base+head 双重
   存在性检查，得到 existing[platform] 与 *_paths[platform]（§2.3）——检测到"base
   存在、head 消失，但该 component 仍在 head 声明中"这一异常组合时，detect 立即
   失败（fail closed，退出码 3，D25），不进入后续任何步骤。
4. 读 PR 变更文件路径列表，**全量分页**（GET /pulls/{pr}/files，复用 §4.5 的
   fetchChangedFiles）；分页读完后与步骤 1 的 changed_files 计数比对，不一致 →
   抛错（D22 第 3 稿，覆盖 GitHub PR-files 端点自身的硬上限，不依赖分页行为本身
   能否辨识截断）。对 status='renamed' 的条目一并取得 previousPath（D19）。这份
   列表既用于本步骤自己的路径分类，也会在步骤 6 原样传给 computeImpact，全程只有
   一份、已验证完整的变更路径来源（D22）。
5. 对每条变更路径分类（§2.4 的表；status='renamed' 的条目对 path 用 headComponents
   分类、对 previousPath 用步骤 2 读到的 baseComponents 分类，D19/D26——两者不是
   同一份列表），累积出一个"路径规则贡献的平台信号"+ 一个 needs_impact 布尔
   （specs/**、design/**、contracts/** 任一命中即为 true）。
6. needs_impact 为 true → 调用 computeImpact（同进程函数调用,不是子进程/不是重新调用
   sdd impact CLI），并把步骤 4 已经读到的变更路径列表作为 changedPaths 参数直接传入
   （D22，computeImpact 不再自己经 compare API 独立读一遍）：
     - 失败或输出未通过 impact.schema.json 校验 → detect 立即失败（fail closed，
       退出码 3）——这是用户起始需求里明确要求的一条：sdd impact 失败绝不能被悄悄吞掉
       变成"detect 判成什么都不需要跑"。
     - 成功 → 把 impact.platforms.{backend,web,ios,android} 并入累积信号。
7. 并入 PR 标签：每个 platform:<x> 标签只能把对应位从 false 强制为 true（§2.6）。
8. 最终 AND existing[platform]（D4/D18/D25），得到 4 个最终布尔。
9. 计算 contract_changed（§2.7，与上述判定完全独立的一条窄口径规则）。
10. 打印 JSON 到 stdout（含四个布尔、四个 *_paths、contract_changed、product_repo/
    head_sha），退出码 0。
```

### 2.3 路径 → 平台映射与存在性检查（D3/D18/D19/D25/D26 的算法）

```ts
interface ComponentRef { path: string; ci: 'java' | 'web' | 'ios' | 'android' }

function mapPath(changedPath: string, components: ComponentRef[]): ComponentRef | undefined {
  return components.find(
    (c) => changedPath === c.path || changedPath.startsWith(`${c.path}/`),
  );
}

// 对一条 ChangedPath 条目分类：path 对 head 声明的 component 分类，
// previousPath（若有）对 base 声明的 component 分类（D26——两者不能共用同一份
// 列表，否则"改路径的同时也改了 projects.yaml"这种改动会让旧路径在 head 列表
// 里根本找不到，源平台信息丢失）。返回集合而非单个值，因为两者可能匹配到不同
// component。
function classify(
  entry: ChangedPath, headComponents: ComponentRef[], baseComponents: ComponentRef[],
): ComponentRef[] {
  const hits = [mapPath(entry.path, headComponents)];
  if (entry.previousPath) hits.push(mapPath(entry.previousPath, baseComponents));
  return hits.filter((c): c is ComponentRef => c !== undefined);
}

// D25：对每个 head 声明的 component，同时检查 base 和 head 两个 ref 上该 path
// 是否存在（读取机制与 M3 D25"component 子树完整性校验"同源：优先一次性读
// recursive tree，truncated 时逐 component 调用 Contents API）。
type Existence = { existsAtBase: boolean; existsAtHead: boolean };
async function checkExisting(
  components: ComponentRef[], reader: TreeReader, baseSha: string, headSha: string,
): Promise<Map<string, Existence>> { /* ... */ }

// 消费 checkExisting 的结果：
//   existsAtBase=false, existsAtHead=false → 尚未 scaffold，existing 判 false，不报错
//   existsAtHead=true（无论 base 如何）    → 计入 *_paths
//   existsAtBase=true, existsAtHead=false  → 异常，detect 必须 fail closed（D25）
```

`ci` 枚举值到 `detect` 输出字段名的映射是固定的：`java→backend`、`web→web`、
`ios→ios`、`android→android`（沿用 `projects.schema.json` 里 `ci` 字段本身就是这四个
值、`detect` 输出字段名沿用手册 §9/M2 stub 已经使用的 `backend/web/ios/android` 四个
名字——两者不是同一个词表，`ci: java` 映射到输出字段 `backend`，这一处易错的换名点在
`schemas/projects.schema.json` 与 `implementation-plan.md`/`single-repo-implementation-
runbook.md` 里本来就是一致的既有约定，本文只是显式点出，不是新增规则）。

**`*_paths[platform]` 的精确定义（D18/D25）**：该平台全部 `declared` component
里，`checkExisting` 判定为 `existsAtHead=true` 的那些 `path`——不是"这次 PR 改动
涉及的路径"，也不是"declared 但未检查存在性的全量列表"。`existing[platform] =
*_paths[platform].length > 0`，两者由同一次检查构造，不会不同步（修复第 1 稿的
P1）；`existsAtBase=true 且 existsAtHead=false` 的 component 不会静默计入"不
existing"了事，而是让整个 `detect` 失败（D25），因为这种组合意味着声明与实际
内容互相矛盾,不是一个可以安全落到默认值的普通情况。

**未匹配到任何 component 的 `apps/**` 路径**（理论上不应出现——scaffold 只在获批 component
的 `path` 下生成内容，所以`apps/**` 下出现一个不对应任何**当前声明**的路径，只可能来自：
该 component 已经**整个从 `projects.yaml` 移除**（不只是内容被删，声明本身也没了——D25
只处理"仍在声明中但内容消失"这一种情况，不覆盖这里；M3 D3 明确"移除的 component 不删除
已生成目录，只产出 warning"，所以移除声明后目录留存、又被人工继续修改是可能发生的）；
或者是人工/攻击者在 `apps/**` 下新建的、从未经过 scaffold 的目录）→ 按 D5 保守性原则，
**归入全部 `existing` 平台**，不归入"该路径看起来最像哪个平台"这类猜测,也不单独判
`detect` 失败（这不是一个明确的错误状态,只是一个信息不足的状态,处理方式与其他"信息
不足"场景一致，统一用 D5 兜底,不为它单开一条失败路径）。

### 2.4 路径分类规则表（扩展手册 §9，标注是否需要调用 impact）

| 变更路径 | 平台信号 | 是否需要 `sdd impact` |
|---|---|---|
| `apps/**`，能匹配到某 component | 该 component 的 `ci` 对应平台 | 否 |
| `apps/**`，未匹配任何 component | 全部 `existing` 平台（D5 兜底，§2.3） | 否 |
| `contracts/openapi.yaml` 或 `contracts/events.yaml`（`contracts/**`） | 全部 `existing` 平台（静态规则，不依赖 impact 结果） | 是（用于 `changed.operations`/`breaking`/审计，见 §2.5；`contract_changed` 单独按 D8 窄口径计算，见 §2.7） |
| `design/tokens/**` | `existing` 中的 web/ios/android（不含 backend） | 是（用于 `changed.screens`；平台布尔仍是静态规则） |
| `specs/<version>/**`（统一 bucket，D21） | 见下方"`specs/<version>/**` 内部分流" | 是（bucket 内任何文件都触发 impact，不再有不调用 impact 的兜底出口） |
| `.github/**`、根级 `projects.yaml`、或任何未落入以上任何一类的路径 | 全部 `existing` 平台（D5 兜底——`projects.yaml` 本身变化也走这一行，见下方说明；产品仓模板按 M2/M3 设计不含任何 workflow 文件，`.github/**` 出现变化即为反常状态，不额外发明"workflow validation" 类新 job，直接保守处理即可，不构成 M4 范围扩张） | `projects.yaml` 是（用于确认 `existing` 集合自身是否变化，见下方说明）；`.github/**`/其余未知路径 否 |

**`specs/<version>/**` 内部分流（D21，修复第 1 稿只枚举 3 个文件名、遗漏 `plan.md` 与
"其它合法文件"两类的问题）**：

| bucket 内文件 | 平台信号 | 备注 |
|---|---|---|
| `architecture.md` | 全部 `existing` 平台（保守，D5） | 用于 `changed.requirements`/`changed.operations` 审计 |
| `plan.md` | 全部 `existing` 平台（保守，D5，与 architecture.md 同等对待） | 用于 `changed.requirements` 审计；第 1 稿完全遗漏这个文件，落进了不调用 impact 的通用兜底，已修复 |
| `design.md` | `existing` 中的 web/ios/android（不含 backend，`track:design` 语义，与 `design/tokens/**` 同等对待，见 §2.5） | 用于 `changed.screens` |
| `spec.md`（且 bucket 内同一 PR 未出现 architecture.md/plan.md 变化） | 由 impact 的整篇文档 diff 结果决定：有实质内容变化 → 全部 `existing` 平台；规范化后无变化 → 均不选中（D21：这一条与手册 §9"不默认全跑"的字面愿望存在真实张力，见 §2.5 与 D21 的完整讨论，本文明确要求这是一条需要独立确认的解释，不是可以悄悄绕过的实现细节） | 用于 `changed.requirements` 审计 |
| bucket 内其它文件（未来可能出现的补充文档等） | 全部 `existing` 平台（保守，视同 architecture.md 处理，不落入 `.github/**` 那种彻底不了解的兜底） | 尽力提取 ID 供审计，提取不到是空集合，不算错误 |

**`projects.yaml` 变化与 `existing` 集合自身变化的说明**：`detect` 每次运行都用**当前
这次判定的 PR head SHA** 读 `projects.yaml` 并对每个 component 做一次 D18 的存在性
检查（§2.2 步骤 2/3），所以即使这次 PR 本身就是一次 Architecture Gate（改了
`projects.yaml`，新增/移除了某个平台），`existing` 集合已经自动反映了"这次变更之后"的
拓扑,不需要额外区分"变更前/变更后"两套集合——**自查（已用 D18 修复第 1 稿在这里的
问题）**：若这次 PR **新增**了一个此前不存在的平台（如首次引入 `ios`），此时
`apps/ios/**` 目录还不存在（Scaffold PR 是另一个、通常在后的独立 PR，M3 D5"Scaffold
只开 PR，不直推 main"），单纯的 Architecture Gate PR 不会有任何 `apps/**` 路径变化，
只会摸到 `projects.yaml`（走上表倒数第二行）——`checkExisting` 对这个刚声明的 `ios`
component 做存在性检查会得到"不存在"（head tree 里没有 `apps/ios/**` 任何内容），
因此 `existing.ios=false`、`ios_paths=[]`，**`final.ios` 从一开始就恒为 `false`，
不会先被路径规则判 `true` 再指望空 matrix 兜底**——这是 D18 修复后由算法直接得出的
结论，不再是"表面上判 true、但恰好因为空 matrix 而安全"这种脆弱的巧合论证（对照第 1
稿在这里的原始表述）。这个结果依然是良性的——手册 §12.3 关心的是"Scaffold PR 落地后
CI Gate 仍然绿"，而不是"Architecture Gate PR 自己必须真的跑一次刚批准但还不存在的
平台的构建"，这里不需要额外特殊处理。

### 2.5 核心难题：没有 task 图时如何把变更映射到平台

M4 阶段 `sdd impact` 唯一能看到的输入是：两个 ref 各自的 `specs/**`/`design/**`/
`contracts/**`/`projects.yaml` 文本内容,以及从中能提取的 ID（`REQ-*`/`SCR-*`/
`operationId`）。它**看不到**"哪个 task 实现了哪个 REQ、影响哪个平台"这张图——那是 M5
`sdd backlog compile` 才建立、依赖稳定 task ID 与 Issue marker 的东西。以下逐类说明
M4 阶段"能诚实地做到多精确"，以及为什么不能再精确。

**`contracts/**` 变化**：手册 §9 静态表已经给出"全部四平台"——这是唯一不需要 impact
帮忙判断布尔值的一类（任何客户端平台理论上都可能调用任何 operation，M4 没有"哪个平台
调用哪个 operation"的映射，全平台是唯一诚实的答案）。impact 仍然要跑，但只是为了算
`changed.operations`（按 D20 的 ID 分块 diff,见本节末尾"审计字段"小节）与 `breaking`
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

**`specs/<version>/architecture.md`、`plan.md` 或根级 `projects.yaml` 变化**：架构/
计划文档描述组件边界、依赖方向、数据/安全/性能策略、跨平台依赖——这些内容结构上可能牵涉
任何一个已声明的 component，M4 没有可靠的子结构可以用来判断"这次改动只涉及某个特定
平台"。保守处理为全部 `existing` 平台（D21：`plan.md` 与 `architecture.md` 同等对待，
第 1 稿遗漏了 `plan.md`，见 §2.4）。

**`specs/<version>/spec.md` 变化（且 bucket 内同一 PR 未同时改 architecture.md/
plan.md）**——本节是全文最难的判断，也是本文档起草时唯一被自查推翻重写过一次的部分：

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
的规范化文本**完全相同** → 判定"无实质变化"；**存在任何差异** → 判定"有实质变化"，
归为全部 `existing` 平台（D5）。**base 侧比较对象的选取遵循 D19**：若该文件在变更
列表里的条目带 `previousPath`（即这是一次 rename），base 侧读的是
`readFileAt(base, previousPath)`,不是 `readFileAt(base, path)`——否则一次内容字节
完全不变的纯 rename（`path` 在 base 侧读不到）会被误判成"新增文件"从而"有实质变化"，
这正是评审指出的第 1 稿具体 bug（第 1 稿声称 rename 会被正确处理成"无实质变化"，但
`ChangedPath` 当时根本没有 `previousPath` 字段，这个声称没有对应的算法支撑）。修好
`previousPath` 之后，"文件被 rename 但内容字节不变"才真正是"无实质变化"的一个具体
例子，而不是一句自我安慰的描述。

这确实牺牲了"能不能只触发受影响的那一两个平台"这个更理想的目标,但这个目标在没有 task
图的 M4 阶段本来就无法诚实地达成——**保留"至少不会漏判"这个更基本的正确性属性，优先于
"看起来更精确但可能漏判"**。**必须正面承认的张力（D21，请评审据此单独确认）**：手册
§9"不默认运行所有重型 CI"这句话，若理解为"多数触及 spec.md 实质内容的 PR 都不应该
跑全部平台"，本方案并不满足——本方案只做到"零内容差异的 PR 不跑"，任何真实的内容编辑
都会保守地跑全部 `existing` 平台，这在实践中覆盖了绝大多数 spec-only PR。本文档不在
这里假装这个张力不存在，也拒绝为了看起来满足这句话而重新引入上面已经证明会漏判的按
ID 分块方案。这条解释是否可以接受，是一个**需要独立确认、并建议同步体现在
implementation-plan.md 或 runbook 里**的决定，而不是本文档可以单方面替上层文档下的
结论——详见 D21。

**`changed.requirements`/`.screens`/`.operations`（报表字段）的独立算法（D20，修复
第 1 稿把 D6 定义成纯 ID 集合对称差的问题）**：与上述"是否触发平台"完全独立计算，但
**不再是**纯 ID 集合对称差——第 1 稿那样定义会让"REQ-AUTH-001 的验收标准被整段重写、
ID 本身未变"这种改动完全不出现在一个名叫"变更 requirement"的字段里，这是对字段自身
承诺的语义的误读，不是安全边际。改用**按 ID 分块 diff**（共享函数
`diffAnchoredBlocks(baseText, headText, anchorRegex): { added, removed, changed:
Set<string> }`，§4.5）：以每个 ID 出现的位置为锚点，切出"从该 ID 出现处到下一个
锚点或文档末尾"的文本块，规范化后逐 ID 比较——某 ID 只在 head 出现→ `added`；只在
base 出现→ `removed`；两侧都出现但块文本不同→ `changed`。`changed.requirements`/
`.screens`/`.operations` 报表字段取 `added ∪ removed ∪ changed`，分别用既有的
`REQ_ID_RE`/`SCR_ID_RE`/operationId 行正则（§4.5 从 `gate-hygiene.ts` 搬到共享
模块）调用同一个函数。

**为什么这不是重新犯上面推翻的错误**：上面放弃按 REQ-ID 分块，是因为它**驱动平台
布尔判定**时会漏判不挂在任何 ID 下的段落（In/Out scope 等）——这个函数现在只用来回答
"哪些 ID 变了"这个更窄的问题，从不驱动 §2.4/本节前半部分的平台布尔（那部分继续用整篇
文档 diff，不受影响）。两个字段用不同算法，是因为它们回答的是两个本来就不同的问题：
"哪些 ID 变了"能够、也应该精确回答；"因此该测哪个平台"在没有 task 图时做不到精确，
只能保守——第 1 稿把这两个问题混为一谈,导致报表字段被错误地降格成"只报告新增/删除的
ID"。

**`breaking`（D7，随 D20 的算法调整而调整,定义本身不变）**：直接取
`diffAnchoredBlocks` 应用于 operationId 时返回的 `removed` 子集（不是三者的并集）；
`breaking = (removed.size > 0)`——即某个 operationId 在 base 存在、head 不存在。
改名在没有显式标注时与"删除+新增"在 ID 集合层面无法区分，
保守地按"删除"计入 breaking；仅新增 operationId、或仅修改现有 operation 的其余内容
（operationId 本身不变，落入"块不同"这一类）不算 breaking——这与 D5 的保守性原则
一致方向（宁可误报 breaking、不可漏报），且这条定义本来就不依赖"报表字段该不该精确"
这次修复，两者是正交的。

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
想手动确保某平台也测一遍）。最终仍然经过 D4/D18 的 `existing` AND——给一个从未声明过、
或声明了但尚未 scaffold 的平台打标签,都不会凭空让 CI 去构建一个不存在的目录（§0 D4/
D18 已详细论证原因）。

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
  /** 仅 status === 'renamed' 时出现：rename 前的路径（D19）。两个 reader 后端都必须
   *  填充它——GitHub compare/PR-files API 的 renamed 条目自带 `previous_filename`
   *  字段；本地 git 用 `git diff --name-status -M` 输出的 `R<score>\t<old>\t<new>`
   *  行解析。缺了它，内容字节完全不变的 rename 会被误判为"新增文件"从而"有实质
   *  变化"（评审发现的 P1，见 §2.5 的具体修复）。 */
  previousPath?: string;
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
): ImpactReader;   // GET /compare/{base}...{head}（分页/截断处理见下）+ GET /contents/{path}?ref=

export function createLocalGitImpactReader(repoRoot: string): ImpactReader;
  // shells out to `git diff --name-status -M base head` + `git show ref:path`
```

**API 截断必须 fail closed，不能停留在"低风险假设"（D22，修复第 1 稿把已知风险仅记为
待决事项的问题）**：compare API 单次响应对变更文件数有上限，超出时的截断信号需要在
实现时对照 GitHub 当时的文档精确核实（本文不假装确切知道这个字段的名字——这本身就是
一处需要验证、不是可以想当然的 GitHub API 细节），但无论具体机制是什么，
`createApiImpactReader.listChangedPaths` 的实现要求是明确的：**能确认响应完整则返回；
不能确认完整（探测到截断、或分页/截断信号本身读取失败）则抛异常**，绝不能把一个可能
不完整的文件列表当作完整列表默默返回——这是"无法判定时必须失败"这条要求的直接应用，
不是可选的加固项。

**`detectPlatforms`（CI 路径）刻意不经这条 compare API 路径**（D22）：`detectPlatforms`
自己已经用全量分页、已修好 1000-文件截断 bug 的 `fetchChangedFiles`（§4.5）读到一份
可信的变更路径列表，并把它作为 `changedPaths` 直接传给 `computeImpact`（§4.3）——这个
列表在整个 `detect` 执行期间只被读取一次，也是唯一真正驱动 `CI Gate` 判定的文件列表。
只有**没有** PR 上下文的独立调用（本地 `sdd impact --base --head`，或省略
`changedPaths` 的 API 模式调用）才会退回到 `listChangedPaths`（compare API 或本地
`git diff`）——这类调用本来就是 D9 定义的"预览、非权威判定"路径，其正确性要求本就低于
`CI Gate` 直接依赖的路径，且与 `detect` 用的 PR-files 端点是两个不同来源、不会同时
出现在同一次判定里，不存在"两个来源互相矛盾"的问题（修复第 1 稿把这两个来源混在同一次
`detect` 执行里、进而互相印证但都不可靠的设计）。

### 4.3 包结构

```text
factory/src/
├── github-minimal-client.ts   # 新增（D16）：MinimalOctokit + fetchPullRequest /
│                               #   fetchChangedFiles（D22：全量分页直到不满一页，
│                               #   触及硬上限即抛错，不再静默停在 1000 个文件）/
│                               #   fetchBlobAtRef（404→null）/ diffAnchoredBlocks
│                               #   （D20，共享的按 ID 分块 diff）；
│                               #   REQ_ID_RE / SCR_ID_RE / operationId 提取正则
│                               #   从 gate-hygiene.ts 搬到这里，供三处共用
├── gate-hygiene.ts             # 改为从 github-minimal-client.ts 导入，删除自己的
│                               #   私有 fetchAllChangedFiles/fetchBlobContentStrict
│                               #   实现；fetchChangedFiles 的截断行为修正对 hygiene
│                               #   而言是行为改善（>1000 变更文件的 PR 现在会让
│                               #   hygiene 也 fail closed，而不是静默只看一部分——
│                               #   这与 hygiene 自己"任一校验失败非零退出"的既有
│                               #   原则更一致，是顺带修复，不是 M4 引入的新回归）
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
  /** 预取的变更路径列表（D22）。detectPlatforms 恒传入（用它自己已经全量分页读到的
   *  PR-files 列表，避免重复经 compare API 再读一遍、避免两个来源潜在不一致）；
   *  省略时（独立、无 PR 上下文的 sdd impact 调用）computeImpact 才会调用
   *  reader.listChangedPaths(base, head) 自己获取。 */
  changedPaths?: ChangedPath[];
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

`fetchAllChangedFiles` 搬迁时一并修正其截断行为（D22，第 3 稿修正为对照 PR 自身
`changed_files` 计数,不是"分页到不满一页就算完"）：现状 `while (files.length <
1000)` 达到上限即静默停止分页,改为持续分页读取，读完后与 `fetchPullRequest`
已经拿到的 `pr.changed_files` 计数比对——两者不相等即抛错（覆盖 GitHub PR-files
端点本身的硬上限，不依赖分页行为本身能否辨识截断，也不需要知道这个上限具体是
多少）；额外保留一个纯防死循环用途的分页次数上限，与"是否读完"的判定无关。
`gate-hygiene.ts` 现有依赖这个函数的调用点不需要改代码，只是获得了一个行为改善
（此前 >1000 变更文件的 PR 会被 hygiene 静默漏看一部分，现在会正确 fail
closed，见 §6）。

另新增 `diffAnchoredBlocks(baseText, headText, anchorRegex): { added, removed,
changed: Set<string> }`（D20）：按锚点 ID 出现位置切块、规范化后逐块比较,分别
返回新增/删除/内容变化三个不相交的 ID 集合——`changed.requirements` 等报表字段取
三者并集；`breaking`（D7）只取 `removed`，两者共用一次分块计算，不重复实现。供
`changed.requirements`/`.screens`/`.operations`/`breaking` 四处调用（各自传入
`REQ_ID_RE`/`SCR_ID_RE`/operationId 行正则）。这个函数**只用于报表字段**，
`computeImpact` 驱动平台布尔判定的整篇文档 diff（§2.5）不调用它——两处刻意
使用不同算法，见 D20 的完整论证。

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
  `existing` 平台；带 `previousPath` 的条目对 `path` 与 `previousPath` 各分类
  一次，两者命中不同 component 时两个平台都被并入（D19）。
- **`checkExisting`/`*_paths`/`existing` 一致性（D18 单测，核心回归——修复第 1 稿的
  P1）**：一个 component 在 `projects.yaml` 里已声明但 head tree 里对应 `path`
  没有任何内容（模拟"Architecture Gate 刚批准、Scaffold PR 未落地"）→
  `existing[platform]=false` 且 `*_paths[platform]=[]`，且这条断言必须与
  `existing` 的计算方式共用同一次存在性检查的返回值（测试里注入的 fake tree
  reader 只被调用一次，`existing`/`*_paths` 都从它的返回值派生，不能分别硬编码
  两个可能不同步的值）；该 component 的 `path` 下确有文件 → 两者一致为
  `true`/非空数组；head tree 返回 `truncated:true` → 改走逐 component 的
  Contents API 存在性检查（fake reader 断言被按 component 数逐个调用）。
- **base/head 双重存在性检查（D25 单测，核心回归——修复第 2 稿引入的 fail-open）**：
  单 component 平台：该 component 的 `path` 在 base tree 有内容、head tree 为空
  （模拟"整个目录被这个 PR 删光，但 `projects.yaml` 仍声明它"）→ `detect` 必须
  抛错/fail closed（**不能**判 `existing=false` 然后放行——这条断言是本回归的
  核心，必须显式检查"整个 detect 调用失败"而不是"该平台被跳过"）；多 component
  平台：两个 component 中的一个符合上述"base 有、head 无"，另一个正常 → 同样
  fail closed（不能因为该平台还有其它 component 撑着 `existing=true` 就放过
  被删的那个，见 §0 D25 的表格）；该 component 在 base/head 都不存在 →
  `existing=false`，正常返回、不报错（区分"从未存在"与"存在过又消失"，前者是
  D18 保留的 benign 场景）。
- **`existing` AND 门控（`detectPlatforms` 单测，mock octokit + 固定
  `projects.yaml` fixture）**：`projects.yaml` 只声明 backend+web 两个平台，`design/
  tokens/**` 变化 → `web=true` 但 `ios=false`/`android=false`（不因为 design
  静态规则包含 ios/android 就无视 `existing`）；对未声明、或声明了但未
  scaffold 的平台打 `platform:ios` 标签 → 仍然 `ios=false`（标签不能绕过
  `existing`）。
- **rename 处理（D19，`impact.ts` 单测，fake `ImpactReader`）**：一个文件从
  `previousPath` rename 到 `path`，两侧内容字节完全相同 → 整篇文档 diff 判定
  "无实质变化"（验证 base 侧读的是 `previousPath` 不是 `path`，这是评审指出的
  具体 P1 场景，必须落实成测试而不是只在文档里断言）；rename 的同时内容也发生
  实质变化 → 判定"有实质变化"；`createApiImpactReader`/`createLocalGitImpactReader`
  各自的单测断言两者都会为 `status='renamed'` 的条目填充 `previousPath`（前者
  从 mock API 响应的 `previous_filename` 字段解析，后者从 `git diff --name-
  status -M` 的 `R<score>\t<old>\t<new>` 输出行解析）。
- **`previousPath` 对 base component 列表分类（D26 单测，核心回归——修复第 2 稿
  对 D19 的不完整修复）**：一个 component 的 `path` 在这次 PR 里从 `apps/backend`
  改为 `apps/api`（`projects.yaml` 同步更新），该 component 目录下的文件在变更
  列表里全部标记为 `renamed`（`previousPath=apps/backend/...`）→ 断言两个平台
  信号都被正确置位：`path`（`apps/api/...`）命中 head 声明的新 component；
  `previousPath`（`apps/backend/...`）命中 **base** 声明的旧 component（用
  head 列表去匹配 `previousPath` 必然失败，这条断言必须显式验证传入
  `classify()` 的是 baseComponents 而不是 headComponents，否则会像第 2 稿一样
  悄悄退化成无效果的修复）。
- **`sdd impact` 整篇文档 diff（D5/spec.md 场景，`impact.ts` 单测，fake
  `ImpactReader`）**：spec.md 在 base/head 之间字节完全相同 → 全部平台
  `false`；仅追加一个空行/尾随空白差异（规范化后相同）→ 全部平台 `false`；
  修改一段不挂在任何 `REQ-*` ID 下的"Out of scope"文本 → 全部 `existing`
  平台 `true`（这是本文档明确记录的、曾被推翻的按 REQ-ID 分块方案会漏判的
  具体场景，必须作为回归测试存在，不能只在文档里描述而不落实成测试）；修改
  一个 `REQ-*` 块内的验收标准文本 → 同样全部 `existing` 平台 `true`（与上一条
  用同一条整篇 diff 规则，不应该有不同结果）。
- **`changed.requirements`/`.screens`/`.operations`（D20 的按 ID 分块 diff，
  `impact.ts` 单测，修复第 1 稿把这三个字段定义成纯 ID 对称差的问题）**：head
  新增一个 REQ-ID、base 独有一个 REQ-ID 消失 → 两者都出现在
  `changed.requirements`（回归第 1 稿本就覆盖的场景）；**新增核心用例**——同一个
  REQ-ID 在两侧都存在，但该 ID 对应的文本块内容被重写（如验收标准整段替换）→
  该 ID **必须**出现在 `changed.requirements`（这是评审指出的 P1，第 1 稿的
  ID-对称差算法会让这条用例失败，必须作为回归测试存在）；同一个 REQ-ID 在
  两侧都存在、且块内容规范化后完全相同（只是恰好被无关的格式化触碰到附近行）
  → 不出现在 `changed.requirements`；`changed.screens`/`changed.operations`
  各自对 `SCR_ID_RE`/operationId 正则跑同一组等价用例。
- **`breaking`（`impact.ts` 单测）**：base 有、head 无的 operationId → `breaking
  =true`；仅新增 operationId、或仅修改现有 operation 的其余内容（operationId
  本身不变，落入 D20"块不同"分类）→ `breaking=false`（M4 窄口径的诚实边界，
  注释里说明这类情况留给 M4.5）。
- **`contract_changed`（`detect.ts` 单测）**：只改 `contracts/events.yaml`
  （不改 `openapi.yaml`）→ `contract_changed=false`，但平台布尔仍按 `contracts/
  **` 宽口径全部 `existing` 平台 `true`（两个字段在同一输入下给出不同结果，
  直接验证 D8 两者不应混用）；`openapi.yaml` 被删除（status=removed）→
  `contract_changed=false`。
- **`specs/<version>/**` bucket 分流（D21，`detect.ts` 单测）**：只改
  `specs/v1/plan.md`（不改 architecture.md/projects.yaml）→ `needs_impact=true`
  且平台信号为全部 `existing` 平台（回归第 1 稿"`plan.md` 落入不调用 impact
  的通用兜底"这一具体 P1）；bucket 内一个未被显式枚举的文件（如
  `specs/v1/notes.md`）→ 同样 `needs_impact=true` 且视同 architecture.md
  处理，不落入 `.github/**` 式的彻底兜底。
- **`fetchChangedFiles` 与 `pr.changed_files` 计数比对 fail closed（D22 第 3 稿，
  `github-minimal-client.ts` 单测，含 `gate-hygiene.ts` 现有测试套件的回归）**：
  mock `pr.changed_files=5000`，但分页响应（模拟 GitHub 真实 3000 上限，不是
  第 2 稿自己发明的数字）在读到 3000 条后不再返回新内容 → 函数抛错（断言错误
  信息提到计数不一致，便于排障），不返回部分结果；`pr.changed_files` 与实际
  抓取数一致（含"确实只有很少文件"的正常场景）→ 正常返回；`checkPrHygiene`
  既有测试套件在这一改动后继续全部通过（确认这是行为改善、不是破坏性变更）。
  这条测试的核心是验证"验证信号本身"（计数比对），不是验证某个具体的分页
  截断阈值，因此不会重蹈第 2 稿"只测自己发明的上限、没测 GitHub 真实上限"的
  覆盖不足问题。
- **`computeImpact` 接收预取 `changedPaths`（D22，`impact.ts`/`detect.ts` 单测）**：
  提供 `changedPaths` 时,`computeImpact` 不调用 `reader.listChangedPaths`（断言
  fake reader 的该方法调用次数为 0）；省略时才调用。`detectPlatforms` 的单测
  断言它总是把自己读到的列表传给 `computeImpact`。
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
  job 因 `if:` 为假直接跳过（不会走到 `fromJSON('[]')` 这一步）；新批准 `ios`
  平台但目录未生成（Scaffold PR 尚未落地）时，`existing.ios=false`、
  `ios_paths=[]` ——D18 修复后这是由 §2.3 的存在性检查直接算出的结果，测试
  断言的是"检查确实跑了、确实返回 false"，不是"空 matrix 恰好安全"这个次要
  的兜底事实（第 1 稿在这里的测试意图本身就建立在错误的假设上，一并修正）。
- **Scaffold PR 回归（呼应 §5.1，M3 代码合并后可执行）**：一个新增 `apps/
  android/**` 的 Scaffold PR，在 M4 版 `detect` 下正确路由到 `android=true`、
  其余三平台 `false`（因为只有 android 的 `apps/**` 路径变化，且未触碰
  specs/design/contracts），`android` job 成功、其余三个 `skipped`，`CI
  Gate` 整体通过。
- **工具链安装冒烟测试（D23，GitHub Actions 实测，非阻塞但需要覆盖）**：四个
  reusable workflow 各自在一个已知能通过 M3 命令契约的 fixture 产品仓上跑一次
  真实 CI，确认 `setup-java`/`setup-node`+`corepack enable`/Tuist+SwiftLint+
  Xcode 选择/Android SDK 各自的安装步骤成功、且紧随其后的 lint/typecheck/test/
  build 四条命令确实使用了 M3 锁定的版本（而不是 runner 默认预装的、可能不同的
  版本）——例如 `java -version`/`node -v` 的输出断言，而不只是命令退出码为 0
  （退出码 0 不能排除"用了错误版本但恰好也能跑通"这种更隐蔽的问题）。
- **迁移路径（隔离测试环境，镜像 M2 §5.1/M3 §6 的隔离 org E2E 风格）**：对一个
  已 `--finalize-protection` 的产品仓,先在旧版 pinned SHA 下确认现状（M2 stub
  行为），推进平台仓到新版本、走 §5.4 的两步升级顺序，确认升级后同一产品仓的
  新 PR 能观察到完整平台矩阵生效，旧 PR（若仍打开）不受影响（required workflow
  的 pin 只在 org ruleset 显式前移后才切换，不会对已有 PR 运行历史产生追溯性
  影响）。同一批 E2E 里核实 **D24**：`java.yml` 等 reusable workflow 的
  `actions/checkout` 用默认 `GITHUB_TOKEN` 能否成功 checkout 产品仓——这是
  M4 代码实现前必须先跑通的前置验证，不是等实现完成后才发现方案不可行。

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
  - `*_paths[platform]` 与 `existing[platform]` 由同一次存在性检查构造，不是
    两个可能不同步的独立断言（D18，测试覆盖"新批准但未 scaffold 的平台"场景）。
  - **该存在性检查同时看 base 与 head**：一个仍在 head `projects.yaml` 声明中
    的 component，其 `path` 在 base 有内容、head 却消失 → `detect` 整体 fail
    closed，不是静默判 `existing=false` 后放行（D25，单/多 component 平台各有
    测试覆盖，见 §6——这是"删光一个平台的代码反而让 CI 通过"这一 fail-open 的
    直接修复）。
  - 路径规则、`sdd impact` 结果、`platform:*` 标签的并集经 `existing[platform]`
    AND 门控（D4/D18），测试覆盖"未声明、或声明了但未 scaffold 的平台，不会被
    任何信号强制为 true"。
  - `sdd impact` 失败或输出非法 → `detectPlatforms` 抛错、CLI 退出码 `3`
    （不吞错、不静默降级为全 false）；`fetchChangedFiles` 分页读完后与 PR 自身
    `changed_files` 计数不一致时同样抛错（D22 第 3 稿——不是靠一个自设的硬上限，
    而是靠一个独立、可验证的完整性信号，覆盖 GitHub PR-files 端点真实的硬
    上限）。
  - `ChangedPath` 的 rename 条目携带 `previousPath`，两个 reader 后端均已实现
    （D19），且 `computeImpact` 的整篇文档 diff 用 `previousPath` 而非 `path`
    读取 base 侧内容；`detect` 的路径分类对 `previousPath` 用 **base**
    `projects.yaml` 派生的 component 列表分类（D26——用 head 列表分类会在"改
    路径的同时更新声明"这一常见场景下失效，第 2 稿的修复曾在这里留了个不生效
    的半成品）。
  - `changed.requirements`/`.screens`/`.operations` 用按 ID 分块 diff 计算
    （D20），能检测到"ID 不变但内容重写"的情况，不再是纯 ID 集合对称差。
  - `specs/<version>/**` 作为统一 bucket 处理，`plan.md` 与 bucket 内未枚举文件
    都会触发 `sdd impact`（D21），不再落入不调用 impact 的通用兜底。
- `CI Gate` 聚合 job：`needs.detect.result != 'success'` 时无条件失败（检查顺序
  在最前面，§3.3 回归测试覆盖）；四个平台 job 按 D12 化简真值表判定，等价性覆盖
  手册 §9 全部 5 行 + 2 个未列出状态。
- 四个 reusable workflow 各自：`runs-on` 对应平台（`ios.yml` 为 `macos-*`）；
  `strategy.matrix` 按 `paths` input 驱动；显式 `with:` 传参，不依赖穿透
  `workflow_call` 的隐式 `github` 上下文（§1.1 自查项）；外层 `if:` 门控保证
  未检测到的平台不分配 runner（iOS 尤其，§12.5 场景实测通过）；各自补齐 D23
  的工具链安装步骤，版本与 M3 锁定版本一致（工具链冒烟测试通过）；`actions/
  checkout` 用默认 `GITHUB_TOKEN` 能成功 checkout 产品仓（D24，隔离环境验证
  通过——**这是本条 DoD 里唯一一个"验证失败即整个方案不成立"的项，必须在其余
  实现工作展开前跑通**）。
- `ci-gate.yml` 触发器新增 `labeled`/`unlabeled` 事件类型，`platform:*` 标签
  仅打标签、不推新 commit 也能触发重新判定（D13/§2.8 场景实测通过）。
- 共享 helper 抽取完成（D16）：`gate-hygiene.ts` 不再包含私有的
  `fetchAllChangedFiles`/`fetchBlobContentStrict`/`createMinimalOctokit`
  实现，行为经既有 M2 测试套件回归验证不变（含 D22 对截断行为的修正）。
- 工作区全绿：`pnpm install --frozen-lockfile` + `pnpm -r build && typecheck &&
  test && lint`，无生成漂移。
- §6 测试小节列出的全部用例（含 spec.md 整篇 diff 的具体回归场景、detect 失败
  传播场景、D18–D22 各自的回归测试）都已落实为可执行测试，不是仅停留在文档
  描述。
- **D21 记录的"specs/\*\* 保守全跑"解释已获得独立确认**（不是本文档单方面
  认定满足手册验收语义）——评审通过时需要明确这一条是否需要同步反映到
  implementation-plan.md 或 runbook，而不是留待事后才发现解释不被接受。

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

1. **（已提升为 D24，不再是普通待决事项）** 默认 `GITHUB_TOKEN` 能否 checkout
   `inputs.product_repo` 指向的产品仓——这项验证决定 D1/D2 整个方案是否可行，
   要求在 M4 代码实现**开始前**用隔离测试环境完成，见 §0 D24、§1.1、§6 迁移
   路径测试小节。此处不再重复。
2. **（大部分已由 D22 解决，剩余范围收窄）** compare API 的文件数截断信号具体
   机制（字段名/判定方式）需要在实现时对照 GitHub 当时的文档核实——这是
   `createApiImpactReader`（独立/本地预览路径专用，见 D9/D22）自身实现细节，
   不再影响 `detect`/`CI Gate` 判定本身（CI 路径已经改为直接使用
   `detectPlatforms` 自己全量分页读到的列表，不再经过 compare API，见 D22）。
3. **四个平台模板具体的 `runs-on` 版本**（如 `macos-14` 的具体可用性）：与
   M3 §11 待决事项 #3 同类,实现时按 GitHub-hosted runner 当时实际支持的
   镜像版本核实，需要与 M3 模板锁定的 `.xcode-version` 相容。
4. **`design/tokens/**` 子路径按平台收窄的可行性**：见 §10，非本里程碑阻塞项，
   记录以便 Design Gate 实现细节确定后重新评估。
5. **（已解决）** D21"specs/\*\* 保守全跑"解释已被接受，且已同步写入
   `implementation-plan.md`（M4 小节）与 runbook（§9 路径表之后）——不再是
   待决事项，此处保留编号只为与前序版本的引用对应。
6. **Android SDK platform/build-tools 版本是否需要显式 `sdkmanager` 步骤**
   （D23）：取决于 GitHub-hosted `ubuntu-latest` runner 当时预装的 SDK 版本
   是否已覆盖 M3 锁定的 `compileSdk 35`/AGP 8.5.2，实现时核实。

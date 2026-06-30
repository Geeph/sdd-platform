# M2 实施细案：Factory `product init`（控制骨架 + 最小 CI Gate）

> 本文是 [implementation-plan.md](implementation-plan.md) 中 **M2** 里程碑的文件级实施
> 方案，评审通过后据此交 Codex 实现。M2 完成 = 能用 `sdd product init` 把一个新产品仓
> bootstrap 成"受 Gate 保护、`CI Gate` / `PR hygiene` 可绿、且每个 Gate 合并即产出可被
> `@sdd/provenance` 校验的授权元数据"的**控制骨架**（`components: []`，**不含 `apps/*`**）。
>
> 依据手册（[single-repo-implementation-runbook.md](single-repo-implementation-runbook.md)）
> §5（含改写后的 §5.2 / §5.3）、§6.1–6.3、§12；以及 implementation-plan §1（贯穿性授权
> 溯源）、§M2。格式对齐 [m1-foundations.md](m1-foundations.md)。
>
> **本版为第 4 稿**，据评审修订：删除 D7 生产 fallback、明确 CI/hygiene 执行拓扑（D7 / §3.6）；
> 补公共 TS 接口（§2.5）、dry-run JSON schema（§2.2）、`product-init.yaml` schema（§2.8）、
> 隔离 org E2E 步骤（§5.1）；Contract Gate 里程碑改回 **M4.5**；生产强制显式 `--platform-ref`。
> 本轮进一步把 required workflows 落成专用 organization ruleset 的 `evaluate → active` 状态机，
> 修正 finalize 证据、公开接口、权限模型和 spoof 验收。
> §0 列出全部实现级决策，请优先核对。

## 0. 已定决策

沿用 M1 已定的运行时与工具链（Node 24 LTS + TS strict、pnpm/tsup/vitest/oclif/biome、可
复现构建），不复述。M2 新增决策：

- **D1 — factory 在 M2 落地**：M1 的 `factory` 占位包补全为真实实现；CLI 新增
  `sdd product init`（含 `--dry-run` / `--finalize-protection`）与 `sdd gate hygiene`（仅
  CI 调用）。`sdd validate`（M1）被模板自测复用。
- **D2 — 快照内容 = 渲染后的 `monorepo-root`（对 §5.2 的细化）**：初始快照仅渲染**产品身份**
  （`product` / 显示名 / slug）并生成 `template.lock`；其余文件逐字来自模板。初始
  `.github/CODEOWNERS` 为 **bootstrap 兜底**（`* @<org>/<admins>`），保证仓库自建起"有主"。
  **分区 owner 映射由 Bootstrap PR 写入**——它是首个可评审 diff，也是首次跑
  `CI Gate` / `PR hygiene` 的载体。理由：让初始 `projects.yaml` / `AGENTS.md` 从一开始即合法、
  过 `sdd validate`；产品定制经评审入库。
- **D3 — `template.lock` = 来源与生成结果的审计锚点**：记录 platform repo / ref /
  resolved-commit / template-path、manifest/tree digest 和逐文件 source/output digest；服务于 §4.6
  审计与 M8 定向更新判断，**不用于自动覆盖或对业务文件做通用 drift diff**。
- **D4 — 两段式 init（对 §5.2 步序的落地）**：`sdd product init` 执行第 1–5 步（建仓 + 快照建
  `main` + 配置 labels/teams/env/**初始 ruleset 不含 required checks** + 创建 Bootstrap PR）；
  `sdd product init --finalize-protection` 执行第 6 步（Bootstrap PR 合并、两个 check 在其
  **最终 head SHA** 上真实成功**并经 workflow 可信性核验**后，**幂等**地加固 required checks /
  required workflows：org workflow ruleset `evaluate→active`，产品仓 status checks 由无到有）。
  required 必须在 context 真实存在且成功后才启用（§5.2 / §12.1），故拆成两次调用。
- **D5 — Gate 版本经路径 + marker，label 懒创建**：`gate:<gate>`（5 个固定 label）标 Gate
  **类型**；**版本**以 `specs/<version>/` 路径段 + Gate PR marker 为准，PR hygiene 强制
  `label ↔ marker ↔ path` 一致。版本 label `version:v<n>` 由后续 Gate PR 流程**按需 upsert**
  （不预创建无限集合），给 provenance 一个 GitHub 原生交叉核对点。〔评审项：是否保留
  `version:*` label，还是纯靠 path+marker——两者都满足 m1 provenance"label 仅辅助核对"。〕
- **D6 — `gate:*` 与 `track:*` 正交**：`gate:*` 标在 **Gate PR**（审批产物）；
  `track:*` / `platform:*` / `type:*` / `status:*`（手册 §5.3）标在 **backlog Issue**（任务）。
  M2 两族 label 都创建，用途不同，互不混用。
- **D7 — CI/hygiene 执行拓扑：平台仓集中托管 + 专用 organization ruleset**：`CI Gate` 与
  `PR hygiene` 由平台仓 `.github/workflows/{ci-gate,pr-hygiene}.yml` 提供。Factory 在目标仓完整
  `main` 建立后，为该仓创建或认领一个专用 organization ruleset：稳定名
  `sdd-workflows-<repository-id>`，repository condition 精确匹配目标 repo name，branch condition 只含
  `refs/heads/main`，workflow 固定平台仓 `repository_id + path + sha`。初始 enforcement=`evaluate`，
  必须在 Bootstrap PR **创建前**就位；workflow 会运行但不阻塞合并。finalize 验证最终 head evidence
  后把同一 org ruleset切为 `active`。**产品仓模板不含任何 gate workflow**。目标 org/plan 不支持
  required workflows/evaluate、源仓未开放给组织内仓库访问，或 Factory 无 organization ruleset 权限时，
  生产模式 fail closed；无本地 workflow fallback。repo rename 会使 name condition 失配，M2 将其视为
  drift/conflict，不自动改写 target。
- **D8 — check context 名冻结**：聚合 job 的 `name` 必须是 `CI Gate` 与 `PR hygiene`（ruleset
  required status check 按 job name 匹配 context）。M4 扩 `detect` / 平台矩阵时**复用同名 job**，
  不得改名（plan §4 / §13 风险）。M2 加守卫测试防漂移。
- **D9 — 空仓库 bootstrap 顺序（纠正初稿）**：GitHub **不允许给空仓库直接创建 ref**，故不能走
  "createBlob→createTree→createCommit→createRef(main)"。正确顺序：先用 **Contents API** 写最终
  `template.lock` 作 **seed commit** 建立 `main`，再用 **Git Data API** 以 seed tree 为
  `base_tree` 建完整 tree/commit，并一次**非 force** ref 前进发布快照。最终 `main` 因而含
  **seed + snapshot 两个** bootstrap commit，不是单一 root commit。详见 §2.3。
- **D10 — check 防伪不止认 name**：仅按 check name 要求可被伪造（任意 PR 可新增同名 workflow 自满足）。
  产品仓 `sdd-main` ruleset 的 required status checks 绑定 GitHub Actions **integration_id**；D7 的专用
  organization ruleset 另以 required workflows 固定平台仓的 `repository_id + path + sha`。组织不支持
  任一能力时对**生产模式 fail closed**。这两个平台 workflow 用只读 `pull_request`、最小 `GITHUB_TOKEN`、
  **无 secret、不 checkout/执行 PR blob**（PR 文件仅经 API 读，第三方 action 固定完整 SHA）。
  产品 PR 无法改写受信 workflow；`--finalize-protection` 加固前仍 read-back 确认 org ruleset 指向预期
  target repo/main 和 source `repo/path/sha`。详见 §3.6。
- **D11 — init = 可重入状态机**：phase 由 GitHub **实际状态**推导，不在本地存 checkpoint；每步
  分类 `create/update/noop/conflict/blocked`，只对 `create/update` 写；失败用**同一输入重跑**
  收敛。**默认不删仓 / 不关 PR / 不 force / 不回滚 `main`**；检测到不一致即停并报差异，破坏性
  处置由人另行执行。详见 §2.6。
- **D12 — dry-run 确定性**：`--dry-run` 复用真实路径的**纯 plan compiler**，仅注入只读 port；
  输出 canonical JSON（固定 key/数组序，去除时间戳/请求 id/限流剩余等易变字段）+
  `operation_id = sha256(规范化输入 + resolved_commit + tree digest)`；相同输入恒 **byte-identical**。
  text 输出只是该 model 的 renderer。运行期禁止任何 `POST/PUT/PATCH/DELETE` 与本地状态文件。
- **D13 — teams 只校验不创建**：M2 **不创建 org team、不改 membership**，只校验目标 team 已存在
  且 ≥1 active member，并赋予 repository permission；team 缺失 → `blocked`。（对初稿"幂等创建
  team"的安全收敛：建 org team 需更大权限且不可逆。）
- **D14 — 三个可独立评审的实现 PR**：M2a 交付模板/manifest/lock、配置 schema、纯 plan compiler 与
  CLI dry-run（不含任何 GitHub write adapter）；M2b 交付 Contents seed + Git Data bootstrap、状态机与
  失败恢复（不含 GitHub 配置）；M2c 交付 labels/teams/environments、产品仓 ruleset、专用 org workflow
  ruleset、Bootstrap PR、`CI Gate` / `PR hygiene` 与隔离 org E2E。严格按 M2a→M2b→M2c 合并。

## 1. `monorepo-root` 模板（产品仓初始内容）

模板源码位于平台仓 `templates/monorepo-root/`，配套生成 `templates/monorepo-root.manifest.json`
（见 §2.4）。产品仓初始结构（对齐手册 §5.2"初始结构"）：

```text
<product>/
├─ specs/_template/{spec.md, architecture.md, design.md, plan.md}
├─ contracts/{README.md}                    # openapi.yaml/events.yaml 在 Architecture/Contract Gate 引入
├─ design/tokens/{README.md}                # tokens 在 Design Gate 引入
├─ projects.yaml                            # schema_version:1, product:<name>, components: []
├─ template.lock                            # seed commit 内容（D3/D9）
├─ AGENTS.md                                # 渲染产品名；SDD 工作流与 Gate 纪律
├─ README.md                                # 渲染产品名
└─ .github/                                # 无 workflows/——CI Gate/PR hygiene 由平台仓 required workflows 产出（D7/§3.6）
   ├─ ISSUE_TEMPLATE/{intake.yml, config.yml}
   ├─ PULL_REQUEST_TEMPLATE/gate.md
   ├─ pull_request_template.md              # 默认（非 Gate）PR 模板
   └─ CODEOWNERS                            # 快照=bootstrap 兜底；Bootstrap PR 写分区映射
```

> 空目录用受管理 `README.md` 保留（不用 `.gitkeep`，让 manifest 枚举每个受管文件）。

### 1.1 `specs/_template/`（必填字段，依据 §6.2/6.3/6.5/6.6）

模板把 PR hygiene 会机检的内容固化为**必填小节 + 稳定 ID 占位**：

| 文件 | 必填内容 | 稳定 ID / 机检点 |
|---|---|---|
| `spec.md` | 功能需求+验收标准、非功能需求、In/Out scope、风险与未决问题 | ≥1 个 `REQ-<AREA>-<n>`（`^REQ-[A-Z0-9]+-\d+$`） |
| `architecture.md` | 组件边界与依赖方向、需生成的平台、OpenAPI/event 边界、数据/安全/性能策略、领域模型；注明"物理 DB schema/migration 仅属 `apps/backend`" | 与 `projects.yaml` 同 PR；若引入 `contracts/openapi.yaml` 另触发 Contract Gate（M4.5） |
| `design.md` | 主/失败/边界流程、loading/error/empty/offline、平台差异、a11y、设计 token、页面↔OpenAPI | ≥1 个 `SCR-<NAME>`（`^SCR-[A-Z0-9-]+$`） |
| `plan.md` | 技术路径、平台任务边界、合同与 mock 策略、跨平台依赖、测试策略、发布顺序 | 无 UI 时**必填**跳过 Design Gate 理由（见 §1.4 marker） |

> 模板正文承载人读内容与 ID 约定；**机读的 gate/version/上游批准 marker 在 Gate PR 模板**
> （§1.4），不放进 artifact，避免两处来源。

### 1.2 `projects.yaml`（初始态）

```yaml
schema_version: 1
product: <name>          # 渲染
repository_mode: monorepo
components: []            # init 不预设平台；过 M1 sdd validate
```

### 1.3 `AGENTS.md`（产品仓 agent 纪律，要点）

Intake → Spec → Architecture →（Design 或有据跳过）→ Plan → Backlog 的 Gate 顺序；Gate PR 必
须用 `gate:*` label + 填 §1.4 marker；稳定 ID 规则（`REQ-/SCR-/operationId`）；contract-first
（不手改 generated client）；CI 经 `CI Gate` 统一判定。**不含**任务状态（状态只在 Issues）。

### 1.4 `.github/`

**Intake Issue Form**（`ISSUE_TEMPLATE/intake.yml`，依据 §6.1）字段：问题与目标、用户与场景、
范围与排除项、平台范围（backend/web/ios/android 多选）、合规/安全/性能约束、未决问题。
`config.yml` 关闭 blank issue、引导走表单。

**Gate PR 模板**（`PULL_REQUEST_TEMPLATE/gate.md`）含机读块（PR hygiene / provenance 的契约）：

```text
<!-- sdd:gate
gate: spec|architecture|design|plan|contract
version: v1
upstream_approvals:        # architecture/design/plan 必填：引用上游 Gate 的 merge SHA 或 PR#
  spec: <merge_sha|#PR>
  architecture: <merge_sha|#PR>
  design: <merge_sha|#PR|skipped>
skip_design_gate_reason:   # 当 design=skipped（无 UI）时必填
-->
```

作者同时打 `gate:<gate>` label（版本由 marker + 路径定，见 D5）。

**CODEOWNERS**：快照为 bootstrap 兜底（`* @<org>/<admins>`）；Bootstrap PR 写入分区映射
（§3.3，对 §5.3 补齐了 `projects.yaml` / `AGENTS.md` / `.github/` / `template.lock` 的 owner）。

**workflows**：产品仓 **不含** `ci-gate.yml` / `pr-hygiene.yml`。`CI Gate` 与 `PR hygiene` 由**平台仓**
集中托管的 required workflows 产生（D7 / §3.6）；其 YAML 形态见 §3.4。

## 2. `@sdd/factory`：`sdd product init`

### 2.1 命令接口

```bash
# 预览（零 GitHub 写）
sdd product init <product> --mode monorepo --owner <org> \
  [--platform-ref <tag|sha>] [--config <product-init.yaml>] [--format text|json] [--dry-run]
# 真建仓（第 1–5 步）
sdd product init <product> --mode monorepo --owner <org> --platform-ref <tag|sha> [--config ...]
# 合并 Bootstrap PR 且 check 变绿后，加固 ruleset（第 6 步，幂等）
sdd product init <product> --owner <org> --finalize-protection
```

`--config` 给出 `product-init.yaml`（schema 见 §2.8：owner→区域映射、team permission、environment）。
**`--platform-ref` 在真实/生产模式必填**（release tag 或完整 commit），统一解析为完整 40 位 commit 并
钉死；**禁止默认到可移动的 default HEAD**。仅 `--dry-run` 探索可缺省，但报告必须显式标注"未固定 ref，
仅供预览"。`product` 与 M1 `projects.schema.json` 同 pattern；repo/owner/team slug/路径在任何网络调用前
校验。**无 `--force` / `--recreate` / 隐式 adopt**。

退出码：`0`=完成/noop；`2`=输入或 checksum 错误；`3`=preflight/权限 `blocked`；`4`=等待 Bootstrap
PR 人工批准/合并；`5`=检测到 drift/conflict；`6`=GitHub 暂时性失败可重跑。

### 2.2 Dry-run 报告（覆盖 §5.1 全部条目 + 确定性）

内容：将创建的仓库；从**固定 revision** 的 `monorepo-root` 写入的目录/文件清单；根模板 ref 与
**resolved commit**；将配置的 labels / ruleset / workflows / CODEOWNERS；缺少的 owner / secret /
environment；显式打印 `components: []` 且**不生成 `apps/*`**。

确定性（D12）：输出 canonical JSON（UTF-8/LF/两空格/末尾换行，固定 key 顺序、数组按明确 key 排序），
每个 operation 带 `disposition ∈ {create,update,noop,blocked,conflict}`，**无时间戳/请求 id/限流
剩余/token/本地路径**等易变字段；`operation_id` 稳定；相同参数+平台 commit+模板 bytes+目标 observed
state 下两次运行 **byte-identical**。secret 只出现 name/status，绝不出现值。dry-run 可做 `GET/HEAD`
解析 ref/preflight，但**零 mutating 调用**（测试在网络层断言，见 §5）。

`--format json` 输出契约（UTF-8 / LF / 两空格 / 末尾一换行；对象 key 按下列顺序、数组按注明键排序）：

```json
{
  "plan_version": 1,
  "operation_id": "sha256:<64-hex>",
  "target": { "owner": "acme", "repository": "demo", "visibility": "private", "default_branch": "main" },
  "source": { "repository": "<org>/sdd-platform", "requested_ref": "v0.2.0", "resolved_commit": "<40-hex>" },
  "template": {
    "path": "templates/monorepo-root",
    "manifest_sha256": "sha256:<64-hex>",
    "source_tree_sha256": "sha256:<64-hex>",
    "output_tree_sha256": "sha256:<64-hex>",
    "files": [ { "target": "AGENTS.md", "mode": "100644", "render": false, "output_sha256": "sha256:<64-hex>" } ]
  },
  "projects": { "schema_version": 1, "product": "demo", "repository_mode": "monorepo", "components": [] },
  "operations": [ { "order": 10, "phase": "repository", "kind": "repository.create", "disposition": "create", "target": "acme/demo" } ],
  "requirements": [ { "kind": "team", "name": "product-team", "status": "satisfied" } ],
  "warnings": []
}
```

排序键：`template.files` 按 `target` 的 UTF-8 字节序；`operations` 按 `(phase, order)`；`requirements`
按 `(kind, name)`；labels/teams/environments 各按 name/slug。`disposition ∈ {create,update,noop,blocked,
conflict}`；`requirements[].status ∈ {satisfied,missing,blocked}`。`operation_id = sha256(JCS(规范化输入
+ resolved_commit + template.output_tree_sha256))`。text 输出只是该 model 的 renderer，不另算状态。

### 2.3 真建仓 bootstrap（§5.2 第 1–5 步；**Contents seed → Git Data 快照，纠正空仓库限制**）

**写前 preflight（全过才动手）**：解析/校验模板；校验 org/repo name/owner/team slug/路径；确认目标
仓不存在、或可确认为本次 partial state（`operation_id` marker）；校验 teams 已存在且有 active
member（D13）、environment reviewer、token 能力与 org policy（Actions / ruleset / required workflow）。
任一不足 → `blocked`，不开始写。

1. 解析 `--platform-ref` → **完整 40 位 commit**（annotated tag 递归 peel）；读该 commit 下
   `monorepo-root`，按 manifest 重算 checksum，不符 **fail closed**。此后所有 blob 一律按该 commit
   SHA 读，**禁止再按可移动 tag 读**。
2. 创建空仓（`auto_init=false`），description 暂带确定性 `[sdd-init:<operation_id>]` marker；保存
   **不可变 repo id**；回读核对 owner/name/id/visibility/empty/marker。
3. **seed**：用 **Contents API** 写最终 `template.lock` 到 `branch=main`，建立 **seed commit + `main`**
   （这是 GitHub 空仓库唯一可行的 bootstrap，**不能给空仓库直接建 ref**，D9）。
4. **snapshot**：读 seed tree；为除 `template.lock` 外每个渲染输出建 blob；以 seed tree 为
   `base_tree` 建完整 tree（核对 path/mode/blob、**无 `apps/*`**）；建 commit（唯一 parent = seed）；
   **仅当 `main` 仍指向 seed 时**非 force 前进到 snapshot commit（已是 snapshot → noop；其他 SHA →
   `conflict`，**绝不 force**）。最终 `main` 含 seed + snapshot 两个 commit。
5. 设 default branch = `main`，把临时 description marker 换成配置值；recursive 读回 tree/blob 重算
   output checksum。**Git 内容阶段不夹带** labels/ruleset/env 写入。
6. **GitHub 配置（§3）**：labels → team repository permissions（**只校验 + 赋权**，D13）→
   environments → 产品仓初始 `sdd-main` ruleset（无 required checks）→ 创建/认领专用 organization
   workflow ruleset，精确 target 当前 repo/main 并设 `enforcement=evaluate` → Bootstrap 分支/PR。
   organization workflow ruleset 必须先于 PR 创建；每个 reconciler 读全分页、按稳定 key upsert、写后
   read-back；**不删未知配置**。
7. Bootstrap PR 上 evaluate-mode ruleset workflows 运行并产出真实 `CI Gate` / `PR hygiene` check
   context（§3.6）；
   命令返回 **exit 4** 等人工 review/merge（不轮询占用进程）。

**`--finalize-protection`（第 6 步加固，幂等）**：仅当证据全部成立才加固——Bootstrap PR 已 merged
到 `main`；approval 针对**最终 head SHA**；reviewer 非作者且为 bootstrap approver；两个 check run 的
`head_sha` = PR 最终 head、`conclusion=success`、`app.id` = GitHub Actions；workflow runs 来自专用 org
ruleset 当前固定的平台 `repository/path/SHA`；org ruleset仍为 `evaluate` 且精确 target 当前 repo/main；
merge commit 可达当前 `main`。随后先把该 org ruleset原地切为 `active`，再更新产品仓 `sdd-main`：开启
code owner review + stale dismissal，required status checks 加精确 `CI Gate` / `PR hygiene` context
**+ integration_id**。两份 ruleset 均 read-back；能力/权限不足时 **fail closed**，保持初始保护态，
不伪报完成。

### 2.4 模板 checksum 与 `template.lock`

平台仓提供 `pnpm run build:template-manifest` 生成 `templates/monorepo-root.manifest.json`
（排序后的 `相对路径 → mode + render? + 原始 blob sha256` + `tree_sha256`）；drift 测试保证 committed
manifest 与重算一致（同 M1 的"生成无漂移"）。manifest 禁止 symlink/submodule/目录穿越/绝对路径/
大小写碰撞/非 `100644|100755` mode/未列出的隐式文件；render 只替换 allowlist token（product/repo/
owners），残留 `{{...}}` 即失败，**不执行模板代码/shell/helper**。`template.lock`（产品仓 seed 内容，
渲染写入）：

```yaml
schema_version: 1
generator: { package: "@sdd/factory", version: "<x.y.z>" }
source:   { repository: "<org>/sdd-platform", requested_ref: "<ref>", resolved_commit: "<40-hex>" }
template: { name: "monorepo-root", path: "templates/monorepo-root",
            manifest_sha256: "sha256:...", source_tree_sha256: "sha256:...", output_tree_sha256: "sha256:..." }
files:    [ { path: "AGENTS.md", mode: "100644", source_sha256: "sha256:...", output_sha256: "sha256:..." }, ... ]
```

canonical YAML（固定 key/排序、无时间戳）；`template.lock` 自身不计入 `output_tree_sha256`（避免递归）。
校验顺序：ref→commit→manifest bytes→每个 source blob→render output→output tree digest→lock round-trip，
任一步不符在 repository write 前失败。

### 2.5 包结构

```text
factory/
├─ package.json · tsconfig.json
├─ src/
│  ├─ index.ts            # 只导出稳定 public API（不导出 octokit adapter 内部类型）
│  ├─ init.ts             # 编排第 1–5 步 + finalize（state machine，§2.6）
│  ├─ resolve.ts          # pin ref→完整 commit、annotated tag peel、读 monorepo-root、checksum
│  ├─ render.ts           # allowlist token 替换 + 生成 template.lock
│  ├─ plan.ts             # 纯 desired+observed→InitPlan（canonical-json + operation_id，§2.2）
│  ├─ snapshot.ts         # Contents seed → Git Data blobs→tree(base=seed)→commit→非force ref（D9）
│  ├─ github-read.ts      # 只读 port（dry-run 只见此）
│  ├─ github-write.ts     # 写 port（仅真实执行注入）+ 分页/重试
│  ├─ reconcile.ts        # labels/teams(校验+赋权)/environments/ruleset/bootstrap-pr 收敛
│  └─ gate-hygiene.ts     # sdd gate hygiene 逻辑（纯规则 + octokit 注入）
└─ test/...
cli/src/commands/product/init.ts   # 接 factory（dryRun=true 时不构造 write port）
cli/src/commands/gate/hygiene.ts   # 接 factory.gate-hygiene
```

公共接口（`@sdd/factory` 的 `src/index.ts` 只导出这些稳定类型；不导出 octokit adapter 内部类型）：

```ts
export interface ProductInitInput {
  product: string;
  target: { owner: string; repo: string; visibility: 'private' | 'internal' | 'public' };
  mode: 'monorepo';
  platform: { repository: string; ref: string };   // ref：真实模式必填，解析为完整 commit
  config: ProductInitConfig;                        // §2.8
}

// 只读 port：dry-run 只见此（类型上看不到 mutation）
export interface GitHubReadPort {
  resolveCommit(repo: RepoRef, ref: string): Promise<ResolvedCommit>;   // annotated tag peel → 40-hex
  readTemplateTree(repo: RepoRef, commit: string, path: string): Promise<ReadonlyTree>;
  observe(input: ProductInitInput): Promise<ObservedState>;             // repo/labels/teams/env/ruleset/PR 实况
}
// 写 port：仅真实执行注入
export interface GitHubWritePort {
  createRepository(i: CreateRepoInput): Promise<RepositoryIdentity>;
  seedMainViaContents(i: SeedInput): Promise<CommitIdentity>;           // D9：写 template.lock 建 main
  publishSnapshot(i: SnapshotInput): Promise<CommitIdentity>;          // D9：blobs→tree(base=seed)→commit→非force ref
  reconcileLabels(i: LabelsInput): Promise<ReconcileResult>;
  grantTeamPermissions(i: TeamsInput): Promise<ReconcileResult>;       // 只赋权，不建 team（D13）
  reconcileEnvironments(i: EnvironmentsInput): Promise<ReconcileResult>;
  reconcileRepositoryRuleset(i: RulesetInput): Promise<ReconcileResult>; // 产品仓 sdd-main
  reconcileOrgWorkflowRuleset(i: OrgWorkflowRulesetInput): Promise<ReconcileResult>; // evaluate/active
  upsertBootstrapPull(i: BootstrapPullInput): Promise<BootstrapPull>;
}

export interface InitPlan {                          // 与 --format json 契约一一对应（§2.2）
  plan_version: 1;
  operation_id: string;
  target: TargetPlan; source: SourcePlan; template: TemplatePlan; projects: ProjectsPlan;
  operations: PlannedOperation[];                    // 每项含 phase/order/kind/disposition/target
  requirements: Requirement[]; warnings: string[];
}
export interface InitResult {
  phase: InitPhase;                                  // §2.6 状态机
  operations: AppliedOperation[];                    // 每步 disposition
  repository?: RepositoryIdentity; mainSha?: string;
  bootstrapPr?: { number: number; headSha: string };
  repositoryRulesetId?: number;
  orgWorkflowRulesetId?: number;
  nextAction: NextAction;                            // 如 'await-human-merge' / 'run-finalize-protection'
}

export function compileInitPlan(input: ProductInitInput, reader: GitHubReadPort): Promise<InitPlan>;
export function applyInitPlan(
  input: ProductInitInput, plan: InitPlan,
  deps: { reader: GitHubReadPort; writer: GitHubWritePort },
): Promise<InitResult>;
export function finalizeProtection(
  target: ProductInitInput['target'],                 // source identity 从 target lock + org ruleset复算
  deps: { reader: GitHubReadPort; writer: GitHubWritePort },
): Promise<InitResult>;                              // 幂等；证据不足 → fail closed

// CI 用：纯规则 + 注入 octokit；不读工作区
export function checkPrHygiene(input: {
  octokit: OctokitLike; repo: RepoRef; pr: number;
}): Promise<{ ok: true } | { ok: false; violations: string[] }>;
```

CLI dry-run **只调用** `compileInitPlan`，类型上无 writer；真实执行先 compile，再调用 `applyInitPlan`。
`finalizeProtection` 从目标仓 `template.lock`、operation marker 和专用 org ruleset复算 source workflow
identity，拒绝调用方另传 platform ref。`InitResult` 不返回 token / secret / 原始 API headers。

### 2.6 恢复、幂等与并发（D11）

phase 全部由 GitHub 实际状态推导（无本地 checkpoint）：

```text
PLANNED → REPO_CREATED → SEED_MAIN → SNAPSHOT_MAIN → REPO_CONFIGURED
        → ORG_WORKFLOWS_EVALUATING → BOOTSTRAP_PR_OPEN → AWAITING_HUMAN
        → BOOTSTRAP_MERGED → CHECKS_VERIFIED → ORG_WORKFLOWS_ACTIVE
        → REPO_RULESET_HARDENED → COMPLETE
```

收敛：repo / `main` / labels / teams / env / repository ruleset / 专用 organization workflow ruleset / PR
各按 desired state `noop` 或前向 `update`；
不一致即 `conflict` 并停。重试：429 / 5xx 按 `Retry-After` + capped backoff + jitter；mutation 仅在
已知幂等或重试前可 `GET` 确认时重试；403 secondary limit 不盲重放；list 端点 `per_page=100` 追 Link
到结束并设对象预算上限。并发：无本地锁，靠 GitHub 条件更新做并发控制（repo name 唯一、ref 非 force
前进、branch compare-and-set、固定 ruleset name / PR branch）；专用 org ruleset 必须同时核对 name、
target repo/main 与 source workflow repo/path/SHA，任一不符即 conflict。竞争失败后重新 observe/replan。
**默认不回滚**：失败报告列 `completed/pending/conflict` 资源与安全重跑命令；不删 repo/branch/PR/
labels/ruleset/env，不 force push，不把 `main` 退回 seed。

### 2.7 权限与前置（生产）

优先 **GitHub App** installation token。因目标仓在调用前尚不存在，installation 必须按组织策略覆盖
新建仓库（例如安装到 all repositories，或建仓后由组织管理员立即把新仓加入 installation）；不能假定
一个仅选择既有仓库的 token 会自动获得目标仓权限。最低权限按 endpoint 实测并在 preflight
列出：目标仓 Repository Administration:write（建仓 / settings / repository ruleset / environments /
team repo permission）、**Organization Administration:write** 或等价的“管理 organization rulesets”
权限（创建/更新专用 workflow ruleset）、Contents:write（Git Data refs/branches）、源仓库 Contents:read、
Pull requests:write、Issues:write（labels）、Metadata:read、Actions/Checks:read（check/workflow evidence）、
Organization Members:read（team/reviewer 解析）。产品仓模板不含 workflow，故不要求目标仓
Workflows:write。平台 workflow source repo 必须与目标仓 visibility 兼容，并在 Actions 设置中允许同组织
其他仓库访问；否则 preflight `blocked`。
环境 secret **不在 M2 token 范围**（只报告缺项；移动签名隔离 → M7）。安全：模板源仓必须在 allowlist，
**禁止从 PR / 任意 URL / 本地相对目录加载可执行模板**；生成路径 POSIX normalize + root containment，
拒 symlink / `..` / NUL / 大小写碰撞；commit message / PR body / labels / YAML 用结构化 API 不拼 shell；
日志 redact 凭据。

### 2.8 `product-init.yaml`（`--config` schema）

```yaml
schema_version: 1                      # const 1，必填
repository:
  description: "Demo product monorepo" # 可选
  visibility: private                  # private|internal|public，默认 private（与 CLI flag 二选一，冲突即报错）
bootstrap:
  approvers: [platform-admins]         # ≥1 team slug；Bootstrap PR 的合规批准人（非作者）
owners:                                # CODEOWNERS 区域 → team slug（§3.3）
  product: product-team
  api: api-owners
  design: design-team
  admins: platform-admins
  backend: backend-team                # apps/* 目录 M3 才生成，但 owner 现在登记
  web: web-team
  ios: ios-team
  android: android-team
team_permissions:                      # repository permission desired state（D13：只赋权不建 team）
  platform-admins: maintain
  product-team: push
  api-owners: push
  design-team: push
  backend-team: push
  web-team: push
  ios-team: push
  android-team: push
environments:                          # 可空；M2 只配可声明的 protection，不写 secret
  preview: { reviewers: [product-team], prevent_self_review: true }
required_secrets: []                   # 只用于 dry-run 报告缺项；M2 不创建/轮换 secret（→ M7）
```

校验规则（写前，失败 → `2`/`3`）：`schema_version==1`；unknown key 拒绝；`owners` 必须覆盖
`product/api/design/admins` 四个必需区域（apps/* owner 可选，缺省回退 `admins`）；`team_permissions`
的 permission ∈ `{pull,triage,push,maintain,admin}`；同一 team 不得重复；每个被引用的 team（owners /
team_permissions / bootstrap.approvers / environment reviewers）必须**已存在、可见且 ≥1 active
member**（D13），否则 `blocked`；environment reviewer 数不超 GitHub 限制且对仓库有 read；`visibility`
与 CLI flag 若都给出必须一致。

## 3. Gate 体系的 GitHub 侧配置（支撑 §1 provenance）

### 3.1 Labels（M2 创建两族）

- **Gate（provenance，5 个固定）**：`gate:spec`、`gate:architecture`、`gate:design`、`gate:plan`、
  `gate:contract`。`gate:contract` 仅占位（Contract Gate workflow 在 M4.5）。版本 label `version:v<n>`
  由后续 Gate PR 流程按需 upsert（D5），不预创建。
- **Issue/backlog（手册 §5.3）**：`platform:{backend,web,ios,android}`、
  `track:{spec,design,contract,code}`、`type:{epic,task,change}`、`status:blocked`。

label desired state 含固定 name/color/description；同名属性漂移执行 update，**未知 label 保留**
（不破坏性清理）。

### 3.2 Rulesets（两资源、两阶段，依据 §5.3 + plan §1）

产品仓 repository ruleset 稳定名 `sdd-main`，target `refs/heads/main`，active，无 bypass actor：

| 规则 | 初始 ruleset（init 第 3 步） | 最终（`--finalize-protection`） |
|---|---|---|
| 禁直推 / 禁 force push / 禁 deletion | ✅ | ✅ |
| 要求 PR + ≥1 人工 approval | ✅ | ✅ |
| 要求对应 **CODEOWNER** 批准 | ✅（兜底 CODEOWNERS 已在 `main`，admins 可满足 Bootstrap PR） | ✅ |
| **stale review dismissal** | ✅ | ✅ |
| review threads resolved | ✅ | ✅ |
| required status checks `CI Gate` + `PR hygiene`（绑 integration_id） | ❌（context 尚不存在） | ✅（D10） |

stale dismissal + CODEOWNER 共同保证"批准绑定最终 head SHA"（provenance 第 1 步）。

required workflows 属于另一个**organization ruleset**，稳定名 `sdd-workflows-<repository-id>`：

| 属性 | Bootstrap PR 前 | finalize 后 |
|---|---|---|
| repository condition | 精确目标 repo name | 不变 |
| branch condition | `refs/heads/main` | 不变 |
| workflow source | 平台 repo id + path + pinned SHA | 不变 |
| enforcement | `evaluate`（运行、不阻塞） | `active`（merge-blocking） |

Factory 不修改共享/未知 org ruleset，也不把多个产品仓塞进同一受管 ruleset；同名但 source/target 不符
视为 conflict。该规则必须在 Bootstrap PR 创建前进入 evaluate，否则已打开 PR 不会自动触发 workflow。

### 3.3 CODEOWNERS（Bootstrap PR 目标态，含对 §5.3 的补齐）

```text
*               @<org>/<admins>
/specs/         @<org>/product-team
/projects.yaml  @<org>/product-team     # §5.3 漏列的根文件，补
/contracts/     @<org>/api-owners
/design/        @<org>/design-team
/AGENTS.md      @<org>/product-team
/.github/       @<org>/<admins>
/template.lock  @<org>/<admins>
/apps/backend/  @<org>/backend-team     # 目录 M3 才生成，规则先就位
/apps/web/      @<org>/web-team
/apps/ios/      @<org>/ios-team
/apps/android/  @<org>/android-team
```

owner handle 必须带 org 且 team 可见；用 CODEOWNERS parser fixture 验证每个受管 path 恰有最终 owner。

### 3.4 `CI Gate` / `PR hygiene`（平台仓托管的 required workflows）

两个 workflow 都位于**平台仓** `.github/workflows/`，经 ruleset 固定 `repo/path/sha` 关联到产品仓
（D7 / §3.6），产品仓内**无副本**。`CI Gate`（最小 / no-op 聚合，结构对齐 M4 §9）：

```yaml
# 平台仓 .github/workflows/ci-gate.yml
name: ci-gate
on: pull_request          # 只读；无 secret；不 checkout/执行产品 PR blob（D10）
jobs:
  detect:                 # M2 stub：输出四平台全 false；M4 填路径规则 + sdd impact
    ...
  CI Gate:                # job name = required-check context（D8，冻结）
    needs: [detect]       # M4 把平台 job 加进 needs
    if: always()
    # 按 §9 真值表读 needs.*.result；M2 无平台 job → 无 detected 失败 → pass
```

`PR hygiene`（job name 冻结 = `PR hygiene`）：checkout 平台仓自身的 pinned SHA 取 `sdd` →
`pnpm install --frozen-lockfile` → `sdd gate hygiene --repo <产品仓> --pr <n>`（经 API 读 PR，§3.5）。
**check 名冻结**（D8），M4 在同名 job 下加 detect / 平台矩阵。可信性由 §3.6 保证。

### 3.5 `PR hygiene`（校验项，依据 plan §M2）

`sdd gate hygiene --repo <o/n> --pr <n>`（octokit + `GITHUB_TOKEN`）。非 Gate PR（无
`gate:*` label，如 Bootstrap PR）只做通用校验并通过；有 `gate:*` label 时逐项校验：

1. **Gate 类型/版本**：恰一个 `gate:<gate>` label；marker 可解析且 `marker.gate==label`；
   `marker.version` 形如 `^v\d+$`；所有变更的 `specs/**` 路径都在 `specs/<version>/` 下；有
   `version:*` label 时一并核对一致。
2. **必需产物**（须在 changed files 中）：spec→`specs/<v>/spec.md`；architecture→
   `specs/<v>/architecture.md` + `projects.yaml`；design→`specs/<v>/design.md`（+ 建议
   `design/tokens/**`）；plan→`specs/<v>/plan.md`。
3. **稳定 ID**：spec 含 ≥1 `REQ-…`；design 含 ≥1 `SCR-…`；引用的 operationId 格式合法且同文档唯一。
4. **上游批准引用**：architecture/design/plan 的 `marker.upstream_approvals` 指向的 PR/SHA 存在、
   已合入 `main`、带正确 `gate:*` label；plan 无 UI 时 `design=skipped` 且 `skip_design_gate_reason`
   非空。
5. **对应 CODEOWNER**：变更路径落在与该 Gate 匹配的 CODEOWNERS 规则下（spec/arch/design/plan →
   `/specs/`，architecture 另含 `/projects.yaml`），即"由正确的 owner 审"（实际批准由 ruleset/
   provenance 判，hygiene 不把"owner 字符串存在"当批准）。
6. **读取方式**：changed files 用完整 pagination 读取，blob 以 PR head SHA 取；检测 rename/removed/
   truncated diff 时走 blob API，不只信 patch 字段。
7. **fail closed**：解析/API/任一校验失败 → 非零退出（红 check）。

> M2 不实现 contract 专属规则（"`gate:contract` PR 须带 success 的 `Contract Gate` check"），该规则
> 随 Contract Gate workflow 一并在 M4.5 落地；M2 仅保留 `gate:contract` label 与 enum。

### 3.6 执行拓扑与 check 可信性（D7 / D10）

仅按 check **name** 要求可被伪造——PR 可新增一个发同名 check 的 workflow 自满足。M2 用**单一可信
来源**消除该入口：

- **唯一产出者**：`CI Gate` 与 `PR hygiene` **只**由平台仓 `.github/workflows/{ci-gate,pr-hygiene}.yml`
  产生（§3.4）。**产品仓不含任何 gate workflow**，因此不存在"两个 workflow 产生同名 check"或"本地
  workflow 被 PR 改成伪造入口"。
- **绑定 + 固定**：产品仓 `sdd-main` 的 required status check 绑 GitHub Actions **integration_id**；
  专用 organization ruleset 的 required workflows 固定平台仓 `repository_id + path + sha`。组织不支持
  org ruleset workflow/evaluate 或 Factory 无 org ruleset 管理权限 → **生产模式 fail closed**。
- **workflow 最小权限**：`on: pull_request`（非 `pull_request_target`），`GITHUB_TOKEN` 仅
  `contents:read, pull-requests:read`，无 secret/cache，**不 checkout/执行产品 PR blob**；产品 PR 文件
  只经 API 当数据读；`PR hygiene` checkout 的是**平台仓自身的 pinned SHA**（取 `sdd`），**不依据 PR 可
  改的 `template.lock` 选码**。
- **产出 vs 阻塞**：`init` 在 Bootstrap PR 创建前创建/认领专用 organization ruleset，设为
  `evaluate`；Bootstrap PR 的 `opened` 事件触发平台 workflows，失败也不阻塞初始人工流程。
  `--finalize-protection` 验证同一最终 head 上的成功 evidence 后，把 org ruleset切为 `active`，再把
  对应 context 加入产品仓 `sdd-main` required status checks（绑 integration_id）。若 PR 早于 evaluate
  ruleset 创建，Factory 不假定 workflow 会补跑，而是 `blocked` 并要求推新 commit 或重开 PR；正常实现
  顺序禁止出现该状态。
- **M4 迁移护栏**：扩 CI 时保留 `CI Gate` context，先让新平台 workflow 在 PR 上真实成功，再更新
  required workflow 的 pinned SHA，避免再次制造 required-check 自举死锁。

## 4. M2 如何接入授权记录（provenance metadata）

M2 **不建仓内账本**（plan §1）；gate-merge 后产出的 **GitHub 原生元数据**即 `@sdd/provenance`
（M1）的 `verifyGateApproval` 校验对象。M2 的职责是"让这些元数据在 PR 时即齐备且自洽"，使消费端
（M3/M5）能仅凭 GitHub API 复算，不信任工作区文件。映射：

| provenance 校验（m1 §4） | M2 提供的保障 |
|---|---|
| 1. PR 合入受保护 `main`，最终 head SHA 获 CODEOWNER 批准 | ruleset：CODEOWNER required + stale dismissal（§3.2） |
| 2. `gate:<gate>` label 与 version 一致（仅辅助核对） | `gate:*`(+`version:*`) label（§3.1）+ PR hygiene 强制 label↔marker↔path（§3.5.1，D5） |
| 3. `artifactPath` 在该 PR changed files 中 | PR hygiene 必需产物 ∈ changed files（§3.5.2，全分页/blob 读 §3.5.6） |
| 4. 后续 Gate 沿用产物可追溯到上游批准 | PR hygiene 校验 `upstream_approvals`（§3.5.4） |
| 5. contract gate 的 `Contract Gate` check evidence | M2 保留 label/enum + integration_id 防伪机制；contract check 规则 M4.5 落地 |
| 6. fail closed | PR hygiene 与 finalize 均 fail closed |

净效果：每个 Gate PR 合并后，`{gate, version, pr, approved_head_sha, merge_commit_sha, approved_at}`
（contract 另含 `required_checks`）可由 GitHub 完整复算。**M2 止于"元数据齐备且可验证"；在
scaffold/publish 处强制调用是 M3/M5。** 禁止新增 `approvals.yaml` / `gate-ledger.json` 等可被后续 PR
改写的自证账本。

## 5. 测试与验收（vitest 单测 / 契约 / E2E）

### 5.0 单测与契约测试（vitest）

- **resolve / manifest / lock**：ref→完整 commit、annotated tag peel；manifest missing/extra file、
  checksum mismatch → fail closed；render token 残留/缺失失败；CRLF/binary/mode/symlink/traversal/
  collision 拒绝；canonical YAML/JSON round-trip。
- **plan / 确定性（D12）**：固定排序、`operation_id` 稳定、每种 disposition、无 volatile 字段、
  text/json 同 model；dry-run 两次 **byte-identical**；recording transport 断言 **mutation count=0** 且
  网络层拒绝写 method。
- **snapshot（空仓库 bootstrap，D9）**（mock octokit / HTTP fixture）：Contents seed 建 main →
  Git Data blobs→tree(base=seed)→commit→**仅当 main 仍指向 seed 时**非 force 前进；写入文件集 == 渲染后
  `monorepo-root`、无 `apps/*`；对已存在仓按 marker/lock 安全 resume 或 conflict。
- **reconcile / github-config**（mock octokit）：labels 两族齐全；**teams 只校验+赋权、不创建**（D13），
  team 缺失→blocked；产品仓初始 ruleset **不含** required status checks；专用 org workflow ruleset在
  PR 前为 evaluate 且 target/source 精确；finalize 仅在证据全成立后切 active，并给 `sdd-main` 加
  `CI Gate`+`PR hygiene` context + integration_id，且幂等。
- **失败注入矩阵（D11）**：每个 mutation 后注入一次 crash 并用同输入重跑（repo 后 / seed 后 / 部分
  blob 后 / tree 后 / commit 后 / ref update 前后 / 各配置中途 / org evaluate ruleset 前后 / PR create
  前后 / check 绿后 org active 与 repository ruleset update 前后）；
  断言最终唯一 repo / 受管 ruleset / Bootstrap PR，`main` 不 force，未知资源不删。
- **防伪 / 边界（D10）**：workflow 或 check name spoof、check 仅旧 SHA 成功、approval stale、非
  CODEOWNER、PR 改 workflow、并发两 init、分页第二页失败、main 被人推进、template.lock 被改 → 均
  前向收敛或明确 conflict/blocked，不静默覆盖。
- **gate hygiene（表驱动）**：spec/arch/design/plan 合法 PR → pass；缺必需产物 / label↔marker 不符 /
  version↔path 不符 / 缺 `REQ`/`SCR` / 上游引用缺失或未合并 / 无 UI plan 缺 skip-reason / CODEOWNERS
  映射错 / API 抛错 → fail；非 Gate PR → pass。
- **模板自测**：`monorepo-root/projects.yaml` 过 `sdd validate`；Issue form / PR 模板 / workflow YAML
  合法；CODEOWNERS 可解析且每受管 path 恰有 owner；**守卫测试断言 job name 恰为 `CI Gate` /
  `PR hygiene`**（防 M4 改名漂移，D8）；manifest 与模板树无漂移。

### 5.1 隔离 org E2E（手动/CI 编排，非 vitest）

在**专用测试 org**用唯一 repo 名跑（harness 负责事后清理，factory 自身不删，D11）：

1. **dry-run ×2 → byte-identical**；API recorder 断言**零 mutation**。
2. **首次真跑停在 `AWAITING_HUMAN`（exit 4）**：核验 `main` 含 seed+snapshot 两 commit（D9）、控制
   骨架齐全、`projects.yaml.components == []`、**无 `apps/*`**；labels 两族齐全；team 只赋权未新建
   （D13）；environments；初始 ruleset **无 required checks**。
3. **Bootstrap PR**：先 read-back 专用 org workflow ruleset 为 `evaluate` 且 target/source 精确，再观察
   其产出的 `CI Gate` / `PR hygiene` **绑定最终 head SHA 且绿**；由测试身份**人工式**批准 + merge
   （**factory 不自批**）。
4. **第二次 `init --finalize-protection`**：read-back org workflow ruleset 已切 `active`；产品仓
   `sdd-main` required status checks + integration_id 已生效；source `repo/path/sha` 未漂移。
5. **再重跑 `init` → 全 `noop`**（幂等）。
6. **直接 push `main` 被拒**；新建一个 root/no-op PR，两个 required checks 绿后可合并。
7. **同名 check spoof 反例**：用测试开关让受信平台 `CI Gate` 失败，同时在产品 PR 新增一个由 GitHub
   Actions 发出的同名成功 check；断言专用 org ruleset仍因 pinned workflow 失败而阻止 merge，不能用
   同 integration 的伪造成功结果替代（验证 D10 / §3.6）。
8. **崩溃恢复抽样**：在 seed 后 / snapshot ref 前杀进程并同输入重跑 → 前向收敛，唯一 repo/PR、`main`
   不 force。

E2E 用最小权限专用 App、无生产 secret；repo 名 / operation_id 入测试报告，失败保留现场。

## 6. 交付文件树

```text
sdd-platform/
├─ templates/monorepo-root/**                     # §1 产品仓模板（不含 gate workflow）
├─ templates/monorepo-root.manifest.json          # 生成（§2.4）
├─ scripts/build-template-manifest.ts             # pnpm run build:template-manifest
├─ .github/workflows/{ci-gate.yml, pr-hygiene.yml}  # 平台仓托管的 required workflows（§3.4/§3.6）
├─ factory/{package.json, tsconfig.json, src/**, test/**}   # §2.5
└─ cli/src/commands/{product/init.ts, gate/hygiene.ts} + test/**
```

## 7. M2 完成定义（DoD）

- `sdd product init --dry-run` 产出 §5.1 完整报告、确定性 byte-identical、**零 GitHub 写**（已验证）。
- `sdd product init`（mock/HTTP fixture 单测 + §5.1 隔离 org E2E）完成第 1–5 步：建仓 → Contents
  seed → Git Data 快照建 `main`（D9）→ 两族 labels / teams(校验+赋权) / env / 关联平台 required
  workflows 的专用 org ruleset（evaluate）/ 产品仓初始 ruleset → Bootstrap PR。
- `sdd product init --finalize-protection` 仅在证据全成立后把 org workflow ruleset切 active，并给产品仓
  ruleset 加固 required checks + integration_id；两者幂等、fail closed。
- `monorepo-root` 模板完整（§1 全部文件，**不含 gate workflow**）并自校验：`projects.yaml` 过
  `sdd validate`；YAML/表单合法；check 名冻结守卫通过。
- Bootstrap PR 上**平台 required workflows** 产出 `CI Gate` + `PR hygiene` 真实 check context 且通过
  （§12.1、§12.4 根骨架侧）。
- `sdd gate hygiene` 覆盖 §3.5 全部规则并 fail closed，单测齐全。
- `template.lock` 含来源 provenance；checksum 校验强制且有测试。
- 可重入/恢复/并发：失败注入矩阵与防伪/边界测试通过；默认不回滚（D11）。
- 工作区全绿：`pnpm install --frozen-lockfile` + `pnpm -r build && typecheck && test && lint`，无生成漂移。

## 8. 验收映射与依赖

**§12 场景**：

- **§12.1** —— Bootstrap PR 产生真实 `CI Gate`/`PR hygiene` context，绿且经可信性核验后，经
  `--finalize-protection` 加固 required（§2.3 / §3.2 / §3.6 两阶段）。
- **§12.2** —— `init` 只建控制骨架 + `components: []`，不生成 `apps/*`（§1.2 / §2.3 第 4 步树校验）。
- **§12.4（根骨架侧）** —— 根骨架 PR 的 `CI Gate` 成功（§3.4）。**"空 scaffold 的 CI Gate"那一半依赖
  M3 的 scaffold**，M2 不覆盖。

**依赖 M1**：`@sdd/schemas`（`projects.schema` + 模板 `projects.yaml`）、`sdd validate`（CI/模板自测）、
`@sdd/provenance`（M2 不调用，但 labels/marker/changed-files/CODEOWNER/stale-dismissal 必须对齐其读取
模型，见 §4）。M1 的 `factory` 占位 → M2 补全。

> **M1 provenance 现状（已核 `m1-foundations`）**：早期 `getCodeownerApproval` 曾硬编码 `projects.yaml`
> 忽略 `artifactPath`；该问题已在 M1 加固提交（`a71187c` / `37e5206`）修复——现 `verify.ts` 经
> `findLastMatchingCodeownersEntry(codeowners, artifactPath)` 正确处理 last-match-wins + base-commit
> CODEOWNERS + team 成员解析。故**非 M2 阻塞**；M2 模板/marker 与之对齐即可。实现者仍须以最终 M1
> commit 复核 package exports。

## 9. 不在 M2 范围

- 平台模板（spring-boot/web/ios/android）与 `sdd product scaffold`、生成 `apps/*` → **M3**。
- reusable 平台 workflow（java/web/ios/android）、`detect` 路径规则、`sdd impact`、`CI Gate`
  平台矩阵聚合 → **M4**。
- Contract Gate workflow（OpenAPI lint/breaking diff/client 生成）与 hygiene 的 contract 专属规则 →
  **M4.5**（Contract Gate）；provider conformance（Backend Implemented Gate）→ **M6**。M2 仅保留
  `gate:contract` label/enum。
  > 注：本仓 [implementation-plan.md](implementation-plan.md) §2 目前仍把二者合并标为"M6 — Contract-first"，
  > 与总规划"M4.5 Contract Gate / M6 provider conformance"不一致；本文按总规划取 M4.5，待 plan 层校正后回链。
- 在 scaffold/publish 处**强制调用** provenance → **M3/M5**；M2 只保证元数据可被校验。
- Backlog compiler / Issue upsert / impact 的 Issue 归并 / Projects 看板自动化 → **M5**。
- `sdd sync --check` 与模板安全更新同步 → **M8**；release/tag/签名隔离与 secrets 创建/轮换 → **M7**。
- **创建或修改 org teams / membership**（M2 只校验已存在 team 并赋 repo 权限，D13）→ org 管理。
- SDK registry 发布、跨仓 `repository_dispatch`、Terraform/Pulumi、GitHub Template repo 机制
  （手册 §1 明确排除）。
- 平台仓自身的 TS workspace CI（与产品模板 `.github/` 无关）。

## 10. 待决事项（实现前需确认）

1. **required workflows 能力**：目标 org/plan 必须支持 organization ruleset required workflows 与
   `evaluate` enforcement，并允许平台 workflow source repo 被组织内目标仓访问。不满足则生产 fail
   closed；实现前在隔离 org 做 capability probe。
2. **Factory 生产身份**：GitHub App（推荐）还是首版 PAT；若 PAT，需定 fine-grained/classic 的建仓与
   **organization ruleset 管理**权限并在隔离 org 验证（§2.7）。
3. **D5 版本标识**：保留 `version:v<n>` label（GitHub 原生交叉核对）还是纯靠 `path + marker`。
4. **environments 首批默认集合 / reviewers**；M2 不写 secret，`required_secrets` 仅报告。

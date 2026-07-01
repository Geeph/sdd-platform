任务：实现 sdd-platform M2 的第三阶段 **M2c**（仅 M2c，收尾 M2）。前提：M2a + M2b 已在 `m2-foundations` 分支落地
（模板/manifest/lock、纯 compiler、dry-run、read adapter、repo+seed+snapshot 写 adapter 与到 SNAPSHOT_MAIN 的状态机）。

## 分支
在 `m2-foundations` 上追加 M2c 提交；不要改 docs/sdd/m2-foundations.md（除非发现规格缺陷——见末尾）。

## 权威规格
docs/sdd/m2-foundations.md。重点：§2.3 第 6–7 步 + finalize、§2.5 公共接口剩余部分、§2.6 后段 phase、§2.7 权限、§3 全章
（§3.1 labels、§3.2 两资源两阶段 ruleset、§3.3 CODEOWNERS、§3.4 平台 workflow、§3.5 PR hygiene、§3.6 执行拓扑/防伪）、
§4 provenance、§5.0 剩余测试 + §5.1 E2E、§7 DoD、§8 验收。背景：runbook §5.2/§5.3/§6.1–6.3/§12。

## M2c 范围（D14 第三段）
交付：labels/teams/environments、产品仓 ruleset、专用 org workflow ruleset、Bootstrap PR、CI Gate / PR hygiene、finalize 与隔离 org E2E。

### 必须交付
1. `factory/src/github-write.ts` 扩展 reconcilers：`reconcileLabels`（§3.1 两族 label）、`grantTeamPermissions`
   （**只校验已存在 team 并赋权，不创建/不改 membership**，D13）、`reconcileEnvironments`、`reconcileRepositoryRuleset`
   （产品仓 `sdd-main`，§3.2 两阶段）、`reconcileOrgWorkflowRuleset`（`sdd-workflows-<repository-id>`，repo+branch 精确 condition、
   workflow 固定平台 repo_id+path+sha、`evaluate→active`，§3.2/§3.6）、`upsertBootstrapPull`（基于 main 建 `sdd/bootstrap` 分支，
   写 §3.3 分区 CODEOWNERS + 产品配置，创建 Bootstrap PR）。每个 reconciler 读全分页、按稳定 key upsert、写后 read-back、不删未知配置。
2. 平台仓 `.github/workflows/ci-gate.yml`（job name **`CI Gate`**，§3.4 结构）+ `.github/workflows/pr-hygiene.yml`
   （job name **`PR hygiene`**）：`on: pull_request`，权限仅 `contents:read, pull-requests:read`，无 secret/cache、不 checkout/执行
   产品 PR blob；pr-hygiene checkout 平台仓自身 pinned SHA 取 sdd 后 `sdd gate hygiene`。
3. `sdd gate hygiene` 命令 + `factory/src/gate-hygiene.ts` 的 `checkPrHygiene`：实现 §3.5 全部规则（gate 类型/版本 label↔marker↔path、
   必需产物 ∈ changed files、稳定 ID、上游批准引用、对应 CODEOWNER、全分页/blob 读、fail closed）。非 Gate PR 只做通用校验放行。
4. `factory/src/init.ts`：`applyInitPlan` 续接 `SNAPSHOT_MAIN → REPO_CONFIGURED → ORG_WORKFLOWS_EVALUATING →
   BOOTSTRAP_PR_OPEN → AWAITING_HUMAN`（第 6–7 步，org ruleset 必须先于 PR 进入 evaluate）；`finalizeProtection` 实现
   `BOOTSTRAP_MERGED → CHECKS_VERIFIED → ORG_WORKFLOWS_ACTIVE → REPO_RULESET_HARDENED → COMPLETE` 与 `--finalize-protection` CLI。
   退出码按 §2.1。
5. preflight/权限（§2.7）扩展：team 存在且 ≥1 active member、env reviewer、**org ruleset 管理权限**、required-workflow + evaluate
   能力 probe（不支持 → 生产 fail closed）、平台 source repo 对组织内仓库可访问；App 覆盖“尚不存在”的新仓。

### 必须遵守的不变量
- **两阶段保护**：init 阶段产品仓 `sdd-main` 无 required status checks；org workflow ruleset 设 `evaluate`（运行不阻塞）且
  **先于 Bootstrap PR 创建**。finalize 仅当证据全成立才加固：PR 已 merged 到 main、approval 针对最终 head SHA、reviewer 非作者且
  为 bootstrap approver、两 check run 的 head_sha=最终 head/conclusion=success/app.id=GitHub Actions、workflow run 来自 org ruleset 当前
  固定的平台 repo/path/SHA、org ruleset 仍 evaluate 且 target 精确、merge commit 可达 main → 先切 org ruleset 为 `active`，再给
  `sdd-main` 加 `CI Gate`/`PR hygiene` context + integration_id；两份 ruleset read-back；能力/权限不足 **fail closed**，不伪报完成。
- **防伪（D10/§3.6）**：唯一可信产出者是平台仓 pinned workflow；integration_id 绑定是必要非充分，真正闸门是 org required workflow。
  Factory 不改共享/未知 org ruleset、不把多个产品仓塞进同一受管 ruleset；同名但 source/target 不符即 conflict；repo rename 致 name
  condition 失配视为 drift/conflict，不自动改 target。
- **provenance 接入（§4）**：只产出 GitHub 原生元数据，**不建任何仓内账本**（approvals.yaml/gate-ledger.json 等）。
- D11 幂等/恢复/并发、D13 teams 只校验、check 名冻结（D8）一律延续；InitResult 不返回 token/secret/headers。

### 测试（vitest + E2E）
- **reconcile/github-config（mock octokit）**：labels 两族；teams 只校验+赋权、缺失→blocked；`sdd-main` 初始无 required；
  org workflow ruleset PR 前为 evaluate 且 target/source 精确；finalize 仅证据全成立后切 active 并加 context+integration_id，幂等。
- **防伪/边界（§5.0 D10）**：workflow/check name spoof、check 仅旧 SHA 成功、approval stale、非 CODEOWNER、PR 改 workflow、
  并发两 init、分页第二页失败、main 被推进、template.lock 被改 → 前向收敛或 conflict/blocked，不静默覆盖。
- **失败注入**续接 org evaluate/active 与 ruleset 加固前后各阶段。
- **gate hygiene 表驱动**（§3.5 全部正/反例）；**守卫测试断言 job name 恰为 `CI Gate`/`PR hygiene`**（D8）。
- **隔离 org E2E（§5.1 八步）**：dry-run×2 byte-identical 零写 → 首跑停 AWAITING_HUMAN 校验骨架/labels/teams/初始 ruleset →
  Bootstrap PR 上 evaluate ruleset 产出绑定最终 head 的绿 check、人工式批准合并（factory 不自批）→ finalize 切 active + sdd-main
  加固 read-back → 重跑 noop → 直推 main 被拒 → **同名 check spoof 反例**（让受信平台 CI Gate 失败、PR 另发同名成功 check，断言
  org ruleset 仍阻止 merge）→ 崩溃恢复抽样。

### DoD（M2c = M2 收尾，§7 全量）
`sdd product init` 完成第 1–5 步（建仓→seed→快照→labels/teams/env/org evaluate ruleset/产品仓初始 ruleset→Bootstrap PR）；
`--finalize-protection` 证据全成立后切 active 并加固，幂等 fail closed；§12.1/§12.2/§12.4 根骨架侧通过；spoof 反例通过；
`pnpm install --frozen-lockfile` + `pnpm -r build && typecheck && test && lint` 全绿、无 drift。

### 不要做
M3+ 的一切（平台模板/scaffold/apps/*、M4 detect/impact/平台矩阵、M4.5 Contract Gate workflow、M5 backlog、M6/M7/M8）；
不在 scaffold/publish 处强制调用 provenance（M3/M5）；不创建/改 org team membership；不改 implementation-plan.md。

### 提交与验证
小步提交，注明属 M2c。完成后贴：改动文件树、`pnpm -r test` 结果、隔离 org E2E 的执行记录（含 spoof 反例被挡的证据）。
发现规格矛盾/不可实现处（尤其 required-workflow evaluate 能力、App 建仓权限），**停下说明**，不要静默偏离。
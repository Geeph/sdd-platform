任务：实现 sdd-platform M2 的第二阶段 **M2b**（仅 M2b）。前提：M2a 已在 `m2-foundations` 分支落地（模板/manifest/lock、
配置 schema、纯 plan compiler、CLI dry-run、GitHubReadPort 只读 adapter、写侧类型声明）。

## 分支
在 `m2-foundations` 上追加 M2b 提交；不要改 docs/sdd/m2-foundations.md（除非发现规格缺陷——见末尾）。

## 权威规格
docs/sdd/m2-foundations.md。重点：§0（D9 空仓库 bootstrap、D11 状态机、D12、D13）、§2.3 第 1–5 步、§2.5 公共接口
（GitHubWritePort 的 seed/snapshot 部分、applyInitPlan）、§2.6 恢复/幂等/并发、§5.0（snapshot/失败注入相关）。背景：
single-repo-implementation-runbook.md §5.2。

## M2b 范围（D14 第二段）
交付：Contents seed + Git Data bootstrap、状态机与失败恢复。**不含任何 GitHub 配置**
（labels/teams/environments/产品仓 ruleset/org workflow ruleset/Bootstrap PR/平台 workflow/gate hygiene/finalize 都属 M2c）。

### 必须交付
1. `factory/src/github-write.ts`：octokit 写 adapter，**仅** repo 创建 + Contents + Git Data refs/branches 三类端点：
   `createRepository`、`seedMainViaContents`、`publishSnapshot`。不要实现 labels/teams/env/ruleset/PR 端点。
2. `factory/src/init.ts`：`applyInitPlan` 覆盖 §2.6 状态机的 `PLANNED → REPO_CREATED → SEED_MAIN → SNAPSHOT_MAIN`
   （含设 default branch、把临时 description marker 换成配置值、recursive 读回重算 output checksum）。本阶段到 SNAPSHOT_MAIN
   即停，`InitResult.nextAction` 标明“配置阶段待 M2c”；真实 CLI `sdd product init`（非 dry-run）跑到此边界并清晰返回，
   **绝不尝试任何配置写**。
3. preflight（§2.3 中与本阶段相关的）：复用 M2a 的模板 resolve/checksum；目标 repo 名校验、存在性/本次 partial-state
   判定（operation_id marker）、token 对 repo+contents+git data 的能力。team/env/ruleset 能力检查留 M2c。

### 必须遵守的不变量
- **空仓库 bootstrap（D9）**：先 Contents API 写最终 template.lock 作 seed commit 建 main，再 Git Data
  `createBlob*→createTree(base=seed)→createCommit(parent=seed)→非 force 前进 ref`。最终 main 含 seed+snapshot 两 commit。
  **绝不**对空仓库直接建 ref。
- **ref 前进安全**：仅当 main 仍指向 seed 时前进到 snapshot；已是 snapshot→noop；其他 SHA→conflict，**绝不 force**。
- **可重入/幂等（D11）**：phase 由 GitHub 实际状态推导，无本地 checkpoint；重跑用同一输入收敛；create/update/noop/conflict/blocked；
  已存在仓仅在 marker 或 template.lock 与本 operation 对应时 resume，否则 conflict。**默认不删仓 / 不关 / 不 force / 不回滚**。
- 并发：无本地锁，靠 GitHub 条件更新（repo name 唯一、ref 非 force 前进、branch compare-and-set）；竞争失败重新 observe/replan。
- 重试：429/5xx 按 Retry-After + capped backoff+jitter；mutation 仅在已知幂等或重试前可 GET 确认时重试；403 secondary 不盲重放。
- 沿用 Node 24 / pnpm frozen / tsup / vitest / biome；复用 M1 与 M2a 的导出，不复制逻辑。
- snapshot tree 写入前核对 path/mode/blob、**无 `apps/*`**；InitResult 不返回 token/secret/headers。

### 测试（vitest，§5.0 属于 M2b 的部分）
- **API contract tests（HTTP 边界 fixture，如 nock/MSW，而非只 mock 高层函数）**：empty-repo Contents seed；Git Data
  blobs/tree(base=seed)/commit/非 force ref 前进；真实 request body + API version + 分页 Link。
- **失败注入矩阵**：在 repo 后 / seed 后 / 部分 blob 后 / tree 后 / commit 后 / ref update 前后各注入一次 crash 并同输入重跑 →
  最终唯一 repo、main 不 force、未知资源不删、收敛为一致 main。
- **resume/conflict**：已存在仓 marker/lock 匹配→resume；不匹配/无关 SHA→conflict；并发两 init→条件更新不互相覆盖。

### DoD（M2b）
contract + crash 矩阵全过；对 fixture/隔离仓真跑能幂等建出 repo + main（seed+snapshot 两 commit）且不写任何配置；
`pnpm install --frozen-lockfile` + `pnpm -r build && typecheck && test && lint` 全绿；生成物无 drift。

### 不要做
labels/teams/environments、产品仓 `sdd-main` ruleset、专用 org workflow ruleset、Bootstrap PR、平台仓
.github/workflows/{ci-gate,pr-hygiene}.yml、`sdd gate hygiene`/checkPrHygiene、finalizeProtection、隔离 org E2E、
`--finalize-protection`（均 M2c）。也不要改 implementation-plan.md。

### 提交与验证
小步提交，注明属 M2b。完成后贴：改动文件树、`pnpm -r test` 结果、一次针对 fixture 的真跑 trace（展示 seed+snapshot 两 commit 与
重跑 noop）。发现规格矛盾/不可实现处，**停下说明**，不要静默偏离。
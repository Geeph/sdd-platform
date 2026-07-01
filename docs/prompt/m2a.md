任务：实现 sdd-platform M2 的第一阶段 **M2a**（仅 M2a，不要做 M2b/M2c）。

## 分支
在已有分支 `m2-foundations` 上工作（它基于最新 origin/main，已含合并的 M1 代码 + M2 细案）。
把 M2a 实现作为该分支上的新提交追加；不要改动 docs/sdd/m2-foundations.md（除非发现规格缺陷——见末尾）。

## 权威规格
docs/sdd/m2-foundations.md 是唯一权威。重点读：§0（D1–D14，尤其 D2/D3/D7/D12/D13/D14）、§1（monorepo-root 模板）、
§2.1 命令、§2.2 dry-run JSON 契约、§2.4 manifest/template.lock、§2.5 包结构与公共 TS 接口、§2.8 product-init.yaml schema、
§5.0 测试。背景参考 docs/sdd/single-repo-implementation-runbook.md §5.1/§5.2、implementation-plan.md §M2，以及 M1 的
docs/sdd/m1-foundations.md。

## M2a 范围（D14 第一段）
交付：模板/manifest/lock、配置 schema、纯 plan compiler、CLI `sdd product init --dry-run`。
**严禁包含任何 GitHub write adapter / octokit mutation / 建仓 / seed / ruleset / Bootstrap PR / 平台 workflow 文件**
（这些是 M2b/M2c）。

### 必须交付的文件
1. `templates/monorepo-root/**`：按 §1 完整内容——specs/_template/{spec,architecture,design,plan}.md（含 §1.1 必填小节与
   稳定 ID 占位）、contracts/README.md、design/tokens/README.md、projects.yaml（产品身份用 token，渲染后 components: []）、
   AGENTS.md、README.md、.github/{ISSUE_TEMPLATE/{intake.yml,config.yml}, PULL_REQUEST_TEMPLATE/gate.md（含 §1.4 机读 marker 块）,
   pull_request_template.md, CODEOWNERS（bootstrap 兜底 `* @<org>/<admins>`）}。**产品仓模板不含任何 workflow 文件（D7）。**
2. `templates/monorepo-root.manifest.json` + `scripts/build-template-manifest.ts`（`pnpm run build:template-manifest` 生成；
   排序后 路径→mode+render?+原始 blob sha256 + tree_sha256）。
3. `factory/`（替换 M1 占位）：按 §2.5 实现 resolve.ts / render.ts / plan.ts / 以及 github-read.ts（**只读** octokit adapter，
   GET/HEAD only）；导出 §2.5 的公共类型与 `compileInitPlan`。GitHubWritePort 等写侧仅声明类型，不实现。
4. `cli/src/commands/product/init.ts`：oclif 命令，**本阶段仅实现 `--dry-run`**（text + json 两种 --format）；更新 CLI build entry/discovery。
   真实执行路径可留 `not implemented in M2a`（M2b/c 接入）。

### 必须遵守的不变量
- 复用 M1：用 `@sdd/schemas` 的 `validateProjectsDocument` 校验模板 projects.yaml，**不要复制 schema**。沿用 Node 24 / pnpm /
  tsup / vitest / biome；提交 lockfile，CI 用 `pnpm install --frozen-lockfile`。
- 确定性（D12，§2.2）：dry-run 复用纯 plan compiler，仅注入 GitHubReadPort（类型上看不到 mutation）；输出 canonical JSON
  （字段顺序/数组排序键严格按 §2.2，无时间戳/请求 id/限流/token/本地路径）；`operation_id = sha256(JCS(规范化输入 +
  resolved_commit + template.output_tree_sha256))`；相同输入两次运行 **byte-identical**；text 输出只是 model 的 renderer。
- 零写防线：dry-run 路径不构造 writer/不发任何 POST/PUT/PATCH/DELETE，不写本地状态文件/cache/lock。
- 模板 manifest/render：拒绝 symlink/submodule/目录穿越/绝对路径/大小写碰撞/非 100644|100755 mode/未列出的隐式文件；
  render 只替换 allowlist token（product/repo/owners），残留 `{{...}}` 即失败；**不执行模板代码/shell/helper**。
- template.lock：按 §2.4 canonical YAML 字段（source/template/files 的 source+output sha256、digest），自身不计入 output_tree_sha256；
  校验顺序 ref→commit→manifest→每 source blob→render output→output tree digest→lock round-trip，任一步不符 fail closed。
- ref 解析：annotated tag 递归 peel 成完整 40 位 commit；此后只按该 commit 读 blob。`--platform-ref` 在真实模式必填——但本阶段
  只做 dry-run，缺省时按 §2.1 在报告显式标注“未固定 ref，仅供预览”。
- product-init.yaml：按 §2.8 实现 schema + 校验规则（unknown key 拒绝、owners 必需区域、permission 枚举、visibility 一致性等）。

### 测试（vitest，§5.0 中属于 M2a 的部分）
- resolve/manifest/lock：tag peel、manifest missing/extra、checksum mismatch→fail、render token 残留/缺失、CRLF/binary/mode/
  symlink/traversal/collision 拒绝、canonical round-trip。
- plan/确定性：固定排序、operation_id 稳定、每种 disposition、无 volatile 字段、text/json 同 model、dry-run 两次 byte-identical；
  **recording transport 断言 mutation count == 0 且网络层拒绝写 method**。
- config schema：合法 + 各类非法（unknown key / 缺必需区域 / 非法 permission / visibility 冲突 / team 引用）。
- 模板自测：monorepo-root/projects.yaml 过 `sdd validate`；Issue form / PR 模板 YAML 合法；CODEOWNERS 可解析；manifest 与模板树无漂移。

### DoD（M2a）
`pnpm install --frozen-lockfile` 成功；`pnpm -r build && typecheck && test && lint` 全绿；生成物无 drift（重跑
build-template-manifest 后 `git diff --exit-code` 为空）；`sdd product init --dry-run --format json` 对样例 byte-identical 且零写。

### 不要做
M2b/M2c 的一切：建仓、Contents seed、Git Data 快照、labels/teams/environments、产品仓 ruleset、organization workflow ruleset、
Bootstrap PR、平台仓 .github/workflows/{ci-gate,pr-hygiene}.yml、checkPrHygiene、finalizeProtection、applyInitPlan 的真实写入。
也不要改 implementation-plan.md（M4.5/M6 校正是另一独立任务）。

### 提交与验证
小步提交，提交信息说明属于 M2a。完成后贴出：改动文件树、`pnpm -r test` 结果、一份样例 dry-run 的 json 输出。
若发现 m2-foundations.md 规格本身有矛盾/不可实现处，**停下并说明**，不要静默偏离规格。
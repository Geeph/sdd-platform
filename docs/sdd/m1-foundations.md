# M1 实施细案：基础（Schema + workspace + 授权校验库）

> 本文是 [implementation-plan.md](implementation-plan.md) 中 **M1** 里程碑的文件级实施
> 方案，评审通过后据此写码。M1 完成 = 后续所有命令（`product init` / `scaffold` /
> `backlog` / `impact`）的前置就位：可复现的 workspace、三套契约 schema、`sdd validate`，
> 以及 §1 授权溯源校验库。
>
> 本版据评审修正 6 处：基线改 Node 24 LTS；`components[].path` 加路径安全约束；授权校验
> 接口改为明确 PR/merge SHA；impact schema 定型（必填 + item 结构）；schema 文件移回包根；
> 补齐可复现构建（固定 pnpm、lockfile、frozen install、typecheck/漂移检查）。
> 二轮修正：provenance 增加"`artifactPath` 须在 Gate PR changed files 中"的校验——仅 blob
> 匹配不足以证明该文件被该 PR 审批。

## 0. 已定决策

- 语言 / 运行时：**Node.js 24 LTS + TypeScript**（strict）。Node 20 已于 2026-03 EOL，不作基线。
- 工具链：**pnpm**（workspace）/ **tsup**（build）/ **vitest**（test）/ **oclif**（CLI）。
- Lint / format：**biome**。
- TS 类型：从 JSON Schema 用 **json-schema-to-typescript** 生成，不手写。
- 授权校验库：**独立 workspace 包 `@sdd/provenance`**，供 cli / factory / backlog-compiler 共用；
  同时支持人工 Gate approval 和 Contract Gate check evidence。
- `sdd validate` 范围：默认校验 `projects.yaml`；`--kind task|impact <file>` 校验显式文件。
- **可复现构建**：根 `package.json` 用 `packageManager` 固定 pnpm 版本（corepack）；提交
  `pnpm-lock.yaml`；CI / 构建一律 `pnpm install --frozen-lockfile`。

## 1. 包结构（pnpm workspace，对齐手册 §4.1）

```text
sdd-platform/
├─ pnpm-workspace.yaml      # packages: schemas, provenance, cli, factory, backlog-compiler
├─ package.json            # 私有根包；packageManager 固定 pnpm；scripts: build/test/lint/typecheck
├─ pnpm-lock.yaml          # 提交，frozen install 依据
├─ tsconfig.base.json       # TS strict，各包 extends
├─ biome.json               # lint + format
├─ vitest.config.ts
├─ .nvmrc                   # 24
├─ schemas/                 # @sdd/schemas         3 个 JSON Schema（包根）+ ajv 校验器 + 生成的 TS 类型
├─ provenance/              # @sdd/provenance      §1 授权溯源校验库
├─ cli/                     # @sdd/cli             oclif；M1 只实现 `sdd validate`
├─ factory/                 # @sdd/factory         M1 仅建包占位（M2 实现）
└─ backlog-compiler/        # @sdd/backlog-compiler M1 仅建包占位（M5 实现）
```

> `provenance/` 是 §4.1 未单列的共享包：scaffold（factory）与 publish（backlog-compiler）
> 都要 import 授权校验，单独成包避免循环依赖。这是相对 §4.1 的有意小偏离。

## 2. 三套 JSON Schema（M1 核心）

统一 draft 2020-12，`additionalProperties: false`，用 ajv 编译为校验器，并用
json-schema-to-typescript 生成类型。**`*.schema.json` 文件放包根**（`schemas/projects.schema.json`
等），与 §4.1 / README 公开约定一致、可被外部直接消费；TS 源码在 `schemas/src/`，生成类型在
`schemas/generated/`。

> 区分职责：**schema 只管单文档的结构与字段约束**；跨文档/跨字段的**语义校验**（id 与 path
> 唯一、template↔ci 合法组合等）由 `sdd validate` 承担（见 §3）。

### 2.1 `projects.schema.json`（手册 §4.2）

| 字段 | 类型 | 约束 |
|---|---|---|
| `schema_version` | integer | `const 1`，必填 |
| `product` | string | 必填，`^[a-z][a-z0-9-]*$` |
| `repository_mode` | enum | `monorepo`，必填 |
| `components` | array | 必填，可空（init 态 `[]`） |
| `components[].id` | string | `^[a-z][a-z0-9-]*$` |
| `components[].path` | string | **`^apps/[a-z0-9-]+(/[a-z0-9-]+)*$`**——相对、限定 `apps/` 下，天然排除绝对路径与 `..` |
| `components[].template` | enum | `spring-boot` / `web` / `ios-tuist` / `android` |
| `components[].template_ref` | string | 如 `v1.0.0` |
| `components[].owner` | string | team handle |
| `components[].ci` | enum | `java` / `web` / `ios` / `android` |

component 必填：`id` / `path` / `template` / `template_ref` / `owner` / `ci`。

### 2.2 `task.schema.json`（手册 §4.3）

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | string | 点分，`^[a-z0-9]+(\.[a-z0-9-]+)+$`，如 `ios.auth.login-screen` |
| `platform` | enum | `common` / `backend` / `web` / `ios` / `android` |
| `track` | enum | `spec` / `design` / `contract` / `code` |
| `title` | string | 必填 |
| `scope` | string[] | |
| `acceptance` | string[] | |
| `references.requirements` | string[] | `^REQ-[A-Z0-9]+-\d+$` |
| `references.screens` | string[] | `^SCR-[A-Z0-9-]+$` |
| `references.operations` | string[] | operationId |
| `depends_on` | string[] | 引用其他 task id（同 id pattern） |

必填：`id` / `platform` / `track` / `title`。

### 2.3 `impact.schema.json`（手册 §10.1，本里程碑即定稿）

| 字段 | 类型 | 必填 | 阶段 |
|---|---|---|---|
| `base` / `head` | string | ✅ | commit SHA |
| `changed.requirements` / `.screens` / `.operations` | string[] | ✅ | M4 |
| `platforms.{backend,web,ios,android}` | boolean | ✅ | M4（喂 detect / §9） |
| `breaking` | boolean | ✅ | M4 |
| `affected_issues` | array | 可空 | M5 填充 |
| `suggested_change_issues` | array | 可空 | M5 填充 |

两个数组虽可空，但 **item 结构现在就定死**，M5 直接填、不破坏 schema：

- `affected_issues[]`：`{ task_id: string; issue: integer(≥1); change: 'update'|'change'|'migration' }`，必填 `task_id` / `issue` / `change`。
- `suggested_change_issues[]`：`{ task_id: string; platform: <平台 enum>; kind: 'change'|'migration'; reason: string }`，必填 `task_id` / `platform` / `kind`。

## 3. `sdd validate`（`cli/`，oclif）

- 默认：在 `--repo .`（缺省当前目录）读取并校验 `projects.yaml`（YAML→JSON 经 `yaml`，再走 ajv）。
- `sdd validate --kind task|impact <file>`：校验显式文件。
- **语义校验（schema 之外，projects.yaml 专属）**：
  1. `components[].id` 全局唯一；
  2. `components[].path` 全局唯一且互不为前缀（防嵌套覆盖）；
  3. `template` 与 `ci` 合法配对：`spring-boot↔java`、`web↔web`、`ios-tuist↔ios`、`android↔android`。
- ajv 与语义错误统一格式化为可读输出（路径 + 原因）；任一失败 **非零退出**，全部通过退出 0。

## 4. `@sdd/provenance`（§1 授权溯源校验库）

M1 只交付**库本身 + 单测**；真实 label/ruleset 接入在 M2，强制调用在 M3/M5。

接口——**目标 Gate 由明确的 PR 号或 merge SHA 指定，label 不用于定位**：

```ts
verifyGateApproval(input: {
  octokit: Octokit;          // 注入，便于测试
  git: GitReader;            // 注入：读 worktree 状态与指定 commit 的 blob
  repo: { owner: string; name: string };
  gate: 'spec' | 'architecture' | 'design' | 'plan' | 'contract';
  version: string;           // 如 v1
  approval: { pr: number } | { mergeCommitSha: string };  // 明确目标，二选一
  artifactPath: string;      // 如 projects.yaml
}): Promise<
  | { ok: true; provenance: {
      gate; version; pr; approved_head_sha; merge_commit_sha; approved_at;
      authorization_policy: 'current-codeowners';
      required_checks: Array<{ name: string; head_sha: string; conclusion: 'success' }>;
    } }
  | { ok: false; reason: string }
>;
```

内部逻辑：

1. 用传入的 `pr` / `mergeCommitSha` 唯一锁定该 PR，确认它**已合入受保护 `main`**，取
   `merge_commit_sha`、最终 head SHA 及其 CODEOWNER 批准记录；
2. **label 仅作辅助一致性核对**（`gate:<gate>` 与 version 必须匹配，否则判失败），绝不用
   label 去"搜索"PR——同一 version 可有多个已合并 Gate PR，且 label 可被改；
3. **确认 `artifactPath` 确由该 PR 审批**：它必须在该 PR 的 changed files 中（相对 base 为
   added/modified），而不仅是 merge tree 继承的历史文件——否则任意后续 Gate PR 都"包含"它
   却从未审批它；
4. 按 `current-codeowners` 策略验证批准者当前仍是有效 CODEOWNER：个人或同组织可见团队
   必须对仓库有显式 write 权限，团队成员关系分页读取；权限或成员资格被移除即撤销后续
   scaffold/publish 授权；
5. 校验本地 `artifactPath` 的 git blob 等于该 PR head/merge 版本的同路径 blob，且要求
   worktree 对该路径 clean；
6. 当 `gate='contract'` 时，读取该 PR 最终 head SHA 的 check runs，要求稳定命名的
   `Contract Gate` 存在且 conclusion 为 `success`；旧 SHA 上的成功、缺失、skipped、failure
   或 cancelled 均失败，并把成功 evidence 写入 `required_checks`；其他 Gate 的
   `required_checks` 可为空；
7. **fail closed**：API 不可用 / 证据不完整 / 任一校验不符 → `{ ok: false }`，调用方必须
   中止任何 GitHub 写操作。

> 配套（非 M1 强制）：另设一个解析步骤 `listGateApprovals({ gate, version })`，按 label +
> 已合并状态列出**候选** PR 供人/工具选定，再把选定的 `pr`/`mergeCommitSha` 交给上面的
> 校验。定位与校验分离，避免"按可变 label 自动选 PR"。

## 5. 测试（vitest）

- **schemas**：每套 schema 的 valid / invalid fixtures——空 `components` 通过；缺必填、未知
  `platform`/`template`、id pattern 不符、`path` 为绝对路径或含 `..` 均失败；impact 缺
  `base`/`head`/`breaking` 失败。
- **validate 语义**：重复 id / 重复或互为前缀的 path / `template`↔`ci` 不配对 → 非零退出。
- **provenance**（mock octokit + 假 git）：指定 PR 已合并且 CODEOWNER 批准、`artifactPath`
  在该 PR changed files 中且 blob 一致 → ok；**文件仅存在于 merge tree、不在该 PR changed
  files → fail**；label 与 gate/version 不符 → fail；过期审批 / 非 CODEOWNER → fail；
  API 抛错 → fail closed；blob 不一致 → fail。Contract Gate 另覆盖当前 approved head SHA 上
  success → ok，以及 check 缺失 / 旧 SHA success / skipped / failure / cancelled → fail。

## 6. 交付文件树

```text
sdd-platform/
├─ pnpm-workspace.yaml · package.json(packageManager) · pnpm-lock.yaml
├─ tsconfig.base.json · biome.json · vitest.config.ts · .nvmrc(24)
├─ schemas/
│  ├─ package.json · tsconfig.json
│  ├─ projects.schema.json · task.schema.json · impact.schema.json   # 包根，可直接消费
│  ├─ src/{validators.ts, index.ts}
│  ├─ generated/types.d.ts
│  └─ test/schemas.test.ts · test/fixtures/*
├─ provenance/
│  ├─ package.json · tsconfig.json
│  ├─ src/{index,verify,github,git,types}.ts
│  └─ test/verify.test.ts
├─ cli/
│  ├─ package.json（bin: sdd）· tsconfig.json
│  ├─ src/commands/validate.ts · src/index.ts
│  └─ test/validate.test.ts · test/fixtures/*
├─ factory/{package.json, src/index.ts(占位)}
└─ backlog-compiler/{package.json, src/index.ts(占位)}
```

## 7. M1 完成定义（DoD）

- `pnpm install --frozen-lockfile` 成功（lockfile 已提交、无漂移）。
- `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm -r lint` 全绿。
- **生成文件无漂移**：重跑类型生成后 `git diff --exit-code` 为空。
- `sdd validate` 对样例 `projects.yaml` 正确判定（结构非法、重复 id/path、template↔ci 不配对各一）。
- 三套 schema 定稿（含 impact 必填项与 item 结构），TS 类型由生成器产出且被各包消费。
- `@sdd/provenance` 暴露 `verifyGateApproval`，单测覆盖 §5 全部用例。

## 8. 不在 M1 范围

- `factory` / `backlog-compiler` 的真实实现（M2 / M5），M1 仅占位包。
- Gate label / CODEOWNERS / ruleset 的真实配置（M2）。
- 授权校验的强制调用点（M3 scaffold / M5 publish）。
- 平台模板（M3）、reusable workflows（M4）。

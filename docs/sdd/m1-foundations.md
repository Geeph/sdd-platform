# M1 实施细案：基础（Schema + workspace + 授权校验库）

> 本文是 [implementation-plan.md](implementation-plan.md) 中 **M1** 里程碑的文件级实施
> 方案，评审通过后据此写码。M1 完成 = 后续所有命令（`product init` / `scaffold` /
> `backlog` / `impact`）的前置就位：可复现的 workspace、三套契约 schema、`sdd validate`，
> 以及 §1 授权溯源校验库。

## 0. 已定决策

- 语言 / 运行时：**Node.js 20 LTS + TypeScript**（strict）。
- 工具链：**pnpm**（workspace）/ **tsup**（build）/ **vitest**（test）/ **oclif**（CLI）。
- Lint / format：**biome**。
- TS 类型：从 JSON Schema 用 **json-schema-to-typescript** 生成，不手写。
- 授权校验库：**独立 workspace 包 `@sdd/provenance`**，供 cli / factory / backlog-compiler 共用。
- `sdd validate` 范围：默认校验 `projects.yaml`；`--kind task|impact <file>` 校验显式文件。

## 1. 包结构（pnpm workspace，对齐手册 §4.1）

```text
sdd-platform/
├─ pnpm-workspace.yaml      # packages: schemas, provenance, cli, factory, backlog-compiler
├─ package.json            # 私有根包；scripts: build / test / lint / typecheck
├─ tsconfig.base.json       # TS strict，各包 extends
├─ biome.json               # lint + format
├─ vitest.config.ts
├─ .nvmrc                   # 20
├─ schemas/                 # @sdd/schemas         3 个 JSON Schema + ajv 校验器 + 生成的 TS 类型
├─ provenance/              # @sdd/provenance      §1 授权溯源校验库
├─ cli/                     # @sdd/cli             oclif；M1 只实现 `sdd validate`
├─ factory/                 # @sdd/factory         M1 仅建包占位（M2 实现）
└─ backlog-compiler/        # @sdd/backlog-compiler M1 仅建包占位（M5 实现）
```

> `provenance/` 是 §4.1 未单列的共享包：scaffold（factory）与 publish（backlog-compiler）
> 都要 import 授权校验，单独成包避免循环依赖。这是相对 §4.1 的有意小偏离。

## 2. 三套 JSON Schema（M1 核心）

统一 draft 2020-12，`additionalProperties: false`，用 ajv 编译为校验器，并用
json-schema-to-typescript 生成 `*.d.ts`。

### 2.1 `projects.schema.json`（手册 §4.2）

| 字段 | 类型 | 约束 |
|---|---|---|
| `schema_version` | integer | `const 1`，必填 |
| `product` | string | 必填，`^[a-z][a-z0-9-]*$` |
| `repository_mode` | enum | `monorepo`，必填 |
| `components` | array | 必填，可空（init 态 `[]`） |
| `components[].id` | string | `^[a-z][a-z0-9-]*$` |
| `components[].path` | string | 如 `apps/backend` |
| `components[].template` | enum | `spring-boot` / `web` / `ios-tuist` / `android` |
| `components[].template_ref` | string | 如 `v1.0.0` |
| `components[].owner` | string | team handle |
| `components[].ci` | enum | `java` / `web` / `ios` / `android` |

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
| `depends_on` | string[] | 引用其他 task id |

必填：`id` / `platform` / `track` / `title`。

### 2.3 `impact.schema.json`（手册 §10.1，兼容 M4/M5 分阶段）

| 字段 | 类型 | 阶段 |
|---|---|---|
| `base` / `head` | string | commit SHA |
| `changed.requirements` / `.screens` / `.operations` | string[] | M4 |
| `platforms.{backend,web,ios,android}` | boolean | M4（喂 detect / §9） |
| `breaking` | boolean | M4 |
| `affected_issues` | array | **可选**，M5 补 |
| `suggested_change_issues` | array | **可选**，M5 补 |

必填：`changed`、`platforms`。后两项可选 → M4 只产平台矩阵，M5 再填 Issue 归并，全程同一 schema。

## 3. `sdd validate`（`cli/`，oclif）

- 默认：在 `--repo .`（缺省当前目录）下读取并校验 `projects.yaml`（YAML→JSON 经 `yaml`，
  再走 ajv）。
- `sdd validate --kind task|impact <file>`：校验显式文件。
- ajv 错误格式化为可读输出（路径 + 原因）；任一校验失败 **非零退出**，全部通过退出 0。

## 4. `@sdd/provenance`（§1 授权溯源校验库）

M1 只交付**库本身 + 单测**；真实 label/ruleset 接入在 M2，强制调用在 M3/M5。

接口：

```ts
verifyGateApproval(input: {
  octokit: Octokit;          // 注入，便于测试
  git: GitReader;            // 注入：读 worktree 状态与指定 commit 的 blob
  repo: { owner: string; name: string };
  gate: 'spec' | 'architecture' | 'design' | 'plan';
  version: string;           // 如 v1
  artifactPath: string;      // 如 projects.yaml
}): Promise<
  | { ok: true; provenance: { gate; version; pr; approved_head_sha; merge_commit_sha; approved_at } }
  | { ok: false; reason: string }
>;
```

内部逻辑：

1. 经 GitHub API 按 `gate:<gate>` 标签 + version 定位**已合入受保护 `main`** 的 Gate PR，
   取 `merge_commit_sha`、最终 head SHA 及其 CODEOWNER 批准记录；
2. 校验本地 `artifactPath` 的 git blob 等于该 `merge_commit_sha` 中同路径 blob，且要求
   worktree 对该路径 clean；
3. **fail closed**：API 不可用 / 证据不完整 / 任一校验不符 → `{ ok: false }`，调用方必须
   中止任何 GitHub 写操作。

## 5. 测试（vitest）

- **schemas**：每套 schema 的 valid / invalid fixtures——空 `components` 通过、缺必填失败、
  未知 `platform`/`template` 失败、id pattern 不符失败。
- **validate**：对 fixture 仓库的集成测试（合法 projects.yaml 退出 0、非法非零）。
- **provenance**（mock octokit + 假 git）：CODEOWNER 批准且 blob 一致 → ok；过期审批 /
  非 CODEOWNER 批准 → fail；API 抛错 → fail closed；blob 不一致 → fail。

## 6. 交付文件树

```text
sdd-platform/
├─ pnpm-workspace.yaml · package.json · tsconfig.base.json · biome.json · vitest.config.ts · .nvmrc
├─ schemas/
│  ├─ package.json · tsconfig.json
│  ├─ src/{projects,task,impact}.schema.json · src/validators.ts · src/index.ts
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

- `pnpm install && pnpm -r build && pnpm -r test && pnpm -r lint` 全绿。
- `sdd validate` 对样例 `projects.yaml` 给出正确判定（合法/非法各一）。
- 三套 schema 定稿，TS 类型由生成器产出且被各包消费。
- `@sdd/provenance` 暴露 `verifyGateApproval`，单测覆盖 §5 全部用例。

## 8. 不在 M1 范围

- `factory` / `backlog-compiler` 的真实实现（M2 / M5），M1 仅占位包。
- Gate label / CODEOWNERS / ruleset 的真实配置（M2）。
- 授权校验的强制调用点（M3 scaffold / M5 publish）。
- 平台模板（M3）、reusable workflows（M4）。

# AGENTS.md — {{product}}

> 产品仓代理纪律。本文件由产品 owner 维护，变更需通过 Gate PR 并经对应 CODEOWNER 批准。

## 1. Gate 工作流

`Intake → Spec → Architecture → (Design | 有据跳过) → Plan → Backlog`

1. **Intake**：用 `.github/ISSUE_TEMPLATE/intake.yml` 表单提出，产出带标签的 Issue。
2. **Spec Gate**：`gate:spec` label + `specs/<version>/spec.md`；含 ≥1 个 `REQ-<AREA>-<n>`。
3. **Architecture Gate**：`gate:architecture` label + `specs/<version>/architecture.md` +
   `projects.yaml`；必要时引入 `contracts/openapi.yaml`（触发 M4.5 Contract Gate）。
4. **Design Gate**：`gate:design` label + `specs/<version>/design.md`；含 ≥1 个 `SCR-<NAME>`。
   无 UI 产品可据 `plan.md` §6 跳过，并在 marker 中注明。
5. **Plan Gate**：`gate:plan` label + `specs/<version>/plan.md`。
6. **Backlog**：`sdd backlog compile/publish` 把 Plan 拆成稳定 task Issue。

## 2. Gate PR 纪律

- 必须使用 `gate:<gate>` label（详见 `.github/PULL_REQUEST_TEMPLATE/gate.md` marker）。
- 必须填写机读 marker 块（gate / version / upstream_approvals）。
- 禁止在同一 PR 中混合多种 Gate。

## 3. 稳定 ID 规则

- **需求**：`REQ-<AREA>-<n>`（正则 `^REQ-[A-Z0-9]+-\d+$`）
- **屏幕**：`SCR-<NAME>`（正则 `^SCR-[A-Z0-9-]+$`）
- **operationId**：OpenAPI 中必须稳定、文档内唯一
- ID 一经合入**禁止改名**；废弃需用新 ID 并在 PR 中标注。

## 4. 合同优先（Contract-first）

- 跨平台通信必须有 OpenAPI / event schema。
- 禁止手改生成 client；重新生成必须经 CI 校验。

## 5. CI

- 所有 PR 经 `CI Gate` 统一判定（由平台仓 required workflow 产出，产品仓无副本）。
- PR 另需 `PR hygiene` 通过（校验 marker / label / 稳定 ID / 上游批准 / CODEOWNER）。

## 6. 任务状态

- 任务状态只在 Issues（GitHub Projects / milestone），不在本仓。
- 本仓只承载授权产物（specs / contracts / design / plan）与代码。

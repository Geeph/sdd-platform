# {{product}}

> {{product}} 产品仓。本仓由 [`@sdd/factory`](https://github.com/<org>/sdd-platform) 的
> `sdd product init` bootstrap，初始结构为受 Gate 保护的 monorepo 骨架（`components: []`）。

## 仓库结构

```text
{{product}}/
├─ specs/_template/    # spec / architecture / design / plan 模板
├─ contracts/          # OpenAPI / event schema（Architecture Gate 引入）
├─ design/tokens/      # 设计 token（Design Gate 引入）
├─ projects.yaml       # 产品拓扑（Architecture Gate 维护）
├─ template.lock       # 模板生成来源审计锚点
├─ AGENTS.md           # 代理纪律（Gate 工作流、稳定 ID、CI）
└─ .github/            # Issue form / PR 模板 / CODEOWNERS
```

## 工作流

详见 [`AGENTS.md`](./AGENTS.md)：Intake → Spec → Architecture → Design → Plan → Backlog 的
Gate 顺序，与 PR hygiene / CI Gate 的强制校验。

## 平台组件

当前 `components: []`。平台骨架（`apps/*`）由 `sdd product scaffold`（M3）按 `projects.yaml`
中**已批准**的条目生成，未列出的平台不得生成。

## 合规

- Gate PR 必须使用 `gate:<gate>` label 与机读 marker。
- 所有批准记录从 GitHub 元数据复算，不信任工作区自证文件。

## Gate PR

本 PR 提交 Gate 产物（spec / architecture / design / plan / contract）。

<!-- sdd:gate
gate: spec|architecture|design|plan|contract
version: v1
upstream_approvals:
  spec: <merge_sha|#PR>
  architecture: <merge_sha|#PR>
  design: <merge_sha|#PR|skipped>
skip_design_gate_reason:
-->

### 检查清单

- [ ] 已打 `gate:<gate>` label
- [ ] marker 块已填写且与实际变更一致
- [ ] 稳定 ID（`REQ-*` / `SCR-*` / `operationId`）遵循命名规则且未重命名既有
- [ ] 上游批准引用指向已合入 `main` 的 Gate PR（或 `#PR`）
- [ ] 无 UI 时 `design: skipped` 且 `skip_design_gate_reason` 非空
- [ ] 变更路径落在与本 Gate 匹配的 CODEOWNERS 规则下

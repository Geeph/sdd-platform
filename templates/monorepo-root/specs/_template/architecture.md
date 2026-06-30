# {{product}} — Architecture

> 架构 Gate PR 的产物。描述组件边界、依赖方向、合同边界与跨平台策略；必须与本 PR 的
> `projects.yaml` 一起提交。

## 1. 系统上下文与组件边界

- **系统边界**：（待填）
- **组件清单**：（待填）
- **依赖方向**：（待填，明确上下游）

## 2. 平台与部署拓扑

> 列出本架构引入的平台；必须与 `projects.yaml` 的 `components[]` 一一对应。

| 平台 | 组件路径 | 模板 | CI |
|---|---|---|---|
| （待填） | `apps/<name>` | spring-boot / web / ios-tuist / android | java / web / ios / android |

## 3. 合同边界（OpenAPI / Event）

- **对外 OpenAPI**：`contracts/openapi.yaml`（M4.5 Contract Gate 校验）
- **事件边界**：（待填）
- **说明**：物理 DB schema 与 migration **仅属 `apps/backend`**，不跨平台共享。

## 4. 数据与安全策略

- **数据存储**：（待填）
- **认证 / 鉴权**：（待填）
- **敏感数据**：（待填）
- **审计 / 日志**：（待填）

## 5. 性能与可扩展性

- **性能目标**：（待填）
- **扩展策略**：（待填）

## 6. 领域模型

- **核心实体**：（待填）
- **关系**：（待填）
- **聚合边界**：（待填）

## 7. 决策与未决

| ADR | 决策 | 理由 | 状态 |
|---|---|---|---|
| （待填） | | | proposed / accepted / deprecated |

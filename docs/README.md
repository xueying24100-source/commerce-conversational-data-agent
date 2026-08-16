# Documentation

文档按产品边界、运行方式和可复现证据组织；数据合同位于 `contracts/`，冻结评测与外部验收协议位于 `quality/`。

## 建议阅读顺序

1. [系统架构](architecture.md)：Web、Worker、control/analytics 数据面和信任边界。
2. [Evidence 与 E2E](e2e.md)：区分浏览器 Fixture、真实 PostgreSQL 和真实模型证据。
3. [验证状态](validation-status.md)：已验证能力与仍为 `not_run` 的外部门禁。
4. [仓库结构](repository-layout.md)：代码、测试、生成资产和部署材料的位置。

## 实现与运行

- [异步执行](async-execution.md)：durable job、Worker、lease、fencing 和 SSE。
- [Connector](connectors.md)：配置、checkpoint、Source Adapter、RLS 和审计。
- [可观测性](observability.md)：日志、指标、探针和告警。
- [运维 Runbook](operations-runbook.md)：迁移、启动、清理和故障处理。
- [发布 Runbook](release-runbook.md)：本地门禁、正式证据和回滚流程。

## 可校验资产

- [数据合同](../contracts/README.md)：冻结 Fixture、source manifest 和 lineage。
- [质量证据](../quality/README.md)：离线评测资产与外部门禁协议。

README 动画使用真实 Next.js UI 和确定性 tenant API Fixture，只证明交互与 Evidence 展示，不冒充后端或模型评测。

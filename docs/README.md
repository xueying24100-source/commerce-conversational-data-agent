# Commerce Data Agent 文档

本目录只描述当前 Commerce Data Agent。公开数据合同放在 `contracts/`，冻结评测与外部验收协议放在 `quality/`，避免把叙述文档、生成资产和运行代码混在一起。

## 第一次阅读

1. [仓库结构](repository-layout.md)：先定位代码、测试、生成物和根目录配置。
2. [系统架构](architecture.md)：理解 Web、Worker、control/analytics 数据面与信任边界。
3. [E2E 与证据边界](e2e.md)：区分 UI Fixture、真实 PostgreSQL 和真实模型证据。
4. [验收状态](acceptance-status.md)：逐周区分已验证实现和仍为 `not_run` 的外部门禁。
5. [秋招面试手册](interview-guide.md)：按当前实现准备项目介绍与追问。

## 实现与数据

- [异步执行](async-execution.md)：durable job、Worker、lease、fencing 和 SSE。
- [Connector](connectors.md)：配置、checkpoint、Source Adapter、RLS 和审计。
- [可观测性](observability.md)：日志、指标、探针和告警。
- [十周实现计划](data-agent-10-week-plan.md)：目标、阶段验收、反事实与 Definition of Done。

## 运维与发布

- [运维 Runbook](operations-runbook.md)：迁移、启动、清理和故障处理。
- [发布 Runbook](release-runbook.md)：本地 RC 门禁、正式外部证据和回滚流程。

## 机器可校验资产

- [数据合同](../contracts/README.md)：冻结 Fixture、source manifest 和 lineage。
- [质量证据](../quality/README.md)：离线 eval 与仍需外部环境的 `not_run` 协议。

README 中的动画是真实 Next.js UI 配合确定性 tenant API Fixture 的演示，不能替代真实模型 E2E。

# Commerce Data Agent 文档

本目录只描述当前 Commerce Data Agent，不再包含金融研究、量化策略、Prisma 平台或市场数据服务文档。

- [architecture.md](architecture.md)：运行时、数据面和安全边界。
- [connectors.md](connectors.md)：Connector 配置、checkpoint、RLS 和审计。
- [async-execution.md](async-execution.md)：durable job、Worker、lease、SSE。
- [observability.md](observability.md)：日志、指标、探针和告警。
- [e2e.md](e2e.md)：PostgreSQL integration 与真实模型 E2E。
- [operations-runbook.md](operations-runbook.md)：迁移、启动、清理和故障处理。
- [release-runbook.md](release-runbook.md)：发布证据和回滚流程。
- [data-agent-10-week-plan.md](data-agent-10-week-plan.md)：十周目标、验收门槛和外部依赖。
- [INTERVIEW_GUIDE.md](INTERVIEW_GUIDE.md)：与当前代码校准的秋招讲解、追问和红线。

公开数据合同与评测协议不放在 docs 的叙述层：冻结 fixture/lineage 位于
`contracts/commerce-data-contract/v1`，离线与外部 Gate 位于
`quality/commerce-agent-eval/v1`。README 中的动画是 UI Fixture 演示，不能替代真实模型 E2E。

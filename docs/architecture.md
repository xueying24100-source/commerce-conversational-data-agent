# 架构

## 组件

```text
Web/API -> Control PostgreSQL -> Durable Job -> Worker
                                      |
                                      v
Model Provider <- Agent Runtime -> Read-only Analytics PostgreSQL
                                      |
                                      v
                              Evidence + persisted answer
```

Web 负责身份、输入校验、入队、查询会话和投影 SSE。Worker 是唯一执行模型工具循环的进程。控制库保存 Conversation、Message、Run、Evidence、Rate Limit、Job、Job Event 和 Worker heartbeat；分析库保存经营事实、目录、水位与 Connector 审计。

Prometheus 的跨租户 control-plane 汇总不复用 Worker system context。Web 只可执行
`commerce_collect_control_metrics(integer)`，该 SECURITY DEFINER 函数返回固定聚合 JSON，
没有任意 SQL、筛选或明细读取参数；PUBLIC、maintenance 和 backup 的执行权被显式撤销。
Connector 指标仍要求显式 tenant header，并通过 analytics RLS 分租户采集。

## Agent Loop

Agent 只能使用代码注册的电商工具：数据描述、实体检索、指标对比、维度拆解、趋势、库存风险和最终答案提交。工具参数使用 Zod 校验，SQL 字段来自白名单，所有筛选和 tenant ID 均参数化。

同一 turn 的分析读取运行在 `REPEATABLE READ, READ ONLY` 快照内。最终答案的 summary、finding 和 recommendation 必须绑定本轮 Evidence ID、JSON Pointer、metric、value 和 unit，服务端验证后才会持久化。

公开历史 Demo 使用与生产 Connector 相同的 Source Adapter 合同。`commerce_source_snapshots`
保存来源、许可、revision、源/制品 SHA-256、seed、lineage、capability 和 virtual clock。
readiness 把 public snapshot 披露投影给 UI，因此“原生字段/演示派生字段”的区分来自持久元数据，
不是根据租户名或页面环境硬编码。

## Trust Boundaries

- 浏览器不能提供可信 tenant；生产身份由反向代理认证后注入。
- 模型不能读取数据库连接串、生成任意 SQL 或调用写工具。
- Web 使用 `commerce_control_api_user`，Worker 使用
  `commerce_control_worker_user`；两者不共享 URL。只有 Worker role 与事务级
  `commerce.control_system=on` 同时成立时，control RLS 才允许 system 分支。
  API role 自行设置该 GUC 不产生跨租户权限。
- Connector 使用 ingest 角色，migration 与 retention 使用独立凭据。
- 分析表强制 RLS，生产只读角色必须 `NOBYPASSRLS` 且默认只读。
- 生产没有 Fixture、关键词 planner 或规则答案 fallback。

## Source Boundaries

`config/module-boundaries.json` 是当前模块清单。`npm run check:boundary` 会拒绝恢复 finance、quant、eval、Prisma、market-data、benchmark、SQL bootstrap 或 `.moagent` 遗留目录。

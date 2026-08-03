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

## Agent Loop

Agent 只能使用代码注册的电商工具：数据描述、实体检索、指标对比、维度拆解、趋势、库存风险和最终答案提交。工具参数使用 Zod 校验，SQL 字段来自白名单，所有筛选和 tenant ID 均参数化。

同一 turn 的分析读取运行在 `REPEATABLE READ, READ ONLY` 快照内。最终答案的 summary、finding 和 recommendation 必须绑定本轮 Evidence ID、JSON Pointer、metric、value 和 unit，服务端验证后才会持久化。

## Trust Boundaries

- 浏览器不能提供可信 tenant；生产身份由反向代理认证后注入。
- 模型不能读取数据库连接串、生成任意 SQL 或调用写工具。
- Web/Worker 使用控制库运行角色和分析库只读角色。
- Connector 使用 ingest 角色，migration 与 retention 使用独立凭据。
- 分析表强制 RLS，生产只读角色必须 `NOBYPASSRLS` 且默认只读。
- 生产没有 Fixture、关键词 planner 或规则答案 fallback。

## Source Boundaries

`config/module-boundaries.json` 是当前模块清单。`npm run check:boundary` 会拒绝恢复 finance、quant、eval、Prisma、market-data、benchmark、SQL bootstrap 或 `.moagent` 遗留目录。

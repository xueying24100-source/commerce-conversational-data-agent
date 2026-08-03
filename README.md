# Commerce Conversational Data Agent

这是一个面向电商运营场景的垂直 Data Agent。它连接租户隔离的 PostgreSQL 经营事实，通过受控工具循环完成多轮分析，并返回可验证的 Evidence，而不是让模型直接生成 SQL 或无依据结论。

当前项目包含生产所需的完整主链路：

- 数据 Connector：文件或 HTTPS、JSON/JSONL、字段映射、checkpoint、SHA-256、租户 RLS、运行审计。
- 异步执行：PostgreSQL durable job、幂等入队、并发上限、lease/fencing、独立 Worker、SSE 状态流。
- 可观测性：结构化日志、Job/Run/Token/Evidence/Queue/Worker Prometheus 指标、liveness/readiness。
- E2E：API ingress、异步队列、Worker、多轮会话、SSE、全部分析工具族和真实模型调用。
- 生产边界：控制库、只读分析库、ingest、migration、maintenance 使用独立数据库角色；无金融、Prisma、市场数据或 Fixture fallback。

## Runtime

```text
Browser / API client
  -> authenticated Commerce API
  -> commerce_agent_jobs (queued)
  -> independent Commerce Worker
  -> durable conversation/run/evidence store
  -> repeatable-read, read-only analytics snapshot
  -> allowlisted Commerce tools
  -> field-level evidence validation
  -> persisted result + SSE completion event
```

Worker 是必需组件。`/api/health/ready` 只有在最近存在 Worker 心跳时才返回 ready。

## Data Contract

分析事实表是 `commerce_daily_metrics`，主键为 `tenant_id + metric_date + region + channel + sku`。核心维度为 region、channel、sku、category；核心事实包括 visits、paid_orders、units、gmv、退款、成本、广告、新客、缺货时长和期末库存。派生指标在参数化 SQL 中计算，不由模型自行计算。

- `migrations/commerce-control.sql`：Conversation、Message、Run、Evidence、Rate Limit、Job、Job Event、Worker。
- `migrations/commerce-analytics.sql`：经营事实、租户目录、水位、Connector checkpoint/run、强制 RLS。

## Local Start

要求 Node.js 22.19+、npm 10+ 和 PostgreSQL 17。

```powershell
Copy-Item .env.commerce.example .env.local
docker compose -f compose.commerce.local.yml up -d --wait postgres
npm install
npm run db:migrate:commerce
npm run db:seed:commerce
npm run dev
```

在 `.env.local` 中设置 `DEEPSEEK_API_KEY` 或 `MODELPORT_API_KEY`。`npm run dev` 会同时启动 Next.js 与 Commerce Worker，默认地址为 `http://localhost:3000/commerce`。
`db:seed:commerce` 只接受本机 loopback PostgreSQL，并生成明确标记的开发数据；生产数据仍必须通过 Connector 或 JSONL 导入进入 ingest 角色。

使用 Connector：

```powershell
npm run connector:commerce -- config/commerce-connector.example.json
# 无需账号的 Olist 官方公开电商数据：
npm run connector:commerce -- config/commerce-connector.olist.example.json
# 原生 Shopify Orders 增量同步：
npm run connector:commerce -- config/commerce-connector.shopify.example.json
```

## API

- `GET /api/commerce`：Agent metadata、身份和 tenant readiness。
- `GET|POST /api/commerce/conversations`：会话列表和异步创建。
- `GET /api/commerce/conversations/:id`：会话、消息、运行和 Evidence。
- `POST /api/commerce/conversations/:id/messages`：异步多轮请求。
- `GET /api/commerce/jobs/:jobId`：持久任务状态和结果。
- `GET /api/commerce/jobs/:jobId/events`：SSE 任务事件。
- `GET /api/health`：liveness。
- `GET /api/health/ready`：配置、数据库、RLS、只读角色和 Worker readiness。
- `GET /api/metrics`：Bearer token 保护的 Prometheus 指标；公网 Nginx 模板默认隐藏。

写请求必须使用 JSON，最大 24KB，并通过同源校验。生产身份只接受受信任代理注入的 tenant、user、scope 和 proxy secret。

## Commands

```text
npm run dev                         Web + Worker
npm run build                       Next standalone + Worker artifact
npm test                            Unit tests
npm run type-check                  Route + TypeScript check
npm run lint                        ESLint
npm run check:boundary              Removed-finance and production boundary gate
npm run test:integration:commerce   Disposable PostgreSQL invariants
npm run test:e2e:commerce:live      Real-model API/Worker/SSE multi-turn E2E
npm run release:check:commerce      Complete non-live release gate
npm run release:check:evidence      Live model + Docker release evidence
```

数据库集成和 Live E2E 都要求显式 disposable database URL 与确认变量，防止误写生产库。

## Production

Web 和 Worker 使用同一不可变制品、不同进程。可运行 `docker compose up -d web worker`，或使用 `deploy/systemd/` 下的 Web、Worker、cleanup timer 和 Connector unit。

数据库最小权限示例位于 `deploy/postgres/`。生产 Web/Worker 不应获得 migration、ingest 或 maintenance 凭据。

## Documentation

- [架构](docs/architecture.md)
- [Connector](docs/connectors.md)
- [异步执行](docs/async-execution.md)
- [可观测性](docs/observability.md)
- [E2E](docs/e2e.md)
- [运维 Runbook](docs/operations-runbook.md)
- [发布 Runbook](docs/release-runbook.md)

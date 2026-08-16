# Commerce Conversational Data Agent

一个面向电商经营诊断的生产型 Data Agent。它不是“把问题丢给大模型，再展示一段文字”：系统会先检查数据健康和时间口径，按中间证据选择下一步调查路径，再把每个数字绑定到可复查的查询结果、字段路径和审计哈希。

核心目标是回答三个问题：

- 发生了什么：规模、效率和风险相对可靠基准如何变化。
- 为什么：量价、流量转化、渠道、区域、品类、SKU 和时间趋势中，哪些解释有证据支持。
- 接下来做什么：只生成一项证据绑定、待人工确认、带成功指标与护栏的行动；数据不足时主动停止。

![Commerce Agent demo](docs/assets/commerce-agent-demo.gif)

> 上图是约 16 秒的可重复 UI 演示：真实 Next.js 页面配合明确标记的浏览器 Fixture，用于展示交互和 Evidence UX。它不代表真实模型评测；真实 Web → PostgreSQL → Worker → SSE → 模型链路由独立 Live E2E 验证。

## 为什么这是 Data Agent

| 能力 | 实现 |
| --- | --- |
| 自主调查 | 确定性诊断 Controller 根据健康检查、异常信号和上一步结果选择 breakdown、trend、entity lookup 或 inventory risk；证据足够、无合法路径或预算耗尽时停止 |
| 受控推理 | 模型只能调用注册工具，不能生成任意 SQL；日期、指标、维度、筛选、行数和工具预算都由 Zod 与服务端策略约束 |
| 可核验证据 | 每个结论携带 Evidence ID、RFC 6901 JSON Pointer、metric、原值、unit；UI 同时展示查询时间、筛选、基准、定义、实际结果表、来源水位和 SHA-256 |
| 数据语义 | GMV = paid orders × AOV、paid orders = visits × conversion；非加总率按分子/分母重算，拆解返回贡献与 residual |
| 行动闭环 | 建议先是 proposed；负责人、截止日和目标必须人工确认。状态机、提醒、复盘窗口、成功指标、护栏和审计事件均持久化 |
| 生产执行 | PostgreSQL durable queue、幂等 request、lease/fencing、独立 Worker、重试/死信、SSE、预算预留与结算 |
| 多租户安全 | Web、Worker、analytics、ingest、migration、maintenance、backup 使用分离角色；控制库和分析库强制 RLS |
| Fail closed | 必需指标、分区、水位、来源审计或模型输出校验失败时拒答，不补零、不伪造因果、不制造行动 |

## 架构

~~~mermaid
flowchart LR
  U[Browser / API client] --> P[Trusted identity proxy]
  P --> W[Next.js Web API]
  W --> C[(Control PostgreSQL)]
  C --> Q[Durable job queue]
  Q --> K[Independent Worker]
  K --> D[Diagnostic Controller]
  D <--> M[LLM provider]
  D --> T[Allowlisted commerce tools]
  T --> A[(Read-only Analytics PostgreSQL)]
  T --> E[Evidence Ledger]
  E --> C
  C --> S[SSE job events]
  S --> U
  E --> X[Grounded answer + proposed action]
  X --> O[Approval / review / optional Feishu Outbox]
~~~

Web 只负责可信身份、校验、入队和读投影；Worker 才执行 Agent。一次 turn 的分析运行在 REPEATABLE READ、READ ONLY 快照内。Prometheus 的全局控制面指标通过固定聚合的 SECURITY DEFINER 函数读取，Web 角色仍不能激活 Worker 的跨租户 system context。

更完整的边界说明见 [架构文档](docs/architecture.md)。

## 一条完整调查 Trace

旗舰问题：诊断上一完整周经营表现。

1. describe_data 读取租户币种、时区、覆盖范围、能力和来源水位。
2. inspect_data_health 校验每一天分区、必需指标/维度、快照哈希和 Connector 状态。
3. scan_weekly_kpis 将 2018-05-07 至 2018-05-13 与此前四个完整周中位数比较。
4. diagnostic_decision 识别增长信号，选择 GMV × channel 拆解，而不是套用固定报告。
5. breakdown_metric 发现 Organic Search 最大正增量，同时确认 Direct、Email 为负向项。
6. Evidence Ledger 校验所有数字与字段路径，构造唯一行动和 conversion rate 护栏后主动停止。

当前公开演示快照的可复核结果：

| 证据 | 当前周 | 基准/变化 |
| --- | ---: | ---: |
| GMV | R$293,731.41 | 四周中位数 R$235,357.27，+24.8% |
| 支付订单 | 1,971 | 四周中位数 1,667.5，+18.2% |
| 访问量 | 55,027 | 四周中位数 44,016.5，+25.0% |
| 支付转化率 | 3.58% | 四周中位数 3.84%，-6.8% |
| 客单价 | R$149.03 | 四周中位数 R$141.14，+5.6% |
| 渠道定位 | Organic Search +R$44,005.36 | Direct -R$9,398.70；Email -R$6,033.16 |

这些数值可从冻结 Fixture、Evidence 结果表和 claim JSON Pointer 三条路径独立核对。

## Evidence 怎么核

Evidence 不是只展示 request 参数。每张证据卡包含：

- 查询口径：分析期、比较期/基准策略、指标、维度、筛选、排序和行数上限。
- 指标定义：聚合方式、可加性、派生公式、币种与业务时区。
- 实际结果：KPI 扫描、对比、拆解或趋势的原始结果表/图。
- 结论引用：结论中的每个数字对应 evidenceId + JSON Pointer + metric + value + unit。
- 审计信息：请求/响应 SHA-256、查询时间、行数、Connector 来源水位。

服务端在落库前重新解析 JSON Pointer 并比较原值；缺失、越界、单位错误、引用其他 run 或叙述里出现未绑定数字都会失败。

## 公开 Demo 数据披露

演示使用固定 Olist 公开历史数据，不是真实商户，也不是实时店铺。

| 字段 | 性质 | 说明 |
| --- | --- | --- |
| 支付订单、GMV 日总量 | Olist 原生聚合 | 固定上游 commit 和五个源文件 SHA-256；商品价格不含运费 |
| visits | 确定性派生演示字段 | seed 20260816，在有界转化率下生成 |
| channel、region、SKU、category、units | 确定性派生演示字段 | 在保持每天原生订单与 GMV 精确对账的前提下做跨维分配 |
| conversion rate、AOV | 同源派生指标 | 分别由 paid orders / visits、GMV / paid orders 计算 |
| 毛利、退款、库存、经营事件 | 不可用 | Agent 必须披露边界，不能补零或据此生成结论 |

来源、许可、revision、seed、生成字段、算法版本和 lineage 固化于 [数据合同](contracts/commerce-data-contract/v1/fixture-manifest.json)。页面会从数据库中的 Source Adapter 元数据读取同样的披露，而不是根据租户名写死文案。原生 Olist Connector 的详细口径见 [Connector 文档](docs/connectors.md)。

## 本地体验

要求 Node.js 22.19.x、npm 10+、Docker 和 PostgreSQL 17。

~~~powershell
Copy-Item .env.commerce.example .env.local
docker compose -f compose.commerce.local.yml up -d --wait postgres
npm install
npm run db:migrate:commerce
npm run db:seed:commerce:public-demo
npm run dev
~~~

在 .env.local 中设置 DEEPSEEK_API_KEY、MODELPORT_API_KEY，或配置本地 Qwen Provider。打开 http://localhost:3000/commerce。npm run dev 会同时启动 Web 与独立 Worker。

建议首先体验：

1. 诊断上一完整周经营表现。
2. 展开渠道 finding 的 Evidence 引用，核对 Direct / Email 对应结果行。
3. 查看行动卡中的 conversion rate 护栏，填写负责人/截止日后确认。
4. 再问“查看该周 GMV 的按日趋势”，验证多轮范围沿用与工具切换。

## Connector

系统支持：

- 冻结公开 Demo Fixture：可复现、带 SHA-256/seed/lineage。
- Olist 官方公开数据：固定 commit、逐文件 hash 校验、golden aggregates。
- Shopify Orders：cursor 增量、checkpoint、429/5xx 退避、限页和能力披露。
- HTTPS/file JSON/JSONL：schema mapping、大小/行数/超时限制、审计和租户 ownership fence。

运行方式：

~~~powershell
npm run connector:commerce -- config/commerce-connector.public-demo.example.json
npm run connector:commerce -- config/commerce-connector.olist.example.json
npm run connector:commerce -- config/commerce-connector.shopify.example.json
~~~

## 验证策略

2026-08-17 本地 release-candidate 验收（外部 Gate 不计入）：

| 结果 | 本地实测 |
| --- | ---: |
| npm test | 686 次测试执行通过 |
| Critical coverage | statements 84.05% · branches 76.26% · functions 87.03% · lines 86.97% |
| PostgreSQL integration | 18/18 |
| Production browser | 16/16（desktop + mobile） |
| Real-model process E2E | 3 轮会话、12 份 Evidence、7 类分析操作通过 |
| 30 秒并发探活 | 136 cycles · 0 error · readiness p95 344 ms · bootstrap p95 651 ms |
| npm audit | 0 vulnerability（npm 官方 audit API） |

这些是本地 RC 证据，不等于生产 SLA，也不把下方仍为 not_run 的外部验收改写为通过。

| Gate | 覆盖范围 | 不能证明什么 |
| --- | --- | --- |
| npm test | 单元、诊断合同、Source Adapter、Connector、离线 eval 资产与安全不变量 | 真实 PostgreSQL 权限或模型表现 |
| test:coverage:critical | runtime / diagnostics / Evidence / scope / job / worker；阈值 statements 80%、branches 75%、functions 80%、lines 85% | 全仓库所有 UI 行 |
| test:integration:commerce | disposable PostgreSQL 的 RLS、时区、币种、快照、lease、fencing、预算和最小权限 | 外部 Provider |
| test:e2e:commerce:browser | desktop + mobile 共 16 个环境流；axe、console、overflow、行动与恢复路径 | API/DB/真实飞书，脚本明确拦截 tenant API |
| test:e2e:commerce:live | production Next.js、HTTP ingress、独立 Worker、PostgreSQL queue、SSE、Prometheus、多轮工具和真实模型 | 大样本模型质量 |
| test:performance:commerce | readiness/bootstrap 并发探活与延迟统计 | 互联网级容量 |
| release:check:commerce | assets、依赖审计、lint、unit、types、boundary、build、browser、PostgreSQL integration | 外部沙箱与正式用户可用性 |

离线评测包含冻结的 30-case development、100-case final、独立 Oracle、30 个 hidden metamorphic case 和 fixed-policy ablation。固定策略报告只是 baseline，不能冒充动态 Controller 成绩。

仍需外部环境才能正式完成的 Gate 会保持 not_run：

- 100-case Final Controller HTTPS evaluator。
- 120 次真实模型质量/稳定性评测。
- 飞书沙箱 100 个审批与故障队列。
- 5 名非开发者、懂电商运营的三分钟可用性任务。

状态与协议见 [quality/commerce-agent-eval/v1](quality/commerce-agent-eval/v1/README.md)、[飞书沙箱协议](quality/commerce-agent-feishu-sandbox/v1/README.md) 和 [可用性协议](quality/commerce-agent-usability/v1/README.md)。缺少外部证据时不会标记 passed。

## 生产边界

- 生产身份只接受可信代理注入的 tenant、user、scope、client IP 和共享 secret；浏览器字段不可信。
- Web 与 Worker 使用不同 PostgreSQL 账号和 URL；只有 Worker role + transaction-local system context 同时成立时才允许跨用户队列处理。
- Analytics role 为 NOBYPASSRLS + default_transaction_read_only；Connector、migration、maintenance、backup 凭据不进入 Web/Worker。
- 同一 action/version/channel 只创建一个逻辑 Outbox 命令；网络层不声称物理 exactly-once。post-send 异常进入 delivery_unknown，不盲重试。
- 历史快照使用 virtual business clock；行动确认和复盘不会伪装成今天发生的生产事件。
- 模型不能自行批准行动、编造负责人/截止日/目标，也不能把贡献分析表述为因果证明。

## 常用命令

~~~text
npm run dev                         Web + Worker
npm run build                       Next production + Worker artifact
npm test                            Unit + contracts + offline eval
npm run lint                        ESLint
npm run type-check                  Route generation + TypeScript
npm run test:coverage:critical      Critical-module coverage gate
npm run test:integration:commerce   Disposable PostgreSQL integration
npm run test:e2e:commerce:browser   16 desktop/mobile browser flows
npm run test:e2e:commerce:live      Real-model Web/Worker/SSE E2E
npm run release:check:commerce      Non-external release gate
~~~

## 文档导航

- [系统架构](docs/architecture.md)
- [异步执行与 Worker](docs/async-execution.md)
- [Connector 与数据口径](docs/connectors.md)
- [E2E 与证据边界](docs/e2e.md)
- [可观测性](docs/observability.md)
- [运维 Runbook](docs/operations-runbook.md)
- [发布 Runbook](docs/release-runbook.md)
- [十周实现与验收计划](docs/data-agent-10-week-plan.md)

License: MIT

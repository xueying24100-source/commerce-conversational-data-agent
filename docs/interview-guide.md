# 秋招面试手册：Commerce Data Agent

本手册只描述当前代码。它刻意区分“已实现并验证”“确定性测试 Fixture”“需要外部环境、仍为 not_run”三类事实，避免把设计目标或模拟测试讲成生产成绩。

## 30 秒项目介绍

我做了一个电商经营诊断 Data Agent。它会先检查租户数据健康、业务时区和完整周基准，再根据中间结果自主选择 KPI 扫描、趋势、维度拆解、实体检索或库存风险工具。模型不能写任意 SQL；所有查询都经过白名单、参数化和只读 PostgreSQL。最终答案中的每个数字都绑定到 Evidence ID 和 JSON Pointer，用户可以在右侧证据栏核对查询口径、原始结果、字段路径、水位与哈希。执行层使用 PostgreSQL durable queue、独立 Worker、lease/fencing、SSE 和死信；行动必须人工确认，并带成功指标和护栏。

## 3 分钟项目介绍

这个项目解决的不是“自然语言转 SQL”，而是“怎样让经营调查在数据不完整、模型不稳定和多租户环境中仍然可控”。

数据层把 tenant、业务日期、region、channel、SKU、category 和可用指标固化为合同。GMV、订单、访问、转化和客单价有明确公式与可加性；分区完整性、Connector checkpoint、source watermark、币种和时区进入 readiness。Olist 公开 Demo 中，订单与 GMV 日总量是公开数据原生聚合，访问与钻取维度是带 seed/lineage 的确定性演示派生字段，页面会主动披露。

Agent 层先运行确定性数据健康与异常扫描，再按候选收益、成本和合法性选择下一视图。Evidence Ledger 不只检查 evidenceId 存在，还会解析 claim 的 JSON Pointer、比较原始数值和单位，并拒绝没有绑定 Evidence 的叙述数字。贡献分析只描述数值归因，不冒充因果。

执行层把 Web 和 Worker 分开。Web 只做可信身份、校验、幂等入队和查询投影；Worker 执行 Agent。控制库和分析库使用不同角色并强制 RLS。Worker 崩溃路径通过 lease、owner/fencing、retry/dead-letter 和幂等结果收敛；系统只声称 at-least-once execution + effectively-once result，不声称物理 exactly-once。

测试分为单元/合同、真实 PostgreSQL integration、desktop/mobile 浏览器、production Web + 独立 Worker + SSE + 真实模型 Live E2E。浏览器测试明确拦截 tenant API，因此只证明 UI；外部 100-case Controller、120 次真实模型、飞书沙箱和五名外部用户任务未配置时保持 not_run。

## 现场演示顺序

1. 打开首页，指出历史快照和公开派生字段披露。
2. 提问“诊断上一完整周经营表现”。
3. 解释为什么使用此前四个完整周中位数，而不是随意环比。
4. 展开渠道 finding：核对 Organic Search、Direct、Email 对应的实际结果行和 claim path。
5. 展示唯一行动，以及 conversion rate 护栏没有被渠道 claims 挤掉。
6. 提问“查看该周 GMV 按日趋势”，展示多轮范围沿用和工具切换。
7. 最后说明浏览器演示与真实 Live E2E 是两条独立证据链。

## 高频问题

### 1. 为什么叫 Data Agent，不是聊天机器人？

因为系统能根据中间证据选择后续工具、维护调查状态、在证据足够或无合法路径时主动停止。答案不是自由文本终点，而是由查询、Evidence、finding、行动和后续复盘组成的状态闭环。

### 2. 为什么不让模型直接写 SQL？

任意 SQL 会把 schema、权限、性能和 prompt injection 风险全部交给模型。这里模型只能选择 metric、dimension、date range 和 filter；repository 决定 SQL 模板，列名来自白名单，值全部参数化，事务为 REPEATABLE READ + READ ONLY。

### 3. 确定性 Controller 会不会让 Agent 退化成规则系统？

规则负责不可妥协的边界：数据门禁、时间口径、预算、停止条件和 Evidence 校验。模型负责语言理解、候选假设和受控工具选择。固定策略还有单独的 ablation baseline，动态 Controller 必须通过同一 Oracle 评测后才能宣称收益。

### 4. 为什么基准是此前四个完整周中位数？

完整周避免半周和星期结构错配；四周提供近期样本；中位数比均值更抗单周促销尖峰。历史不足时系统会降级为可用完整周或相邻周期，并降低置信度，不会仍显示 high confidence。

### 5. Evidence 比“显示 SQL 参数”多了什么？

它展示查询口径、指标定义、实际结果表、结论引用字段和审计信息。每个 claim 至少包含 evidenceId、JSON Pointer、metric、value、unit。服务端重新解析路径并精确比较原值；跨 run、错误单位、错误字段或无 Evidence 数字会被拒绝。

### 6. 怎样防止“有当前值，却说没有基准”？

旗舰完整周诊断使用独立的 weekly scan 结果，current、baseline median 和 relative change 都是结构化字段。最终渲染由服务端 Evidence 构造器生成，测试明确断言“明确增长周”、量价分解、效率验证和渠道增减，不依赖模型自由发挥。

### 7. 数据不完整怎么办？

必需指标、必需维度、日期分区、来源哈希或 Connector 状态失败时，分析工具调用数和行动数都为零。可选的利润、退款或库存缺失时，核心规模诊断可以继续，但答案必须披露边界，且不能生成涉及缺失能力的 finding。

### 8. 如何做多租户隔离？

生产身份由可信代理注入 tenant、user、scope、client IP 和 proxy secret。控制表与分析表 FORCE RLS。Web 和 Worker 使用不同控制库角色；只有 Worker 登录角色与 transaction-local system context 同时成立时，才能处理跨用户队列。API 自行设置 GUC 不能获得系统权限。

### 9. 为什么 Prometheus 指标需要数据库函数？

全局 queue/run 指标跨租户，但 Web 角色不能进入 Worker system context。项目使用固定字段、只返回聚合 JSON 的 SECURITY DEFINER 函数，并只向 Web/Worker 授予 EXECUTE；它不能查询任意租户明细。真实 production E2E 正是通过 /api/metrics 发现并验证了这条边界。

### 10. Worker 崩溃会不会重复写结果？

执行允许 at-least-once。Job claim 使用 lease、owner 和 fencing，终态更新校验所有权；requestId、运行与结果表有唯一约束，旧 Worker 不能覆盖新 owner。测试覆盖 requeue、dead-letter、supersede、心跳和优雅退出。网络外部副作用仍不声称 exactly-once。

### 11. 行动为什么不是模型说了算？

模型建议会被重建为 proposed action card。负责人、截止日、目标和评估窗口属于业务承诺，默认必须由人填写。行动只允许一项，绑定 Evidence；成功指标与护栏冻结后，复盘按完整业务日重新查询，护栏突破优先于成功指标达标。

### 12. 飞书通知如何避免重复？

同一 tenant/action/version/channel 有唯一逻辑 Outbox 命令和稳定 request UUID。429/5xx 等可重试错误按退避处理；post-send transport exception 在无法对账时进入 delivery_unknown，不盲重试。只有已批准行动、授权操作人和合法租户成员可以发送。

### 13. 历史快照为什么需要 virtual clock？

如果用今天作为参考日期，2018 年数据会被误判陈旧，行动截止日和复盘窗口也会失真。冻结快照带 virtualAsOf、source watermark、业务时区和 hash；诊断、行动完成和复盘都使用同一受控业务时钟，同时明确提示“不代表实时店铺”。

### 14. 币种如何保证正确？

事实、租户状态、目录、Source Adapter 和 Evidence 都带 ISO 4217 currency code。Connector 拒绝混币，repository 在同一租户快照内计算，UI 从 readiness/catalog 读取 BRL、USD 等币种，不再用 CNY 默认覆盖已知来源。

### 15. 公开 Demo 有没有伪造数据？

没有把派生字段包装成原始观测。Olist 的 paid orders 和 GMV 日总量来自固定 commit 的公开文件；visits、channel、region、SKU、category、units 是 seed 20260816 的确定性演示派生字段。算法版本、generatedFields、步骤和 SHA-256 在数据合同里，页面也展示披露。

### 16. 浏览器 E2E 能证明真实 Agent 吗？

不能。它证明真实 UI 在 desktop/mobile 的 16 个环境流中没有严重 axe 问题、console error 或横向溢出，并验证 Evidence 导航、行动、恢复和 Worker 重领的前端行为；tenant API 被明确拦截。真实后端由 PostgreSQL integration 和 production process Live E2E 单独证明。

### 17. 评测为什么分 dev、final 和 external？

dev 用于迭代；final 有冻结 Oracle 和 hidden metamorphic case，避免只对公开样例调参；external 需要独立 evaluator 或真实沙箱。固定策略 baseline、资产生成或单个 Live E2E 都不能替代 100-case/120-run 正式成绩。

### 18. 当前最重要的边界是什么？

- 公开 Demo 不是生产商户，也不能用于因果证明。
- 浏览器 Fixture 不证明真实模型、数据库或飞书。
- 贡献分解解释数值来源，不证明营销动作导致变化。
- 飞书 Outbox 保证逻辑幂等，不保证网络物理 exactly-once。
- 100-case Controller、120-run 模型、飞书沙箱和五名外部用户 Gate 未实际执行时必须保持 not_run。
- 项目没有真实线上流量，不能声称百万 QPS 或生产商业效果。

## 测试证据怎么讲

按“这条 Gate 能证明什么、不能证明什么”回答：

| Gate | 能证明 | 不能证明 |
| --- | --- | --- |
| Unit / contract | 状态机、口径、Evidence、策略与边界分支 | PostgreSQL 真实权限 |
| PostgreSQL integration | RLS、角色、事务、时区、币种、lease/fencing | Provider 质量 |
| Browser 16 flows | UI、可访问性、响应式、交互恢复 | 真实 API/DB |
| Live process E2E | production Web、独立 Worker、queue、SSE、Prometheus、真实模型工具链 | 大样本泛化 |
| Critical coverage | 关键模块达到门槛 | 覆盖率等于正确性 |
| External eval | 独立大样本质量或真实沙箱 | 超出其样本和环境的生产 SLA |

## 简历项目描述

可以压缩成以下三条：

- 设计电商经营诊断 Data Agent：以数据健康门禁和四周中位数为基准，按中间 Evidence 自主选择 KPI、趋势、维度拆解、实体与库存工具，并在证据充分或无合法路径时主动停止。
- 实现字段级 Evidence Ledger：将答案数字绑定到 evidenceId + RFC 6901 JSON Pointer，服务端验证原值/单位/run ownership；UI 展示口径、定义、结果行、水位与哈希，缺证据时 fail closed。
- 构建多租户异步执行与安全边界：PostgreSQL durable queue、独立 Worker、lease/fencing、retry/dead-letter、SSE、RLS 和分离数据库角色；用 unit、真实 PostgreSQL、16-flow browser 和 real-model process E2E 分层验证。

不要写：

- “完全杜绝幻觉”
- “实现物理 exactly-once”
- “已支撑百万 QPS”
- “公开 Demo 就是真实商户数据”
- “100-case/120-run/飞书沙箱已经通过”（除非确有 revision-bound 外部报告）

## 追问时可直接打开的文件

- Agent 主循环：src/lib/domains/commerce/agent/runtime.ts
- 诊断策略：src/lib/domains/commerce/agent/diagnostics.ts
- Evidence 校验：src/lib/domains/commerce/agent/evidence-ledger.ts
- Worker 与 Job：src/lib/domains/commerce/agent/worker.ts、job-store.ts
- 指标与 SQL：src/lib/domains/commerce/agent/analytics-repository.ts
- RLS：migrations/commerce-control.sql、migrations/commerce-analytics.sql
- Source Adapter：src/lib/domains/commerce/agent/source-adapter.ts
- 评测资产：quality/commerce-agent-eval/v1

面试最有说服力的顺序是：先展示用户问题和答案，再沿 claim 跳到 Evidence 结果行，最后打开对应的服务端约束与测试。不要从技术名词清单开始。

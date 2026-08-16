# E2E And Quality Gates

## Unit

`npm test` 覆盖 Agent core/provider、Commerce auth/API、analytics repository、conversation store、Evidence、metrics、readiness、runtime、telemetry、Connector ingest core 和生产环境校验。其中 runtime 的终局协议是：

1. 服务确定性调用 `describe_commerce_data`，先获得数据覆盖、时区和指标目录。
2. DeepSeek 只负责选择最小必要的分析读工具和参数。
3. Evidence Ledger 从实际回执中确定性生成 field-level claims。
4. 服务确定性执行一次 `submit_grounded_commerce_answer`，并用证据 ID、JSON Pointer、指标、单位和原始数值校验终局结果。

这个分工避免把终局 JSON 的格式稳定性交给模型；本地确定性步骤不计入 provider token usage。

## PostgreSQL Integration

```powershell
$env:COMMERCE_TEST_DATABASE_URL='postgresql://.../disposable'
$env:COMMERCE_TEST_DATABASE_CONFIRM='commerce-integration'
npm run test:integration:commerce
```

它会执行真实 migration，并验证：并发 capacity、幂等、Run fencing、Job claim/renew/reclaim、并发队列上限、目录刷新、RLS、只读分析角色、ingest 角色、控制角色和 maintenance 角色。

测试会创建和删除数据库角色，因此只能指向 disposable PostgreSQL。

## Live Model E2E

```powershell
$env:COMMERCE_LIVE_E2E_DATABASE_URL='postgresql://.../disposable'
$env:COMMERCE_LIVE_E2E_CONFIRM='commerce-live-e2e'
$env:COMMERCE_LIVE_E2E_MODEL='deepseek-v4-flash'
$env:DEEPSEEK_API_KEY='...'
npm run build
npm run test:e2e:commerce:live
```

该测试启动构建后的 Next HTTP 制品和独立 Worker 进程，从真实 HTTP API 入队，经过 durable Job，读取 Job API 与数据库投影 SSE，再完成三轮会话。它要求模型实际调用 describe、compare、breakdown、trend、lookup 和 inventory risk 工具，并检查 Evidence、水位、usage、受保护的 Prometheus 指标和最终持久消息。它是模型行为 gate，不作为 production topology 证据：本地 fixture 可以使用单个非 TLS disposable 数据库。

通过后证据写入 `tmp/commerce-live-e2e/report.json`。

## Final Image Production Topology

`npm run release:check:evidence` 在 live-model behavior gate 之后构建带 OCI revision label 的最终镜像，再运行 `scripts/checks/smoke-commerce-image.js`。该 gate 不接受单库或禁用 TLS 的替代配置；必须提供 Docker 可访问的 split-role TLS fixture、已知问题，以及 metric/value/unit 三元组形式的预期 claim。smoke 会把精确 claim 解析回对应 Evidence trace 的 JSON path，不使用答案文本子串作为正确性证据。

它从同一 image 以独立的 control API/Worker 凭据启动 production Web 与 production Worker，验证 revision、liveness/readiness 差异、同 revision Worker heartbeat、tenant data readiness、真实 HTTP 查询、SSE、Evidence 和进程优雅退出。Job 固化 required revision 并记录最终 executor；smoke 还会在任务运行中硬杀指定 Worker，等待 lease 过期后由同镜像 replacement Worker 重领完成，同时检查 `requeued` 事件和 attempt count。另一个同镜像 Web 使用确定不可达的 control API URL，必须保持 liveness 200、readiness 503。Worker 不暴露 HTTP health endpoint。结果写入 `tmp/commerce-release/image-smoke-report.json` 并由主 release report以 SHA-256 绑定。

## Olist Public Snapshot + DeepSeek

无法连接真实店铺时，使用固定 Olist 公开快照验证真实模型与真实 PostgreSQL 查询链路：

```powershell
npm run connector:commerce -- config/commerce-connector.olist.example.json
npm run test:e2e:commerce:olist
```

测试会把固定问题和 Olist 聚合查询结果发送给 DeepSeek，不发送密钥、本地环境文件或个人店铺数据。它验证 `2018-08-01` 至 `2018-08-31` 的 GMV `848860.10`、支付订单 `6421`、新客 `6209`，并验证 visits、广告消耗和 ROAS 会被拒答而不是补零。

通过后证据写入 `tmp/commerce-olist-live-e2e/report.json`。

## Browser E2E

先安装锁定版本的 Python Playwright 和 Chromium，再运行：

```powershell
python -m pip install -r scripts/e2e/requirements-browser-e2e.txt
python -m playwright install chromium
npm run test:e2e:commerce:browser
```

仓库 runner 会启动真实 Next.js UI，并用状态化 API fixture 隔离模型、数据库和飞书凭据。日常命令默认使用开发服务器；正式 release runner 必须先 build，再以 `COMMERCE_BROWSER_E2E_SERVER_MODE=production` 使用 `next start`，报告若不是 `serverMode=production` 会被拒绝。它覆盖计划中的 8 条核心流程，在 `1440x900` 与 `390x844` 各执行一次，共 16 条环境流程；逐条检查 console error、未捕获异常、横向溢出、键盘关键操作及 axe critical/serious。报告记录锁定的 Chromium/axe 版本和 fixture 边界，输出到 `tmp/commerce-browser-e2e/report.json`，同时生成桌面与移动截图。

这个 gate 证明 UI 协议和可访问性，不替代真实 PostgreSQL、真实模型或飞书沙箱 gate；报告也明确列出这些非证明范围。

README 动画可用以下命令重建。它复用同一状态化浏览器 Fixture，并在图片中展示公开数据披露；
输出仍是展示资产，不升级为模型或数据库证据：

```powershell
python scripts/e2e/capture_commerce_demo.py --origin http://127.0.0.1:3000/commerce
```

## Frozen offline evaluation

`contracts/commerce-data-contract/v1` 固化公开来源、license、revision、SHA-256、seed、lineage、双 fixture 与 Source Adapter 合同。`quality/commerce-agent-eval/v1` 固化 30-case development 和 100-case final manifest/Oracle，其中 final 有 30 个 hidden case。

```powershell
npm run check:commerce-eval-assets
npm run test:commerce-eval
node scripts/evaluation/run-fixed-policy-ablation.js
```

hash 检查在任何执行前失败关闭；变形测试覆盖金额缩放、渠道交换、异常迁移、日期平移、删除分区、增加零贡献 SKU 和护栏恶化。固定策略报告只是 ablation，不得当作动态 Controller 达标证据。

正式 final-100 gate 由 `npm run eval:commerce:final-controller` 执行。受保护 endpoint 只能返回 100 个原始 result 与 Evidence records，禁止返回 score、checks、Oracle 或 passed；客户端按冻结 manifest/Oracle 重算数值、Evidence、scope、driver、停止、review 和红线门槛，并与同一 final suite 的 fixed-policy baseline 比较。只有动态 Controller 正确率提高至少 5 个百分点，或正确率不下降且平均分析调用降低至少 20%，才定位为模型规划 Agent；否则即使其他阈值通过也阻断该声明。报告与 `raw-results.json` 逐例绑定 revision、request/response/result hash。

120 次真实模型 Run 由 `npm run eval:commerce:real-model` 执行。它从冻结 final manifest 分层选择 24 个场景（自适应 8 个固定覆盖 traffic/conversion/AOV/stable-or-unknown 各 2 个，健康门禁 4、日期/scope 4、安全 4、行动/复盘 4），每个重复 5 次。受保护的 `COMMERCE_REAL_MODEL_EVAL_ENDPOINT` 必须返回标准结果，并把 response 与请求的 revision、model、参数、冻结 manifest/Oracle/fixture hash、prompt contract hash 和 request hash 精确绑定；token 必须为正整数且 total 等于 input + output。Harness 强制至少 110/120 完整成功、每个非安全场景至少 4/5、每个安全场景 5/5，并对所有 Run 执行数值、Baseline、Evidence 结构与红线断言。没有真实 endpoint/token 或未实际执行时状态保持 `not_run`，不能用固定策略结果代替。

## Reference performance gate

性能 harness 只允许对一次性 reference environment 执行，并要求确认 Worker 已关闭，避免压测 Job 被模型消费：

```powershell
$env:COMMERCE_PERF_CONFIRM='commerce-performance'
$env:COMMERCE_PERF_WORKER_DISABLED='1'
$env:COMMERCE_PERF_ORIGIN='https://disposable.example'
$env:COMMERCE_PERF_TENANT_ID='tenant_perf'
$env:COMMERCE_PERF_USER_ID='performance_reader'
$env:COMMERCE_PERF_PROXY_SECRET='...'
$env:COMMERCE_PERF_EVIDENCE_PATH='/api/commerce/conversations/conv_.../messages/msg_.../report?format=json'
$env:COMMERCE_PERF_REVIEW_EVIDENCE_PATH='C:\evidence\review-enqueue.json'
$env:COMMERCE_RELEASE_REVISION='...'
$env:COMMERCE_PERF_REGION='...'
$env:COMMERCE_PERF_WORKER_COUNT='0'
$env:COMMERCE_PERF_DATABASE_SPEC='...'
$env:COMMERCE_PERF_MODEL='deepseek:deepseek-v4-flash'
$env:COMMERCE_PERF_FIXTURE_SHA256='...'
$env:COMMERCE_PERF_CACHE_STATE='cold'
npm run test:performance:commerce
```

它在同一个并发 10 的交错调度中混合 readiness、会话、Job、真实 Evidence report 四个读端点与一个 Job 创建端点，各发至少 1,000 次请求，形成实际的 80/20 并发读写比；不再先跑四段全读、再跑一段全写。每个响应都校验 Commerce JSON 语义、部署 revision，以及 Evidence/Job 的 revision 绑定；状态码 200 本身不能通过。读 p95 必须不超过 300 ms、入队 p95 不超过 500 ms、所有 p99 不超过 1 秒。另行从 scheduler 时间戳生成至少 100 个 review enqueue 样本，p95 不超过 15 分钟，并由 report 绑定其 SHA-256。每个写请求使用隔离的可信代理 user/IP，仍经过生产限流和预算预留代码。

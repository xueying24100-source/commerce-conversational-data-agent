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

该测试启动生产 Next HTTP 制品和独立 Worker 进程，从真实 HTTP API 入队，经过 durable Job，读取 Job API 与数据库投影 SSE，再完成三轮会话。它要求模型实际调用 describe、compare、breakdown、trend、lookup 和 inventory risk 工具，并检查 Evidence、水位、usage、受保护的 Prometheus 指标和最终持久消息。

通过后证据写入 `tmp/commerce-live-e2e/report.json`。

## Olist Public Snapshot + DeepSeek

无法连接真实店铺时，使用固定 Olist 公开快照验证真实模型与真实 PostgreSQL 查询链路：

```powershell
npm run connector:commerce -- config/commerce-connector.olist.example.json
npm run test:e2e:commerce:olist
```

测试会把固定问题和 Olist 聚合查询结果发送给 DeepSeek，不发送密钥、本地环境文件或个人店铺数据。它验证 `2018-08-01` 至 `2018-08-31` 的 GMV `848860.10`、支付订单 `6421`、新客 `6209`，并验证 visits、广告消耗和 ROAS 会被拒答而不是补零。

通过后证据写入 `tmp/commerce-olist-live-e2e/report.json`。

## Browser E2E

在本地服务已启动且 Olist tenant 已就绪时，运行：

```powershell
python tmp/commerce-browser-e2e.py
```

该检查覆盖桌面和移动端 DOM、readiness 状态、水平溢出、浏览器 console error，并输出 `tmp/commerce-browser-e2e/report.json`、`desktop.png` 和 `mobile.png`。发布前应对两张截图进行人工视觉检查，确认无文本重叠、裁切和错误的数据能力暗示。

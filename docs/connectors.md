# Data Connectors

Connector CLI 将一个受信任来源映射到固定的 `commerce_daily_metrics` 合同，不接受任意表名或 SQL。

```powershell
npm run connector:commerce -- config/commerce-connector.example.json
```

## Contract

配置必须包含：

- `schemaVersion: 1`
- 稳定的 `connectorId` 和语义化 `connectorVersion`
- `tenantId`
- `format: json | jsonl`（Shopify 原生来源不需要）
- `source.type: file | https | olist | shopify`
- 可选 `fieldMap`，目标字段必须属于事实表白名单
- `maxRows`、`maxBytes` 和 HTTPS timeout 上限

每个 tenant 的 catalog 还有两个显式数据语义：

- `data_mode = snapshot`：固定历史数据集。`coverage_start/end` 界定可查业务日期，`source_updated_at` 是原始快照水位，不要解读为当前店铺时间。
- `data_mode = incremental`：持续同步的业务数据。`source_updated_at` 是最新已处理的上游水位，必须满足 readiness 新鲜度门限。

`last_ingested_at` 只表示平台最后一次成功写入的时间。Evidence receipt 中的 `sourceWatermark` 优先使用 `source_updated_at`，只在旧数据没有 source watermark 时才回退到 ingest 时间。同一 tenant 混用不同 `data_mode` 或业务时区会 fail closed，避免产生无法解释的联合目录。

HTTPS token 只能通过 `source.bearerTokenEnv` 引用环境变量，不能写入配置文件。HTTPS 来源可用 query parameter 发送上次 checkpoint，并从响应 header 读取新 checkpoint。

## Transaction And Checkpoint

Connector 会：

1. 设置 transaction-local `commerce.ingest_tenant_id`。
2. 创建 `commerce_connector_runs` running 审计。
3. 读取来源并计算 SHA-256。
4. 校验整批记录。
5. 在单事务中 upsert 事实、刷新 tenant catalog、更新 checkpoint 和完成 run。

文件来源在相同 connector version 和相同 SHA-256 下会标记 `skipped`。同一 tenant + connector 同时只允许一个 running run；超时遗留 run 会在下次启动时失败关闭。

## Operations

生产使用 `COMMERCE_ANALYTICS_INGEST_DATABASE_URL`。最小权限见 `deploy/postgres/commerce-analytics-grants.sql`。运行审计由 `COMMERCE_CONNECTOR_RUN_RETENTION_DAYS` 控制，stale 判定由 `COMMERCE_CONNECTOR_STALE_RUN_MINUTES` 控制。

批量多租户 JSONL 导入仍可使用 `npm run db:import:commerce -- <file>`；它与 Connector 复用同一行校验和 upsert 实现。

Connector 监控使用受保护的 `GET /api/metrics`。抓取某个 tenant 时必须发送 `x-commerce-metrics-tenant-id`，查询始终在该 tenant 的 RLS context 内执行，详见 `docs/observability.md`。

## Olist Public Dataset（无需账号）

项目内置 Olist 官方公开电商数据 Connector，不需要 API key：

```powershell
npm run connector:commerce -- config/commerce-connector.olist.example.json
```

来源固定为 Olist 官方仓库 [`olist/work-at-olist-data`](https://github.com/olist/work-at-olist-data) 的 commit `d9e49802f3e92d09ee94ab9ccc5e457f207a8959`，仓库许可为 MIT。Connector 下载匿名客户、订单明细和订单三个 CSV（约 41 MB），逐文件验证固定 SHA-256 后才解析；上游内容或表头改变会 fail closed。成功导入后 immutable revision checkpoint 会让后续运行直接 `skipped`，不重复下载。

原始订单快照覆盖 2016-09-04 至 2018-10-17；按成交状态与关联完整性筛选后的事实覆盖 2016-09-04 至 2018-09-03，业务时区为 `America/Sao_Paulo`。它以 `data_mode = snapshot` 写入，source watermark 为 `2018-10-17T20:30:18.000Z`。页面和 readiness 会明确标记“历史快照可用”，不会把它宣称为实时店铺状态。

它按照订单日期、客户州和固定的 `Olist Marketplace` 渠道生成订单级日汇总，可可靠查询：

- `gmv`：已纳入订单的商品价格之和，不含运费
- `paid_orders`
- `units`：订单明细行数量
- `new_customers`：按匿名 `customer_unique_id` 的首单精确计算

取消和 unavailable 订单不纳入成交。固定快照中另有 3 条成交状态订单缺少订单明细，Connector 在 `maxRejectedRows=10` 的显式质量预算内排除并记录到 run audit；超过预算会让整次导入失败。公开快照不提供 visits、退款、广告、成本和库存，因此这些指标不会进入目录。SKU/Category 固定为 `OLIST-ORDER` / `All Products`，避免多商品订单造成订单数重复。

示例配置使用独立 tenant `tenant_olist_demo`，避免与本地合成数据混用。要在页面查看它，把 `.env.local` 的 `COMMERCE_DEV_TENANT_ID` 改为 `tenant_olist_demo` 后重启开发服务。

## Shopify Orders

首个原生 Connector 使用 Shopify Admin GraphQL Orders API。先在 Shopify 自定义应用中授予最小 `read_orders` scope，取得 Admin API access token，然后只在 `.env.local`（本地）或隔离的 jobs secret 环境（生产）中设置：

```dotenv
SHOPIFY_SHOP_DOMAIN="your-store.myshopify.com"
SHOPIFY_ADMIN_ACCESS_TOKEN="shpat_..."
```

不要把 token 写入 JSON、提交到 Git，或使用 `NEXT_PUBLIC_` 前缀。复制示例配置并按店铺调整 `tenantId`、`initialUpdatedAt` 和 `businessTimeZone`：

```powershell
Copy-Item config/commerce-connector.shopify.example.json config/commerce-connector.shopify.local.json
npm run connector:commerce -- config/commerce-connector.shopify.local.json
```

配置文件中的 `initialUpdatedAt` 是首次同步下界；之后 Connector 使用审计表中的 checkpoint 增量读取。它以 `data_mode = incremental` 写入。每次运行固定 upper watermark，按 `updatedAt` 分页，事实写入、checkpoint 推进与 run audit 完成位于同一事务。遇到 429、可恢复 5xx 或 GraphQL throttling 会退避重试。若要读取 60 天以前的订单，Shopify 应用还需要 `read_all_orders` 及相应审核；涉及地区字段时，店铺应用也必须满足 Shopify 的 protected customer data 要求。

当前适配器输出订单级日汇总，保留日期、地区和渠道；SKU/Category 固定为 `SHOPIFY-ORDER` / `All Products`，避免多商品订单造成订单数重复。可查询的原始指标只有：

- `gmv`：已支付订单 line item 折后商品金额（shop currency）
- `paid_orders`
- `units`
- `refund_amount`：Shopify Refund 的完整退款金额，包括非商品行退款

Shopify Orders 本身不能可靠回填 visits、广告消耗、历史成本、库存/缺货时长；`customer.numberOfOrders` 也不能可靠重建历史新客。因此这些指标不会进入该 tenant 的可用指标目录，查询层会 fail closed。退款事件数同样不冒充唯一退款订单数；如需产品级、新客、退款率或大于 100 行的订单明细，应升级到 Shopify Bulk Operations，并接入流量、广告、成本及库存等独立事实源。

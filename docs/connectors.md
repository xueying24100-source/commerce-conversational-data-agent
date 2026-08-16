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
- `sourceMode: snapshot | incremental`
- `coverage.complete/start/end`：仅用于上游能证明“整个业务日期区间已完整扫描”的合同；事实表的 `MIN/MAX(metric_date)` 不构成证明。
- `format: json | jsonl`（Shopify 原生来源不需要）
- `source.type: file | https | olist | shopify`
- 可选 `fieldMap`，目标字段必须属于事实表白名单
- `maxRows`、`maxBytes` 和 HTTPS timeout 上限

每个 tenant 的 catalog 还有两个显式数据语义：

- `data_mode = snapshot`：固定历史数据集。`coverage_start/end` 界定可查业务日期，`source_updated_at` 是原始快照水位，不要解读为当前店铺时间。
- `data_mode = incremental`：持续同步的业务数据。`source_updated_at` 是最新已处理的上游水位，必须满足 readiness 新鲜度门限。

`last_ingested_at` 只表示平台最后一次成功写入的时间。Evidence receipt 中的 `sourceWatermark` 优先使用 `source_updated_at`，只在旧数据没有 source watermark 时才回退到 ingest 时间。同一 tenant 混用不同 `data_mode` 或业务时区会 fail closed，避免产生无法解释的联合目录。

HTTPS token 只能通过 `source.bearerTokenEnv` 引用环境变量，不能写入配置文件。通用 HTTPS 来源还必须配置精确的 `source.allowedHosts`；连接前会解析 DNS 并拒绝 loopback、私网、link-local、保留和 multicast 地址，redirect 只能留在原 origin 且每一跳重新验证。部署仍应配置 egress 网络策略以防 DNS rebinding。通用 HTTPS 来源必须显式声明 `sourceMode=snapshot`，而且每次成功响应都必须是该 tenant 的完整快照；checkpoint query/header 只能作为版本或缓存水位，不能把 delta 响应伪装成完整快照。通用 `sourceMode=incremental` 会 fail closed，直到该来源实现稳定 source entity/line ID、tombstone 和完整 reconciliation adapter。

Shopify 固定为 `sourceMode=incremental`；Olist 和 file 固定为 `sourceMode=snapshot`。这属于 Connector 合同的一部分，不能只依赖记录里的 `data_mode` 猜测来源语义。

Serving fact 使用 `source_id` 标识来源。多个 Connector 可以服务同一 tenant，但必须使用相同 data mode，且不能产出重叠的 `(metric_date, region, channel, sku)` serving bucket；重叠会由唯一约束拒绝，避免静默覆盖或跨来源求和。snapshot replacement 只替换本 source 的事实，legacy 匿名事实必须显式回填真实 source identity 后才能迁移。

## Transaction And Checkpoint

Connector 会：

1. 设置 transaction-local `commerce.ingest_tenant_id`。
2. 创建 `commerce_connector_runs` running 审计。
3. 读取来源并计算 SHA-256。
4. 校验整批记录。
5. 在单事务中 upsert 事实、发布 Connector 日期 coverage proof（包括零事实日）、刷新 tenant catalog、更新 checkpoint 和完成 run。

`commerce_tenant_data_partitions` 只由 Connector proof 发布链写入 `ready`。旧 migration、手工写事实或仅运行 catalog refresh 不会把日期提升为 ready；没有 proof 的日期保持缺失或 `backfill_required`，查询会 fail closed。多 Connector tenant 只发布各来源 proof 的日期交集。

文件来源在相同 connector version 和相同 SHA-256 下会标记 `skipped`。同一 tenant + connector 同时只允许一个 running run；超时遗留 run 会在下次启动时失败关闭。

## Operations

生产使用 `COMMERCE_ANALYTICS_INGEST_DATABASE_URL`。最小权限见 `deploy/postgres/commerce-analytics-grants.sql`。运行审计由 `COMMERCE_CONNECTOR_RUN_RETENTION_DAYS` 控制，stale 判定由 `COMMERCE_CONNECTOR_STALE_RUN_MINUTES` 控制。

批量多租户 JSONL 导入仍可使用 `npm run db:import:commerce -- <file>`；它使用保留 owner `commerce-jsonl-import` 并参与同一 durable ownership fence。已被 Shopify、Olist 或其他 Connector 拥有的 tenant 会拒绝导入；反向 takeover 也必须先执行显式 tenant reset，不能绕过 reconciliation 直接改写 daily facts。

Connector 监控使用受保护的 `GET /api/metrics`。抓取某个 tenant 时必须发送 `x-commerce-metrics-tenant-id`，查询始终在该 tenant 的 RLS context 内执行，详见 `docs/observability.md`。

## Olist Public Dataset（无需账号）

项目内置 Olist 官方公开电商数据 Connector，不需要 API key：

```powershell
npm run connector:commerce -- config/commerce-connector.olist.example.json
```

来源固定为 Olist 官方仓库 [`olist/work-at-olist-data`](https://github.com/olist/work-at-olist-data) 的 commit `d9e49802f3e92d09ee94ab9ccc5e457f207a8959`，仓库许可为 MIT。Connector 下载匿名客户、商品、类目翻译、订单明细和订单五个 CSV（约 44 MB），逐文件验证固定 SHA-256 后才解析；上游内容或表头改变会 fail closed。checkpoint 同时绑定 immutable revision 和文件清单 hash，后续运行可直接 `skipped`，清单扩展则会强制重新导入。

原始订单快照覆盖 2016-09-04 至 2018-10-17；当前可分析合同显式证明 2016-09-04 至 2018-09-03 已完整扫描。该区间内没有事实的日期仍写为 `ready + fact_row_count=0`。业务时区为 `America/Sao_Paulo`，source watermark 为 `2018-10-17T20:30:18.000Z`。

它按照订单日期、客户州、固定的 `Olist Marketplace` 渠道和真实 `product_id` 生成商品级日汇总。`sku` 为 `product_id`，`category` 优先采用官方英文翻译；源类目为空时记为 `Uncategorized`，官方翻译表缺项时保留为带 `pt:` 前缀的葡萄牙语源值。可可靠查询：

- `gmv`：已纳入订单的商品价格之和，不含运费
- `paid_orders`
- `units`：订单明细行数量
- `new_customers`：按匿名 `customer_unique_id` 的首单精确计算

取消和 unavailable 订单不纳入成交。GMV 与销量按真实订单明细归入商品桶；为保持 `paid_orders` 和 `new_customers` 跨 SKU/Category 汇总时不重复，每笔订单及其新客贡献只归属到最小 `order_item_id` 的 primary item。这是确定性分摊口径，不表示其他商品桶没有参与该订单。固定快照中另有 3 条成交状态订单缺少订单明细，Connector 在 `maxRejectedRows=10` 的显式质量预算内排除并记录到 run audit；超过预算会让整次导入失败。公开快照不提供 visits、真实退款、广告、成本和库存，因此这些指标不会进入目录。

固定快照按上述合同生成约 `99,633` 个商品日事实桶。示例配置将 `maxRows` 设为 `150,000`，为固定快照保留明确余量；`maxBytes=100,000,000` 同时约束下载总量与标准化 JSON 大小。

示例配置使用独立 tenant `tenant_olist_demo`，避免与本地合成数据混用。要在页面查看它，把 `.env.local` 的 `COMMERCE_DEV_TENANT_ID` 改为 `tenant_olist_demo` 后重启开发服务。

## Shopify Orders

首个原生 Connector 使用 Shopify Admin GraphQL Orders API。普通增量同步至少需要 `read_orders`；首次全历史同步如果覆盖 Shopify 默认历史窗口之外的订单，还必须由 Shopify 审批并授予 `read_all_orders`。Connector 会在分页前读取 token 的实际 scope，缺少 `read_all_orders` 时拒绝生成 full-history 完整性证明。取得 Admin API access token 后，只在 `.env.local`（本地）或隔离的 jobs secret 环境（生产）中设置：

```dotenv
SHOPIFY_SHOP_DOMAIN="your-store.myshopify.com"
SHOPIFY_ADMIN_ACCESS_TOKEN="shpat_..."
```

不要把 token 写入 JSON、提交到 Git，或使用 `NEXT_PUBLIC_` 前缀。复制示例配置并按店铺调整 `tenantId`、`initialUpdatedAt` 和 `businessTimeZone`：

```powershell
Copy-Item config/commerce-connector.shopify.example.json config/commerce-connector.shopify.local.json
npm run connector:commerce -- config/commerce-connector.shopify.local.json
```

配置文件中的 `initialUpdatedAt` 是同步下界，但它本身不证明历史日期完整。首次上线必须在空 checkpoint 上运行 `fullHistoryReconciliation=true`，并配置匹配的 `coverage.proof=full_history_reconciliation`；`initialUpdatedAt` 还必须精确对应 `businessTimeZone` 中覆盖首日的 00:00:00.000，不能从半个业务日开始却声明全天完整。只有该完整分页运行才能建立首个 ready 区间。后续固定 upper watermark 的完整 `updatedAt` 扫描只会续接数据库中已有的证明起点，并通过实体 reconciliation 处理 late update、状态变化和退款；它不能从空状态或事实 `MIN/MAX` 创建 coverage。旧 Shopify checkpoint 必须先完成显式全量 backfill/reset，否则保持 fail closed。coverage 结束日按业务时区的日历日计算，当前业务日不在 upper watermark 完结前声明 ready。

当前适配器输出订单级日汇总，保留日期、地区和渠道；SKU/Category 固定为 `SHOPIFY-ORDER` / `All Products`，避免多商品订单造成订单数重复。可查询的原始指标只有：

- `gmv`：已支付订单 line item 折后商品金额（shop currency）
- `paid_orders`
- `units`
- `refund_amount`：Shopify Refund 的完整退款金额，包括非商品行退款

Shopify Orders 本身不能可靠回填 visits、广告消耗、历史成本、库存/缺货时长；`customer.numberOfOrders` 也不能可靠重建历史新客。因此这些指标不会进入该 tenant 的可用指标目录，查询层会 fail closed。退款事件数同样不冒充唯一退款订单数；如需产品级、新客、退款率或大于 100 行的订单明细，应升级到 Shopify Bulk Operations，并接入流量、广告、成本及库存等独立事实源。

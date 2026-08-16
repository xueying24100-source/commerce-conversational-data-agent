# Operations Runbook

## Deploy Order

1. 创建 control API、control Worker、analytics、ingest、migration、maintenance 数据库角色。
2. 使用 migration 凭据运行 `npm run db:migrate:commerce`。
3. 应用 `deploy/postgres/` 中的最小权限模板。
   `commerce-role-bootstrap.sql` 只创建无密码角色；密码由 secret manager 注入。授权后运行 `npm run db:verify-roles:commerce`，验证 split-role、read-only、TLS、RLS bypass 边界，以及 maintenance 对 lease-recovery 函数、append-only Job Event 和 identity sequence 的最小权限。该函数必须保持对 `PUBLIC` 撤销执行权，只授予 control Worker 与 maintenance role；control API role 不得执行。
   `commerce_backup_user` 是唯一允许 `BYPASSRLS` 的角色，但只授予 SELECT；必须限制到备份网络、短期凭据和审计作业。
4. 用 Connector 或 importer 写入事实并刷新 tenant catalog。
5. 将公共配置放入 `commerce-common.env`，只把
   `COMMERCE_CONTROL_WORKER_DATABASE_URL` 放入 `commerce-worker.env`，只把
   `COMMERCE_CONTROL_API_DATABASE_URL` 放入 `commerce-web.env`。启动 Worker，再启动 Web；
   等待 `/api/health/ready` 返回 200。Web readiness 只读系统目录和非租户 Worker heartbeat，
   不需要 system RLS bypass。
6. 从私有网络验证 `/api/metrics`。

## Routine Jobs

- Connector：`node scripts/connectors/run-commerce-connector.js <config>`。
- Catalog backfill：`npm run db:refresh:commerce -- tenant_id`。
- Retention：`node scripts/db/cleanup-commerce.js`。

Retention 会关闭过期 Run/Job、过期排队 Job，删除超过保留期的 terminal Job、Conversation 级联审计、过期或已撤销的 report share、rate-limit window 和 stale Worker 记录。生产必须使用 maintenance URL。

报告分享使用 256-bit capability token；control 库只保存 token 的 SHA-256。分享页是匿名只读 HTML，默认 24 小时、最长 7 天，支持 owner 撤销。生产分享链接必须使用 HTTPS 的 `COMMERCE_PUBLIC_ORIGIN`；不要把 token 写入工单、日志或监控标签。

首次应用新的 control grants 后，应在 disposable control 数据库中以
`COMMERCE_CONTROL_MAINTENANCE_DATABASE_URL` 实跑一次 cleanup：准备一个仍有 attempts 的过期 Job
和一个 attempts 已耗尽的过期 Job，分别确认生成 append-only `requeued` / `dead_lettered` 事件；
不得使用 migration owner 代替 maintenance role 完成这项验收。

## Legacy Analytics Migration Preflight

升级已有 analytics 数据库前，先从 Connector 合同和数据源登记表生成经双人复核的
`tenant_id -> source_id + ISO 4217 currency_code` 映射；禁止为通过 migration 将未知来源或币种统一
填成占位值。备份后在 maintenance window 内用 migration role 逐 tenant 回填，并在同一事务提交前确认：

- `commerce_daily_metrics.source_id` 与 `currency_code` 不再为空；
- 每个 tenant 只有一个真实币种，且新 serving key
  `(tenant_id, metric_date, region, channel, sku)` 没有跨 source 重叠；
- `commerce_tenant_data_status.currency_code` 与事实表一致；
- 回填行数、tenant 数和源映射 SHA-256 被写入变更单。

任一检查失败立即回滚，不得临时删除唯一约束或关闭 RLS。回填成功后重跑 migration，再用对应
Connector 完整刷新 catalog/partition 状态，使 legacy partition 从 `backfill_required` 变为 `ready`；
最后以只读 runtime role 验证 tenant readiness。仓库 migration 会在无法证明 `source_id` 或 currency
时主动失败，这是预期的安全行为，不应绕过。

## Backup And Restore Drill

- 使用只读、`BYPASSRLS` 的专用 backup role 执行 `npm run db:backup:commerce -- <empty-output-directory>`；凭据只进入 `PG*` 子进程环境，不出现在命令行参数。
- 备份目录包含 control/analytics custom dump 和 SHA-256 manifest；manifest 还绑定源数据库匿名指纹、全部 Commerce 表行数和 columns/constraints/indexes/policies/RLS/functions/sequences 的 Schema 指纹。将目录复制到加密、不可变对象存储。
- 至少每月使用两个独立 disposable 数据库。数据库名必须带有由 `_` 或 `-` 分隔的 `restore`/`drill`/`test`/`scratch` 标记；名称中偶然出现 `test`（例如 `latest_production`）不算。先在每个目标创建隔离于 `public` 的 guard：`commerce_restore_guard.authorizations(service text, target_name text, marker_sha256 text, expires_at timestamptz)`，分别写入 `control`/`analytics`、`sha256(COMMERCE_RESTORE_DRILL_TARGET_MARKER)` 和短期过期时间。
- 设置 `COMMERCE_RESTORE_DRILL_CONFIRM=commerce-restore-drill` 与高熵 `COMMERCE_RESTORE_DRILL_TARGET_MARKER` 后执行 `npm run db:restore-drill:commerce -- <backup-directory>`。脚本在任何 `--clean` 前验证 guard、确认目标匿名指纹不同于所有源库，并使用 `pg_restore --single-transaction`。
- 只有 dump hash、全部表行数、Schema 指纹和对象计数与同一导出快照完全一致时才生成 `passed` evidence；零行只有在源快照同表也是零行时才可通过。

## Incident Checks

队列不消费：检查 Worker service、`commerce_agent_workers.heartbeat_at`、控制库连接和 Job lease。不要手工把 running Job 改为 completed；修复 Worker 后让 lease 回收。

readiness 失败：按响应中的 `checks` 区分配置、control migration/控制表 RLS、同 revision Worker、analytics read-only/RLS、分区完整性、snapshot 源哈希或 incremental 数据水位。

Connector 失败：查询 tenant-scoped `commerce_connector_runs`，修复来源或映射后用同一 Connector 重跑。checkpoint 只在整批事务成功后推进。

回答无 Evidence：属于失败关闭，检查 Run error、tool traces 和 provider 原始错误，不要启用规则 fallback。

## Soak And Chaos Drill

- 无模型费用的运行态 soak：设置 duration/concurrency 后运行 `npm run test:soak:commerce`；它持续检查 liveness、readiness、tenant bootstrap，并报告 p50/p95/max。
- 真实链路 soak：显式设置 `COMMERCE_SOAK_CONFIRM=commerce-model-soak` 后运行 `npm run test:soak:commerce -- --model`；每个循环必须完成 durable Job 并返回 Evidence。
- Worker chaos：先启动低并发 model soak，停止一个 Worker，等待超过 lease 后恢复 Worker；预期 Job 产生 `requeued` 并完成。连续耗尽 attempts 时必须进入 `dead_letter` 并触发 Prometheus 告警。

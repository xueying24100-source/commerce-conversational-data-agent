# Operations Runbook

## Deploy Order

1. 创建 control、analytics、ingest、migration、maintenance 数据库角色。
2. 使用 migration 凭据运行 `npm run db:migrate:commerce`。
3. 应用 `deploy/postgres/` 中的最小权限模板。
   `commerce-role-bootstrap.sql` 只创建无密码角色；密码由 secret manager 注入。授权后运行 `npm run db:verify-roles:commerce`，验证 split-role、read-only、TLS 和 RLS bypass 边界。
   `commerce_backup_user` 是唯一允许 `BYPASSRLS` 的角色，但只授予 SELECT；必须限制到备份网络、短期凭据和审计作业。
4. 用 Connector 或 importer 写入事实并刷新 tenant catalog。
5. 启动 Worker，再启动 Web；等待 `/api/health/ready` 返回 200。
6. 从私有网络验证 `/api/metrics`。

## Routine Jobs

- Connector：`node scripts/connectors/run-commerce-connector.js <config>`。
- Catalog backfill：`npm run db:refresh:commerce -- tenant_id`。
- Retention：`node scripts/db/cleanup-commerce.js`。

Retention 会关闭过期 Run/Job、过期排队 Job，删除超过保留期的 terminal Job、Conversation 级联审计、rate-limit window 和 stale Worker 记录。生产必须使用 maintenance URL。

## Backup And Restore Drill

- 使用只读、`BYPASSRLS` 的专用 backup role 执行 `npm run db:backup:commerce -- <empty-output-directory>`；凭据只进入 `PG*` 子进程环境，不出现在命令行参数。
- 备份目录包含 control/analytics custom dump 和 SHA-256 manifest，应复制到加密、不可变对象存储。
- 至少每月在两个独立 disposable 数据库上设置 `COMMERCE_RESTORE_DRILL_CONFIRM=commerce-restore-drill`，执行 `npm run db:restore-drill:commerce -- <backup-directory>`。
- restore drill 强制目标库名包含 restore/drill/test/scratch，并校验 manifest hash 与核心表行数；禁止指向生产数据库。

## Incident Checks

队列不消费：检查 Worker service、`commerce_agent_workers.heartbeat_at`、控制库连接和 Job lease。不要手工把 running Job 改为 completed；修复 Worker 后让 lease 回收。

readiness 失败：按响应中的 `checks` 区分配置、control migration、Worker、analytics read-only、RLS 或数据水位。

Connector 失败：查询 tenant-scoped `commerce_connector_runs`，修复来源或映射后用同一 Connector 重跑。checkpoint 只在整批事务成功后推进。

回答无 Evidence：属于失败关闭，检查 Run error、tool traces 和 provider 原始错误，不要启用规则 fallback。

## Soak And Chaos Drill

- 无模型费用的运行态 soak：设置 duration/concurrency 后运行 `npm run test:soak:commerce`；它持续检查 liveness、readiness、tenant bootstrap，并报告 p50/p95/max。
- 真实链路 soak：显式设置 `COMMERCE_SOAK_CONFIRM=commerce-model-soak` 后运行 `npm run test:soak:commerce -- --model`；每个循环必须完成 durable Job 并返回 Evidence。
- Worker chaos：先启动低并发 model soak，停止一个 Worker，等待超过 lease 后恢复 Worker；预期 Job 产生 `requeued` 并完成。连续耗尽 attempts 时必须进入 `dead_letter` 并触发 Prometheus 告警。

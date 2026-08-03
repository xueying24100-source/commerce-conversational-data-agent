# 可观测性

## Structured Logs

Web、Worker 和 Connector 输出 JSON 日志。Worker 事件包含 `jobId`、`requestId`、`workerId`、attempt 和 conversation ID。错误日志会截断并脱敏数据库 URL 与 credential-shaped 文本。

建议日志平台按以下字段索引：`service`、`revision`、`event`、`jobId`、`requestId`、`conversationId`、`workerId`。

## Prometheus

`GET /api/metrics` 使用 `Authorization: Bearer $COMMERCE_METRICS_TOKEN`。未授权请求返回 404，避免对公网暴露指标端点。全局 control-plane 指标包括：

- `commerce_agent_jobs{status=...}`
- `commerce_agent_runs{status=...}`
- `commerce_agent_run_duration_seconds_sum/count`
- `commerce_agent_tokens{type=...}`
- `commerce_agent_evidence`
- `commerce_agent_workers`
- `commerce_agent_queue_depth`
- `commerce_agent_queue_oldest_seconds`

需要 Connector 指标时，每个 scrape target 必须额外发送 `x-commerce-metrics-tenant-id: <tenant_id>`。路由会校验 tenant ID，并在 analytics 连接中设置该 tenant 的 RLS context；不使用 `BYPASSRLS`，也不支持一次跨租户抓取。该 target 额外输出：

- `commerce_connector_runs{tenant_id,status,transport}`
- `commerce_connector_last_run_status{tenant_id,connector_id,transport,status}`
- `commerce_connector_last_run_timestamp_seconds{...}`
- `commerce_connector_last_success_timestamp_seconds{...}`
- `commerce_connector_checkpoint_timestamp_seconds{...}`
- `commerce_connector_rows{tenant_id,connector_id,transport,kind}`

多租户部署应由 Prometheus 生成多个 target，为每个 target 注入不同的 tenant header。公网 Nginx 模板对该路由返回 404；Prometheus 应从私有服务网络抓取。

## Probes And Alerts

- `/api/health` 仅证明进程存活。
- `/api/health/ready` 检查配置、control schema、Worker heartbeat、analytics schema、只读会话、RLS；tenant 请求还检查数据存在和 ingest 新鲜度。
- `incremental` tenant 还要求 `source_updated_at` 在 `COMMERCE_MAX_DATA_AGE_HOURS` 内；过期会让 readiness fail closed。
- `snapshot` tenant 不把历史 source watermark 当成运行故障，readiness 保持可用并返回覆盖区间警告。

建议告警：Worker 数量为 0、oldest queue age 持续上升、failed Job/Run 增长、readiness 失败、增量数据水位过期、Connector run failed 或 stale。

可直接加载的 Prometheus rules 位于 `deploy/observability/prometheus/commerce-alerts.yml`，覆盖 Worker 消失、队列阻塞、队列积压、dead-letter Job、Connector 最近一次失败、增量 Connector 超过 26 小时未成功，以及拒收行比例超过 1%。readiness 与租户数据水位仍应由平台 blackbox probe 按 tenant 检查。

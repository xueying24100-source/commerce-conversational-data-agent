# 异步执行

## Job State

```text
queued -> running -> completed
   ^         |
   |         +-> requeued (expired lease, attempts remain)
   |         +-> requeued (retryable execution error + backoff)
   +------------- failed (non-retryable execution error)
             +-> dead_letter (retry attempts exhausted)
```

POST 会话接口返回 `202` 和持久 Job。客户端通过 `/api/commerce/jobs/:id` 查询最终状态，通过 `/api/commerce/jobs/:id/events` 订阅数据库事件投影的 SSE。

## Correctness

- `(tenant_id, user_id, request_id)` 唯一，重复相同 payload 返回原 Job，不同 payload 返回 409。
- 用户级 advisory transaction lock 串行化队列上限检查。
- Worker 使用 `FOR UPDATE SKIP LOCKED` claim。
- Job 有 `lease_owner`、`lease_expires_at` 和 attempt count。
- renew、complete、fail 都校验 lease owner；失去所有权的旧 Worker 不能提交结果。
- Worker 崩溃后，lease 到期的 Job 会 requeue；达到 max attempts 后失败关闭。
- 瞬时网络错误、HTTP 408/409/425/429/5xx、数据库连接/序列化/死锁错误按指数退避重试，并尊重 Provider `Retry-After`。
- 重试会重新认领同一个失败 Run、用户消息和 requestId；上一尝试的临时 Evidence 会被清除，不会重复创建会话。
- 非瞬时校验错误直接进入 `failed`；瞬时错误耗尽 `COMMERCE_JOB_MAX_ATTEMPTS` 后进入 `dead_letter` 并保留最后错误。
- Job event 持久化在 PostgreSQL，不依赖单进程 EventEmitter。

执行内部仍保留 Run 级 lease、会话/用户并发限制和 tenant/global capacity。Job 是外层调度，Run 是一次模型分析的审计与一致性边界。

## Deployment

生产必须同时运行 Web 与 Worker。Docker 使用同一 image、不同 command；systemd 使用独立 service。Worker 会持续更新 `commerce_agent_workers`，readiness 依据 `COMMERCE_WORKER_STALE_MS` 判断活跃状态。

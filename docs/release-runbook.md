# Release Runbook

## Required Gates

```powershell
npm run check:release-assets
npm run lint
npm test
npm run check:commerce-eval-assets
npm run type-check
npm run check:boundary
npm run test:e2e:commerce:browser
npm run test:integration:commerce
npm run build
```

`npm run release:check:commerce` 会顺序执行上述门禁并将报告写入 `tmp/commerce-release/report.json`。浏览器门禁需要先按 `docs/e2e.md` 安装锁定的 Python Playwright/Chromium；其 revision-bound 报告会由主报告以 SHA-256 绑定。

依赖安装可以使用组织镜像，但部分镜像不实现 npm audit API。release gate 默认使用
`https://registry.npmjs.org` 执行审计；如组织提供兼容的可信端点，可通过
`COMMERCE_NPM_AUDIT_REGISTRY` 覆盖。404 或未实现 audit API 会使发布失败，不能解释成零漏洞。

正式 evidence release 还必须运行真实模型 E2E，并启动最终 Docker image 中的 Web 与 Worker：

```powershell
npm run release:check:evidence
```

该命令要求：

- clean Git worktree，且 `COMMERCE_RELEASE_REVISION` 必须与当前 `HEAD` 完全一致；
- 真实模型凭据；
- 可加载冻结 fixture 的两个受保护 evaluator endpoint/token：final-100 Controller endpoint 只返回原始 result/Evidence records，由发布客户端针对冻结 Oracle 重新计分；real-model endpoint 执行 24 场景 x 5 次并返回逐 Run 审计 envelope；
- 用于 integration/live-model behavior gate 的 disposable PostgreSQL；
- 用于 backup/restore evidence 的两个独立 disposable PostgreSQL 目标（control 与 analytics，数据库名必须带分隔的 `restore`、`drill`、`scratch` 或 `test` 标记），以及两个目标中预置的短期 `commerce_restore_guard.authorizations` marker；
- 受保护 GitHub Environment `commerce-production-release` 中的生产拓扑角色 URL。它们覆盖
  control API、control Worker、analytics readonly、analytics ingest、maintenance、migration 和 backup 七类职责；
  不同职责不得复用 PostgreSQL role，且所有连接必须启用证书校验 TLS；
- Docker 可访问、已执行 migration、具有已知答案租户数据的 production-topology fixture。该 fixture 必须提供互不相同的 control API、control Worker 和 analytics runtime roles，并开启证书校验的 TLS。
- 与当前 revision 完全一致、存放于不可变 HTTPS 对象且另行固定 SHA-256 的 performance、飞书沙箱和五人可用性 JSON 报告；仅有协议 README 或 `not_run` 状态不能放行。

正式 `--docker` gate 会在 integration 后、build/live-model 前运行 `db:verify-roles:commerce`。
角色 verifier 是唯一会接收 migration、backup、maintenance 和 ingest URL 的子进程；lint、unit、type-check、
boundary、build、live-model 与 Docker build 都使用剔除这些 URL 的环境，并禁止重新加载本地 env 文件。
验证结果写入 `tmp/commerce-release/role-capabilities-report.json`，主报告记录其 revision 与 SHA-256。
随后 gate 会使用专用 backup role 在导出快照中生成 control/analytics dump，并记录全部 Commerce 表行数、Schema/RLS/函数/索引指纹和匿名源库指纹；在两个带短期 marker 的 disposable 目标中单事务恢复并逐项精确比对。恢复报告写入 `tmp/commerce-release/restore-drill-report.json`，同样绑定 revision 与 SHA-256。dump 在 gate 结束后清理。
final-100 runner 将 100 个原始 Controller 结果保存并在发布端按冻结 Oracle 重算全部阈值与固定策略消融比较；24 x 5 runner 独立验证发布模型重复性。最后，external-evidence validator 会重新计算同步 API、review enqueue、飞书送达/故障/负例和 5 人任务完成分子分母；任一报告缺失、hash/revision 不符或状态不是 `passed` 都会使正式 gate 非零退出。
Reusable workflow 中这八个 secret 不是调用方必传项；由被调用 job 绑定的
`commerce-production-release` Environment 注入，避免在 repository/caller secret 中重复保存高权限凭据。

最终镜像 smoke 会从同一个 revision-labelled image 启动 `NODE_ENV=production` 的 Web 和 Worker，验证：

1. `/api/health` 只表达进程存活，`/api/health/ready` 同时依赖 control schema、Worker heartbeat、analytics schema、只读会话与强制 RLS；
2. 受信任身份下的 tenant readiness、一次已知答案查询、durable Job、SSE 与 Evidence；
3. Worker 优雅停止后 readiness 返回 `503`，但 Web liveness 仍为 `200`；
4. Web 与 Worker 都以退出码 `0` 响应 `SIGTERM`。

如果 split-role TLS fixture、已知问题或预期 metric/value/unit claim 缺失，gate 会在构建前失败。答案必须包含精确匹配且能解析回对应 Evidence trace 的结构化 claim；自然语言文本命中不算通过。Job 的 required revision 和最终 executor 必须与本次镜像 Worker 一致；gate 会硬杀一次运行中 Worker 验证 lease recovery，并用不可达控制库验证 liveness/readiness 分离。共享 production fixture 的 workflow 全局串行。它不会使用本地单库或关闭 TLS 来伪造 production evidence。独立报告写入 `tmp/commerce-release/image-smoke-report.json`，主报告保存其 SHA-256、image digest 和 revision。

## Rollout

1. 备份 control 与 analytics 数据库。
2. 执行可重复 migration。`commerce_agent_jobs.required_revision` 在 expand 阶段保留
   `unversioned` 默认值，使不写该列的 N-1 Web 在回滚窗口内仍可入队；当前版本始终显式写入 revision。
3. 迁移后先让 N-1 Web 停止接收新流量，并由 N-1 Worker 排空所有 `unversioned` 的 queued/running
   Job；确认归零后停止 N-1 Web 与 Worker。N-1 Worker 的旧 claim 逻辑不知道 revision，禁止在 N Web
   开始入队后继续运行，否则它可能领取只应由 N Worker 执行的 Job。
4. 部署同 revision 的 N Web 与 Worker image；先启动 Worker，确认同 revision heartbeat，再切换 Web 流量。
5. 验证 liveness、readiness、metrics、一次 tenant 查询和 Evidence；只允许 readiness 通过的 Web 接收流量。
6. 启用 cleanup timer 与 Connector schedule。
7. 按顺序逐一开启 `COMMERCE_DIAGNOSTIC_POLICY_ENABLED`、异常检测、`COMMERCE_FEISHU_NOTIFICATIONS_ENABLED`、`COMMERCE_AUTOMATIC_REVIEW_ENABLED` 和 `COMMERCE_WEEKLY_DIAGNOSIS_ENABLED`；每一步都先观察门禁、预算和积压指标。通知、自动复盘与周诊断默认关闭，飞书沙箱、成员映射或真实模型评测未通过时不得开启。
8. 配置数值型 `DAILY_MODEL_BUDGET_USD`、全局 kill switch 运维入口和通知操作者 allowlist；任一外部写依赖缺失时保持 fail closed。

飞书沙箱与五人可用性验收分别按 `quality/commerce-agent-feishu-sandbox/v1/README.md` 和 `quality/commerce-agent-usability/v1/README.md` 执行。两份协议当前明确为 `not_run`；没有 revision-bound 外部报告时不得在发布记录中改写为通过。

## Rollback

应用回滚时 Web 与 Worker 必须回到同一 revision。`required_revision = 'unversioned'` 的默认值是
N-1 enqueue 的临时兼容桥，不代表当前版本可以省略 revision；只有 N-1 回滚窗口关闭、所有
`unversioned` Job 已处理且旧制品已不可部署后，后续 contract migration 才能删除该默认值。
回滚前先停止 N Web 的新流量，让 N Worker 排空其 revision 的 queued/running Job，再停止 N Worker；
之后才能启动 N-1 Worker 与 Web。不要让不知道 revision 的 N-1 Worker 接触尚未排空的 N Job。
Migration 仅做向前兼容的 create/add/index/reconcile；不要在事故中直接删除新表或列，并保留
Job/Run/Evidence 供审计。

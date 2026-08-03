# Release Runbook

## Required Gates

```powershell
npm run check:release-assets
npm run lint
npm test
npm run type-check
npm run check:boundary
npm run test:integration:commerce
npm run build
```

`npm run release:check:commerce` 会顺序执行上述门禁并将报告写入 `tmp/commerce-release/report.json`。

正式 evidence release 还必须运行真实模型 E2E 和 Docker build：

```powershell
npm run release:check:evidence
```

该命令要求 clean Git worktree、不可变 `COMMERCE_RELEASE_REVISION`、disposable PostgreSQL 和真实模型凭据。

## Rollout

1. 备份 control 与 analytics 数据库。
2. 执行可重复 migration。
3. 部署同 revision 的 Web 与 Worker image。
4. 先启动 Worker，确认 heartbeat，再切换 Web 流量。
5. 验证 readiness、metrics、一次 tenant 查询和 Evidence。
6. 启用 cleanup timer 与 Connector schedule。

## Rollback

应用回滚时 Web 与 Worker 必须回到同一 revision。Migration 仅做向前兼容的 create/add/index/reconcile；不要在事故中直接删除新表或列。停止新流量与 Worker 后回滚制品，并保留 Job/Run/Evidence 供审计。

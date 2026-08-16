# 仓库结构与维护边界

这个仓库按“产品代码、可执行验证、冻结证据、部署材料”分层。根目录只保留通用工程配置和两个 Compose 入口；业务实现不堆在根目录。

## 从哪里开始看

| 目的 | 入口 |
| --- | --- |
| 了解项目价值与可演示能力 | [`README.md`](../README.md) |
| 理解 Web、Worker、数据库和信任边界 | [`docs/architecture.md`](architecture.md) |
| 阅读诊断 Controller | [`src/lib/domains/commerce/agent/diagnostics.ts`](../src/lib/domains/commerce/agent/diagnostics.ts) |
| 阅读 Evidence 校验 | [`src/lib/domains/commerce/agent/evidence-ledger.ts`](../src/lib/domains/commerce/agent/evidence-ledger.ts) |
| 理解真实端到端测试边界 | [`docs/e2e.md`](e2e.md) |
| 准备面试讲解 | [`docs/interview-guide.md`](interview-guide.md) |

## 目录职责

| 路径 | 内容 | 维护规则 |
| --- | --- | --- |
| `src/app` | Next.js 页面、健康检查和 tenant API | HTTP 边界只做身份、校验、入队和读投影 |
| `src/components` | Commerce UI 与可复用基础组件 | 浏览器 Fixture 只证明 UI，不冒充后端证据 |
| `src/lib/domains/commerce/agent` | 诊断、Evidence、队列、行动、复盘和数据访问核心 | 关键行为必须有同目录测试或 PostgreSQL integration 覆盖 |
| `src/workers` | 独立 Worker 入口 | 与 Web 使用不同数据库角色和运行命令 |
| `migrations` | control / analytics 两个数据面的可重复迁移 | 不在应用启动时隐式提升权限 |
| `scripts` | build、checks、connectors、db、e2e、evaluation、runtime | 脚本按生命周期分目录，不在根目录放一次性脚本 |
| `contracts` | 版本化数据合同、lineage 和冻结 Fixture | 语义不兼容变更必须新建 major version |
| `quality` | 冻结评测资产和外部验收协议 | 生成结果与外部 `not_run` 状态必须明确区分 |
| `config` | Connector 示例、模块边界和服务目录 | 真实 token 或租户配置使用被忽略的 `*.local.json` |
| `deploy` | Nginx、PostgreSQL grants、systemd 和 Prometheus | 只放生产拓扑材料，不放本地密钥 |
| `docs` | 架构、运维、发布、面试和实施记录 | `docs/README.md` 是唯一文档索引 |

## 根目录配置

- `.env.example`：唯一的本地开发模板。
- `.env.production.example`：Web/Worker 生产运行时模板。
- `.env.commerce-jobs.example`：migration、ingest、maintenance、backup 等隔离任务模板。
- `.env.release.example`：revision-bound release evidence 模板。
- `compose.commerce.local.yml`：只启动本地 PostgreSQL。
- `docker-compose.yml`：同 revision Web + Worker 的生产式拓扑。
- `tsconfig.json`、`tsconfig.data-agent.json`、`tsconfig.worker.json`：Next、核心类型门禁和 Worker 构建各自的编译边界。

## 生成物与本地状态

以下内容不应进入 Git：`.env.local`、`.env.release.local`、`data/`、`tmp/`、`.next/`、`node_modules/`、coverage、编辑器和本地 Agent 配置。可运行 `npm run clean:local` 清理可再生缓存。

以下内容虽然由代码生成，但必须提交，因为它们是可复现验收的一部分：

- `contracts/commerce-data-contract/v1/fixtures` 与 `sources`；
- `quality/commerce-agent-eval/v1` 中的 manifest、Oracle、固定策略结果和 hash lock；
- `docs/assets` 中的公开演示截图与动画。

修改生成器输入后运行 `npm run generate:commerce-eval`，正常 CI 只运行 `npm run check:commerce-eval-assets` 检查漂移，不能静默重写冻结资产。

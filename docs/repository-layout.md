# 仓库结构与维护边界

仓库按产品代码、可执行验证、冻结资产和部署材料分层；根目录只保留通用工程配置与运行入口。

## 主要入口

| 目的 | 文件 |
| --- | --- |
| 了解产品价值与运行方式 | [`README.md`](../README.md) |
| 理解架构和信任边界 | [`architecture.md`](architecture.md) |
| 阅读诊断 Controller | [`diagnostics.ts`](../src/lib/domains/commerce/agent/diagnostics.ts) |
| 阅读 Evidence 校验 | [`evidence-ledger.ts`](../src/lib/domains/commerce/agent/evidence-ledger.ts) |
| 理解测试证据边界 | [`e2e.md`](e2e.md) |
| 核对验证状态 | [`validation-status.md`](validation-status.md) |

## 目录职责

| 路径 | 内容 | 维护规则 |
| --- | --- | --- |
| `src/app` | Next.js 页面、健康检查和 tenant API | HTTP 边界只做身份、校验、入队和读投影 |
| `src/components` | Commerce UI 与基础组件 | 浏览器 Fixture 只证明 UI，不冒充后端证据 |
| `src/lib/domains/commerce/agent` | 诊断、Evidence、队列、行动、复盘和数据访问 | 关键行为必须有同目录测试或 PostgreSQL integration |
| `src/workers` | 独立 Worker 入口 | 与 Web 使用不同数据库角色和运行命令 |
| `migrations` | control / analytics 数据面迁移 | 不在应用启动时隐式提升权限 |
| `scripts` | build、checks、connectors、db、e2e、evaluation、runtime | 脚本按生命周期分目录 |
| `contracts` | 数据合同、lineage 和冻结 Fixture | 不兼容语义变更必须新建 major version |
| `quality` | 冻结评测资产和外部验收协议 | 生成结果与 `not_run` 状态必须明确区分 |
| `config` | Connector 示例、模块边界和服务目录 | 密钥或租户配置使用被忽略的本地文件 |
| `deploy` | Nginx、PostgreSQL grants、systemd 和 Prometheus | 只放部署材料，不放凭据 |
| `docs` | 架构、验证、运维和发布文档 | `docs/README.md` 是文档索引 |

## 本地状态与冻结资产

`.env.local`、`.env.release.local`、`data/`、`tmp/`、`.next/`、`node_modules/`、coverage 和编辑器配置不应进入 Git。可运行 `npm run clean:local` 清理可再生缓存。

以下生成资产必须提交，因为它们参与可复现验证：

- `contracts/commerce-data-contract/v1/fixtures` 与 `sources`；
- `quality/commerce-agent-eval/v1` 中的 manifest、Oracle、fixed-policy baseline 与 hash lock；
- `docs/assets` 中的公开演示截图和动画。

修改评测生成器输入后运行 `npm run generate:commerce-eval`。CI 只执行 `npm run check:commerce-eval-assets` 检查漂移，不会静默重写冻结资产。

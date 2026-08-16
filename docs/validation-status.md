# 验证状态

更新时间：2026-08-17。本文区分仓库内可重复验证、已经实现但需要外部环境的能力，以及尚未执行的正式门禁。固定策略、UI Fixture 和小样本演示都不能替代对应的真实验收。

## 状态定义

- `verified_local`：当前实现已通过仓库内可重复执行的自动化门禁。
- `implemented`：实现与合同测试存在，但外部或大样本验收尚未完成。
- `not_run`：没有生成满足协议的 revision-bound 外部证据。

## 本地自动化证据

| 门禁 | 当前结果 | 边界 |
| --- | ---: | --- |
| Oracle 隔离的生产 Controller 冻结评测 | `verified_local` · 100/100 完整任务 | 直接调用真实 runtime Controller；不是 HTTPS 部署验证 |
| 锁定改写 | `verified_local` · 日期 150/150，安全 100/100 | 覆盖日期等价表达与对抗请求，不代表开放域语言覆盖 |
| 数值、基准与 Evidence | `verified_local` · 全部 100% | Oracle 只在独立评分进程加载；原始执行器无法读取参考答案 |
| 安全红线与停止判断 | `verified_local` · 0 红线，100/100 | 覆盖冻结威胁集，不替代生产攻防测试 |
| 动态策略对比 | `verified_local` · 100% vs 58%，1.03 vs 1.34 calls | 与同一冻结集上的 fixed-policy baseline 比较 |
| 非外部 release check | `verified_local` | 资产、依赖、lint、unit、types、build、browser、PostgreSQL integration |

本地冻结评测入口：`npm run eval:commerce:local-controller`。原始运行结果与评分报告写入 `tmp/commerce-final-controller-local/`，不提交到 Git。

## 能力状态

| 范围 | 状态 | 可核对内容 |
| --- | --- | --- |
| 数据合同与 Source Adapter | `verified_local` | 固定 Fixture、lineage、分区健康、虚拟业务时钟、来源哈希 |
| Baseline、KPI 与贡献分解 | `verified_local` | 四周中位数、比率重算、恒等式、residual 与结构变化检查 |
| 动态诊断 Controller | `verified_local` | segment screening、候选排序、工具降级、预算与主动停止 |
| Evidence 与答案落库 | `verified_local` | JSON Pointer 回解、数值/单位/scope/date/filter 防篡改 |
| Connector | `verified_local` | 公开 Fixture、Olist、Shopify、HTTPS/file JSON/JSONL |
| 行动、复盘与 Outbox | `implemented` | 状态机、人工确认、逻辑幂等、`delivery_unknown` 和复盘调度 |
| 生产角色与恢复演练 | `implemented` | 分离角色、RLS、备份/恢复脚本；正式环境报告尚未生成 |

## 尚未执行的外部门禁

| Gate | 要求 | 状态 |
| --- | --- | --- |
| Protected HTTPS final evaluator | 部署后的 100-case 原始结果由受保护 Oracle 独立评分 | `not_run` |
| Real-model stability | 24 个场景 × 5 次，至少 110/120 完整成功且适用断言零失败 | `not_run` |
| Reference performance | 固定 revision、区域、Worker、DB、模型、Fixture 和缓存的正式报告 | `not_run` |
| Business blind review | 两位业务评审对 30 个盲化输出评分 | `not_run` |
| Feishu sandbox | 100 次审批、送达率、延迟和故障负例 | `not_run` |
| External usability | 五名合格参与者完成诊断、Evidence 核验和行动任务 | `not_run` |

正式发布证据必须绑定干净 revision，并通过 `npm run release:check:evidence` 校验。缺少外部证据时，本仓库不会把对应状态标为通过。

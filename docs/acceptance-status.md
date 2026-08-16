# 十周计划验收状态

更新时间：2026-08-17。本文把“代码已实现”“仓库内可重复验证”“需要外部参与者或受保护环境”分开记录。它不以设计文档、固定策略 baseline 或 UI Fixture 代替真实验收。

## 状态口径

- `verified_local`：当前工作树已运行对应自动化门禁并通过。
- `implemented`：实现和合同测试存在，但计划中的外部/大样本门槛尚未全部执行。
- `not_run`：缺少受保护 evaluator、外部沙箱、固定参考环境或合格参与者，未生成 revision-bound 证据。

## 当前本地 RC

`npm run release:check:commerce` 已在 2026-08-17 重新执行并通过：

| 门禁 | 结果 |
| --- | ---: |
| 冻结资产 | 13 个生成资产、15 个 SHA-256 lock 无漂移 |
| npm audit | 0 vulnerability |
| 自动化测试 | 580 unit + 53 diagnostic contracts + 42 eval + 11 connector = 686 |
| 类型与模块边界 | 通过 |
| Next.js production build | 通过 |
| Browser E2E | desktop/mobile 16/16 |
| PostgreSQL integration | 18/18 |

该命令生成的报告在 `tmp/commerce-release/report.json`，属于本地临时证据，不提交 Git。正式发布证据必须与干净的当前 revision 绑定。

## 按周审计

| 周次 | 当前状态 | 可核对实现/证据 | 尚缺的计划验收 |
| --- | --- | --- | --- |
| 1 数据合同与验收集 | `verified_local` | `contracts/commerce-data-contract/v1`、30-case dev、100-case final、独立 Oracle、hash lock | 无仓库内缺项 |
| 2 数据健康与虚拟水位 | `verified_local` | Source Adapter、`inspect_data_health`、快照/scope hash、fail-closed tests、PostgreSQL integration | 无仓库内缺项 |
| 3 Baseline/KPI/贡献 | `verified_local` | 四周中位数策略、KPI 恒等式、分子分母重算、contribution residual 与日期合同测试 | 无仓库内缺项 |
| 4 动态诊断状态机 | `verified_local` | typed state、decision events、候选排除、重规划、停止原因与反事实 trace tests | 无仓库内缺项 |
| 5 分支质量与消融 | `implemented` | 动态 Controller 合同、metamorphic cases、fixed-policy baseline 和评分器 | final-100 动态 Controller evaluator 尚为 `not_run`，因此不宣称已超过 baseline 5pt/20% |
| 6 Evidence 与答案体验 | `implemented` | claim JSON Pointer 回解、数值/单位/scope/date/filter 篡改拒绝、趋势/拆解/对比 UI 流程 | 两位业务评审对 30 个盲化输出的评分尚未执行 |
| 7 Driver 与可替换数据源 | `verified_local` | deterministic driver gate、因果边界、business-event contract、第二 compatible Fixture | 无仓库内缺项 |
| 8 行动与飞书 Outbox | `implemented` | proposed/confirmed/ignored/snooze、成员映射、逻辑幂等、`delivery_unknown` 与故障合同测试 | 飞书沙箱 100 次批准、真实 message ID 与 p95 仍为 `not_run` |
| 9 水位触发复盘 | `implemented` | action version/state fence、有效窗口、stale noop、weekly scheduler、迟到与 correction tests | 固定参考环境中的 100 次 review enqueue p95 尚未形成正式证据 |
| 10 系统评测与 Demo | `implemented` | 100-case 冻结集、16 条浏览器流、公开 Demo、真实 Web/Worker/SSE 小样本 Live E2E、监控与限流 | final-100、120-run、固定参考性能、5 人可用性仍为 `not_run` |

## 仍需外部证据

| Gate | 计划门槛 | 执行入口 |
| --- | --- | --- |
| Final Controller | 100 个原始结果按冻结 Oracle 重算，并满足 dynamic-vs-baseline 门槛 | `npm run eval:commerce:final-controller` |
| Real-model stability | 24 个场景 × 5 次，至少 110/120 完整成功；适用断言零失败 | `npm run eval:commerce:real-model` |
| Reference performance | 固定 revision/区域/Worker/DB/model/fixture/cache；5,000 同步请求与 100 次 review enqueue | `npm run test:performance:commerce` + 不可变报告 |
| Business blind review | 两位业务评审、30 个盲化输出，三项均分至少 4/5 | 按十周计划第 6 周协议人工执行 |
| Feishu sandbox | 100 次批准、至少 99 次送达、p95 ≤ 60s，另含故障与负例 | [`quality/commerce-agent-feishu-sandbox/v1`](../quality/commerce-agent-feishu-sandbox/v1/README.md) |
| External usability | 至少 4/5 合格参与者在 3 分钟内完成诊断→Evidence→行动 | [`quality/commerce-agent-usability/v1`](../quality/commerce-agent-usability/v1/README.md) |

全部外部报告、生产角色/恢复演练和最终镜像 fixture 就绪后，使用 `npm run release:check:evidence` 生成与干净 `HEAD` 绑定的正式发布报告。在此之前，项目可以作为实现完整、边界诚实的作品集公开展示，但不能宣称十周计划的全部外部验收已完成。

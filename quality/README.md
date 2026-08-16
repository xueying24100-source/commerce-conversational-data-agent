# Quality evidence

本目录把“可在仓库内复现的离线证据”和“需要外部环境的正式验收”分开保存。

| 路径 | 类型 | 当前含义 |
| --- | --- | --- |
| [`commerce-agent-eval/v1`](commerce-agent-eval/v1/README.md) | 冻结评测 | manifest、独立 Oracle、fixed-policy baseline、hash lock，以及 Oracle 隔离的本地 runtime 执行入口 |
| [`commerce-agent-feishu-sandbox/v1`](commerce-agent-feishu-sandbox/v1/README.md) | 外部沙箱协议 | 没有 revision-bound 飞书报告时保持 `not_run` |
| [`commerce-agent-usability/v1`](commerce-agent-usability/v1/README.md) | 外部用户协议 | 没有五名合格参与者报告时保持 `not_run` |

本地 Controller、单元、PostgreSQL 和浏览器结果记录在根 README；它们不能替代受保护 HTTPS final evaluator、120-run 模型稳定性、固定参考环境性能、飞书沙箱或外部用户证据。

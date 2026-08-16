# Quality evidence

本目录把“可在仓库内复现的离线证据”和“需要外部环境的正式验收”分开保存。

| 路径 | 类型 | 当前含义 |
| --- | --- | --- |
| [`commerce-agent-eval/v1`](commerce-agent-eval/v1/README.md) | 冻结离线评测 | manifest、独立 Oracle、fixed-policy baseline、hash lock；baseline 不是动态 Controller 成绩 |
| [`commerce-agent-feishu-sandbox/v1`](commerce-agent-feishu-sandbox/v1/README.md) | 外部沙箱协议 | 没有 revision-bound 飞书报告时保持 `not_run` |
| [`commerce-agent-usability/v1`](commerce-agent-usability/v1/README.md) | 外部用户协议 | 没有五名合格参与者报告时保持 `not_run` |

本地单元、PostgreSQL、浏览器和真实模型 Live E2E 结果记录在根 README；它们不能替代 final-100 Controller、120-run 模型稳定性、固定参考环境性能、飞书沙箱或外部用户证据。

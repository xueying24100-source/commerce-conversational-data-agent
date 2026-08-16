# Data contracts

这里保存 Source Adapter 与诊断核心之间的版本化、机器可校验边界。

- [`commerce-data-contract/v1`](commerce-data-contract/v1/README.md)：当前公开 Demo 与 controlled-compatible Fixture 的语义合同、来源清单、lineage 和哈希。

不兼容的字段、公式、主键、舍入或安全语义变更必须创建新的 major 目录，不能原地改写已冻结版本。

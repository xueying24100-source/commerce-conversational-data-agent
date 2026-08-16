# Commerce Data Agent：10 周开发与验收计划

## 1. 计划结论

本项目要交付的不是聊天式 BI，也不是允许模型任意生成 SQL 的开放式 Agent，而是一个有边界、可验证、能推动行动闭环的 Commerce Diagnostic Data Agent。十周交付物是基于公开历史数据的可公开体验产品和 Agent 行为证明，不是已经完成真实店铺接入的生产系统。

核心承诺：

> 用户只给出“诊断上一完整周经营表现”的目标，Agent 会先检查数据和选择基准，再根据中间结果动态决定下一步分析，在证据充分或预算耗尽时主动停止，给出可复核结论；用户批准行动后发送飞书，并在新数据到达后自动复盘。

开发阶段使用公开数据和历史水位重放；正式上线时通过相同的数据合同接入真实 Shopify、GA4、广告和库存来源。公开数据不能写死进 Agent Core，也不能将多个互不相关的数据集拼成一家虚构店铺。

本计划假设：

- 开发周期为 10 周；
- 开发和公开演示使用公开、可固定版本的数据；
- 正式运营阶段再关联真实店铺；
- 首个外部通知渠道只做飞书；
- 不建设独立实验分析模式；
- 不允许模型执行任意 SQL 或未经确认产生外部副作用。
- 首版唯一 Agent 目标是“诊断上一完整周经营表现”；现有直接查询能力继续保留，但不宣称支持任意经营目标。

## 2. 项目最终能做什么

完成后，用户可以：

1. 一键或按租户业务时区的周计划触发“上一完整周经营诊断”。
2. 让 Agent 检查数据完整性、数据水位、业务时区、指标与维度可用性。
3. 由代码选择显式同比/环比，或过去四个完整周等合理基准，并展示选择理由。
4. 自动扫描 GMV、支付订单、访问量、转化率和客单价等核心指标。
5. 根据实际结果继续调查渠道、商品、品类、地区、趋势或库存，而不是固定遍历所有视图。
6. 区分数据质量问题、真实业务异常、已确认贡献、高可信驱动和待验证原因。
7. 输出带数据截止时间、口径、置信度、替代解释和字段级 Evidence 的结论。
8. 为高影响、高置信问题提出最多一个行动；用户可以接受、忽略或稍后提醒。
9. 用户批准后通过幂等 Outbox 向负责人发送飞书通知。
10. 当新数据水位覆盖评估窗口后，自动复盘成功指标和护栏。

典型流程：

```text
触发诊断
  -> 数据可信门禁
  -> 选择基准
  -> KPI 扫描
  -> 假设 / 查询 / 验证循环
  -> 矛盾检查与停止
  -> Evidence 校验
  -> 提议行动
  -> 人工批准
  -> 飞书 Outbox
  -> 等待新数据水位
  -> 自动复盘
```

## 3. 产品和技术边界

### 3.1 什么由代码决定

- 日期、时区、完整周期和基准候选；
- 指标公式、加总规则、分子分母和贡献对账；
- 数据完整性、新鲜度、异常阈值和最小业务影响；
- 可用指标、维度、工具权限、查询范围和租户范围；
- 调查深度、工具预算、停止条件和超时；
- Evidence 校验、状态转换、通知与复盘幂等；
- 所有外部副作用和人工批准边界。

### 3.2 什么由模型参与

- 理解用户经营目标；
- 在白名单假设中排序；
- 从允许的下一步分析中选择最有价值的路径；
- 生成不包含无证据数字的经营解释；
- 根据已验证事实提出待确认行动。

### 3.3 洞察等级

系统不使用“所有内容都只是相关”这种没有决策价值的表达，也不把观测数据包装成确定因果。输出分为：

- `observed`：直接观察到的指标事实；
- `contribution`：由指标恒等式或可对账分解确认的贡献；
- `driver`：多项证据支持、通过矛盾检查的高可信经营驱动；
- `hypothesis`：仍需补充上下文或后续数据验证的可能原因；
- `unknown`：当前数据无法判断。

例如系统可以确认“GMV 下降主要由订单数减少贡献”“订单下降集中在 Paid Social 和移动端商品组”；但“落地页故障造成转化下降”在没有相应事件或补充证据时只能列为待验证原因。`driver` 表示经营诊断中的高可信驱动，不等同于已证明的因果机制。

### 3.4 什么证明它是 Bounded Agent

固定状态图和安全门禁是允许的；Agent 性来自调查阶段的状态更新、候选选择、重规划和主动停止。每轮至少要存在两个合法候选，或者有明确证据证明只剩一个合法候选。验收不仅比较不同数据的 trace，还比较：

- 未见过的多异常组合下能否重排假设；
- 某个维度或工具不可用时能否改走另一条有效路径；
- 新证据反驳原假设后能否回退并选择替代假设；
- 动态 Controller 相比固定决策树 baseline 是否提高最终任务正确率，或以更少调用获得相同正确率。

这里不追求无约束自主性；如果固定 policy baseline 与动态 Controller 表现相同，则必须如实把产品定位为自适应诊断工作流，而不能用模型调用包装 Agent 性。

现有直接查询模式仍然支持明确的指标、趋势、对比和拆解问题，但它不计入旗舰 Agent 能力证明，也不扩展首版唯一 Agent 目标。旗舰声明只由完整的“上一完整周经营诊断”评测集验收。

## 4. 当前仓库基础与主要缺口

### 可以直接保留

- 分区完整性、Connector coverage proof、数据模式和水位；
- 参数化只读分析工具；
- compare、breakdown、trend、inventory 等分析能力；
- 字段级 Evidence、JSON Pointer、metric/value/unit 校验；
- durable Job、Worker、lease、重试、SSE 和 readiness；
- 行动状态、报告分享和人工复盘基础。

### 必须改造

- 当前宽泛经营问题预先固定 comparison、breakdown、trend，不会根据中间数据改变路径；
- 当前基准策略以正则和固定相邻周期为主，缺少稳健候选和选择理由；
- Shopify Orders Connector 缺访问量、真实商品粒度等旗舰诊断所需能力；
- 趋势、拆解和直接查询的正文形态没有完全匹配问题；
- 通用模板覆盖了部分本可更具体的经营解释；
- proposed 建议缺少直接忽略、稍后提醒和真实成员分派；
- 没有 Commerce 领域的飞书 Outbox 和数据水位触发自动复盘。

### 必须新增

- 一等公民的数据健康报告；
- 基准策略、KPI 树、异常检测和贡献 residual；
- 有类型的诊断状态、假设队列、决策事件和停止原因；
- 结果驱动 Controller；
- 反证、矛盾和结构变化检查；
- 公开数据历史水位重放；
- 生产 Source Adapter 接口和经营事件合同；
- 飞书通知 Outbox 与水位调度器。

## 5. 十周实施计划

| 周次 | 本周必须交付 | 进入下一阶段的硬门 |
|---|---|---|
| 第 1 周 | 产品合同、不可缩减数据合同、公开数据方案、30 例开发集 | 数据方案满足核心指标与维度；Gold/Oracle 冻结；现有系统基线完成 |
| 第 2 周 | Source Adapter、虚拟水位、数据健康门禁 | 缺失/过期/能力不足时 0 次经营分析、0 个行动；同 Run 快照一致 |
| 第 3 周 | Baseline Policy、KPI 树、稳健异常和贡献 residual | 日期与核心数值 100%；异常召回不低于 90%；贡献误差不超过 0.1% |
| 第 4 周 | 有类型状态机、候选假设、动态 Controller、decision event | 同一目标随数据走不同 trace；能反驳、重规划、提前停止且不漂移 scope |
| 第 5 周 | 矛盾检查、预算控制、固定 policy 消融 baseline | 分支准确率不低于 85%；Top-1 不低于 90%；动态策略满足增益门槛 |
| 第 6 周 | 问题匹配视图、结论等级、字段级 Evidence 体验 | 事实 Evidence 覆盖与篡改拒绝均 100%；业务盲评达到 4/5 |
| 第 7 周 | 可复现 driver gate、经营事件合同、第二兼容 Adapter fixture | 不虚构事件、不越过因果边界；替换 fixture 不改 Agent Core |
| 第 8 周 | 最多一个行动、snooze、身份映射、飞书 Outbox | 未批准/越权发送为 0；正常沙箱 100 次、成功率不低于 99%、p95 不超过 60 秒 |
| 第 9 周 | 行动状态机、周诊断调度、水位触发复盘、版本栅栏 | 仅 completed 可复盘；迟到/重试/并发下无陈旧 verdict 或重复逻辑 Run |
| 第 10 周 | 100 例离线集、120 次真实模型 Run、16 条环境 E2E、公开 Demo | 全部发布红线为 0；准确率、延迟、无障碍、防滥用和用户任务全部达标 |

这些周次是质量 Gate，不是“时间到了自动进入下一周”。第 1–6 周的诊断正确性与 Evidence 未通过时，第 8–9 周的通知和自动复盘 feature flag 必须保持关闭。若进度落后，优先删除非核心视觉润色、退款/库存等可选分支和额外直接查询意图，不得删除数据门禁、五个核心指标、动态调查、Evidence、人工批准或复盘的真实性边界。

## 第 1 周：冻结产品合同、公开数据和验收集

### 实现

- 首版唯一旗舰目标固定为“诊断上一完整周经营表现”。
- 输出固定为：数据健康、基准、最多三个发现、未知项、最多一个待确认行动、停止原因。
- 定义 `AgentState`：objective、dataHealth、baseline、signals、hypotheses、findings、budget、stopReason。
- 定义 Finding：observation、interpretation、confidence、insightLevel、alternatives、evidence。
- 选择一份连贯的公开电商数据作为旗舰数据；不可缩减的最小合同是至少 90 天的 visits、paid orders、GMV、conversion、AOV，以及 channel、product/category、region 三类钻取维度。Olist 可保留为订单分析辅助 fixture，但不能单独验证访问量或转化率。
- 第 2 个工作日仍找不到完全满足合同的数据时，只允许在一份公开基础数据上使用可复现、可审计、明确标记为“公开数据衍生演示字段”的同源场景扩展；生成规则、seed 和 lineage 必须进入数据合同与评测。不得拼接无关来源伪造完整店铺，也不得静默缩窄上述最小合同。第 1 周结束仍无法满足时，项目进入 blocked/replan，不得继续宣称十周内交付完整旗舰 Agent。
- 固定数据版本、许可证、来源、SHA-256、业务时区和虚拟起始日期。
- 冻结 `commerce-data-contract/v1`：必填字段、主键、指标分子/分母、币种与 rounding、迟到数据、去重、能力降级、水位合成和 Schema 演进规则。
- 冻结 30 个开发案例：数据健康/来源语义 4 例、日期/scope/基准 4 例、确定性 KPI/Evidence 4 例、自适应诊断 12 例、异常/因果边界 2 例、安全/拒答 2 例、行动/通知/复盘 2 例。12 个自适应诊断例中 10 个具有由受控数据生成器注入的单一结构性 gold driver，2 个应稳定停止或输出 unknown。

### 验收

- 每个案例都有独立计算的数值答案、允许分支、禁止工具、预期停止原因和禁止结论。
- 至少四组成对数据使用相同问题，但期望调查路径不同。
- 公开数据不得通过拼接无关来源伪造为同一家店。
- 现有系统运行全部案例并保存基线分数。单例得分由 scope 20%、最终事实 35%、主要驱动 25%、Evidence 10%、停止判断 10% 组成；任一安全红线触发时该例计 0 分。未完成基线不得开始 Controller 改造。
- 30 个案例和独立 Oracle 在提交后锁定 hash；第 10 周隐藏集由不同 fixture/变形脚本生成，避免实现逻辑和参考答案共享同一错误。

## 第 2 周：公开数据接入、虚拟水位和数据可信门禁

### 实现

- 将公开数据映射到稳定的 Commerce Data Contract；Agent 不引用数据集专属字段。
- 单一公开来源内验证 sessions、purchases 和 revenue 的一致口径。未来跨 Shopify/GA4 时，不把不同归因模型下的 visits 和 orders 强行视为严格恒等式，必须通过 capability 与 reconciliation 状态决定是否允许分解。
- 实现虚拟业务时钟和逐日/逐周水位开放，用静态历史数据模拟持续更新。
- 新增 `inspect_data_health`，返回区间逐日 completeness、source watermark、指标与维度能力、空值/非法值、占位维度比例和 Connector 状态。
- 将数据健康门禁置于所有业务分析之前；失败时不得生成行动。

### 验收

- 将 capability 分为旗舰必需与可选：visits、paid orders、GMV、conversion、AOV，以及 channel、product/category、region 是旗舰必需；refund、margin、inventory 和经营事件是可选。任一必需指标不可用、必需来源缺一天/陈旧/未来水位/审计失败，或必需维度非占位覆盖率低于 95% 时：分析工具调用数为 0，行动数为 0。只有可选能力缺失或其来源失败时，核心诊断可继续，但必须标记 capability degraded，且不得生成涉及该能力的 finding 或行动。
- `ready + fact_row_count = 0` 的真实零成交日允许查询。
- 同一 Run 的全部 Evidence 使用同一快照、水位、时区和 scope hash。
- 金额与独立源 Oracle 的误差不超过 0.01；整数必须完全相等。
- 所有金额使用同一 decimal/rounding 合同；比率误差不超过 `1e-6`，贡献 residual 使用未舍入值计算后再展示。
- 页面明确显示“公开历史数据 / 虚拟业务日期”，不得暗示实时店铺。

## 第 3 周：基准、KPI 树、异常和贡献分解

### 实现

- 实现确定性 Baseline Policy：用户显式基准优先；明确同比/环比次之；周诊断默认与此前四个完整周的中位数和区间比较；历史不足时降级并降低置信度。
- 实现最小 KPI 树：`GMV = paid_orders * AOV`，`paid_orders = visits * conversion_rate`。
- 对退款、毛利和库存建立独立分支。
- 实现最小样本、最小业务影响、median/MAD 或稳健预期区间的异常检测。
- 对 channel、category、SKU、region 返回可对账的贡献和未解释 residual；非加总率使用分子/分母，不直接相加百分比。

### 验收

- 时区、完整周、闰年、月中环比和覆盖不足等日期用例 100% 正确。
- 核心指标与独立 Oracle 100% 一致。
- 合成异常召回率不低于 90%，正常周期误报不高于 10%。
- 贡献加 residual 与总变化的误差不超过 0.1%。
- 统计离群值只能标记为业务异常或待核查，不能自动作为坏数据删除。

## 第 4 周：诊断状态机和动态分支骨架

### 实现

- 为诊断目标引入 `preflight -> baseline -> scan -> investigate -> contradiction_check -> synthesize -> stop` 状态图。
- 保留直接查询模式；仅将宽泛经营诊断从固定 required views 改成动态 Controller。
- 建立白名单假设：traffic_drop、conversion_drop、aov_or_mix、refund_spike、stockout 等。
- 每轮根据影响、异常程度和数据可靠度排序，生成最多三个合法候选并选择预期信息增益最高的一项；只有在权限、能力或证据已经排除其他候选时才允许只剩一个候选，并记录排除原因。
- 记录结构化 decision event：hypothesis、triggerEvidenceIds、chosenNextView、decisionCode、stopReason；不保存 Chain-of-Thought。

### 验收

- 同一问题在流量下降、转化下降、客单价下降、退款异常和健康数据上产生不同 trace。
- 新证据反驳第一假设时，Controller 必须降低其置信度并改查替代假设；工具或维度缺失时必须重规划，而不是直接复用默认 region breakdown。
- 数据不可信时立即停止；健康数据无显著异常时提前停止。
- 禁止工具调用和 scope 漂移为 0；scope 漂移定义为未经显式决策事件改变日期、租户、指标、筛选或业务时区。
- 每个终局都有明确停止原因。

## 第 5 周：分支质量、矛盾检查和预算控制

### 实现

- 增加结构变化、总量/分组矛盾、Simpson's paradox 和替代解释检查。
- 使用 supporting、contradicting、missing 三类证据更新假设置信度。
- 硬限制：调查深度不超过 3，分析调用不超过 8，连续两轮无新增有效 Evidence 时停止，总超时 90 秒，相同 request hash 禁止重复调用。
- 适配现有 ProgressOracle，使“继续调查”和“停止”由信息增益而不是固定工具清单驱动。
- 保留一个不使用模型选择的固定决策树 baseline，对动态 Controller 做消融比较。

### 验收

- 第 1 周冻结的 12 个自适应诊断开发案例构成本周分支准确率分母，门槛至少 85%；其中 10 个单一结构性 gold driver 案例构成 Top-1 分母，至少 9/10 正确。其余开发案例不得用于稀释这两个指标。
- 成对反事实数据中，受控变量改变后的结论响应率 100%。
- 总体转化下降但各渠道转化上升时，系统能够识别结构变化。
- 无异常场景提前停止率 100%。
- 分析调用 p95 不超过 6，硬上限为 8。
- 动态 Controller 必须比固定 baseline 的最终任务正确率至少高 5 个百分点，或者在正确率不下降的情况下将平均分析调用降低至少 20%；否则将其定位为自适应工作流而非模型规划 Agent。
- 分支准确率未达到 85% 时禁止进入通知阶段，不留 80%–84% 的放行空档。

## 第 6 周：可信结论、问题匹配视图和 Evidence 体验

### 实现

- 保留 Evidence Ledger 的硬校验，移除与问题语义不匹配的通用文案覆盖。
- 趋势问题在正文展示趋势图、峰谷和持续性；拆解问题展示贡献排名；对比问题展示当前、基准、变化与口径。
- 每个 Finding 展示 insightLevel、confidence、支持证据、反证状态、替代解释和未知项。
- 主区回答业务问题；hash、JSON Pointer、请求参数等审计细节默认折叠。
- Evidence 引用可以从结论定位到相应图表或数据行。

### 验收

- 所有数值和业务事实的 Evidence 覆盖率为 100%。
- value、unit、path、evidenceId、filter、date range 任一篡改，提交拒绝率为 100%。
- 趋势、拆解、对比问题的正文形态匹配率为 100%。
- 每个高可信驱动都有支持证据；低置信原因至少有一个替代解释或补证建议。
- 两位业务评审分别对 30 个盲化输出的正确性、直接性和可操作性评分；这些输出来自本阶段锁定的开发案例与反事实变体，随机隐藏场景 ID 和实现版本，不占用也不泄露第 10 周最终隐藏集。三项平均均不低于 4/5，任一答案正确性低于 3 即阻断发布。

## 第 7 周：驱动解释、经营事件和生产数据源接口

### 实现

- 完成 observed、contribution、driver、hypothesis、unknown 五级洞察表达。
- `driver` 的晋级由确定性 gate 决定，模型不能自行提升等级：贡献占总变化至少 30%，且主指标相对基准的绝对变化至少 10%；通过 aggregate/KPI-tree 与 segment-or-trend 两类不同 grain、不同 request hash 的非重复证据支持；贡献 residual 不超过 0.1%；不存在会改变方向、scope、对账结果或主要排名的未解决反证；来源可靠度为 high。租户可配置 materiality，但评测 fixture 的阈值在第 1 周冻结，不得运行中调整。
- 来源可靠度 high 固定表示：必需分区 completeness 为 100%、水位满足 freshness 合同、来源审计通过、无未解决 reconciliation 冲突，且相关维度非占位覆盖率至少 95%。经营事件的时间相邻本身不能将 hypothesis 升级为 driver；这里的两类证据是非重复验证视图，不宣称统计独立或因果识别。
- 增加支持/反证和经营事件的联合检查，但不建设独立实验分析模式。
- 定义可选 `commerce_business_events` 合同：price_change、campaign_change、promotion、restock、stockout 等事件、发生时间、范围、来源和可信度。
- 公开数据演示中的经营事件必须明确标记为模拟场景元数据；正式上线由真实 Connector 同步。
- 定义稳定 Source Adapter 和 capability matrix，使公开数据源可替换为 Shopify、GA4、广告、库存 Connector，而不修改 Controller 和 Evidence 协议。

### 验收

- GMV 下降来自订单、AOV 或结构变化时能够正确区分。
- 异常从渠道 A 移至 B，发现和行动对象必须移动到 B。
- 有经营事件时将其作为候选原因；没有事件时不得虚构事件。
- 每个高可信驱动或候选原因都包含支持证据、反证状态、替代解释和置信度；`driver` 仍不得表述为已证明的因果机制。
- 以第二个兼容 fixture 替换数据源时，Agent Core 无需修改即可运行同一诊断合同。

## 第 8 周：行动审批和飞书通知

### 实现

- proposed 行动支持接受、忽略、稍后提醒；未接受行动不进入正式执行队列。
- “稍后提醒”必须写入 `snoozeUntil`；到期后只在应用内重新展示审批提醒，不发送飞书。重新设置时间会使旧调度失效，忽略、接受或取消会撤销尚未触发的提醒。
- assignee 绑定稳定的 tenant member ID；开发演示使用本地成员目录，正式上线对接真实身份系统，并维护 `tenant member ID -> Feishu open_id` 的租户内映射。
- Agent 只能 propose；用户确认后由 deterministic Outbox 发送飞书。
- Outbox 包含 `(tenant, actionId, version, channel)` 唯一键、稳定 request UUID、重试、退避、审计和敏感信息过滤。唯一键保证一个逻辑通知命令，不声称网络传输物理 exactly-once。
- 飞书客户端在接口支持时传递稳定幂等键；如果一次超时可能已经被飞书接收、且无法按 request UUID 或 message ID 对账，则将投递标记为 `delivery_unknown` 并停止盲目重发，交由对账或人工处理。
- 投递状态固定为 `pending -> sending -> delivered | retryable | delivery_unknown | failed_permanent`，其中 retryable 只能按退避策略回到 sending。`delivery_unknown` 先按稳定 request UUID/message ID 自动对账：确认存在则转 delivered，确认不存在才用同一 UUID 重试；渠道无法查询时只允许授权操作者 `mark_delivered`，或显式创建 action version + 1、重新取得用户批准后发送一条标记为 reissued 的新逻辑通知，并在 UI 警告收件人可能看到两条。所有人工决策保留审计事件。
- 飞书内容包含摘要、关键证据、行动、截止时间和带鉴权的应用回链；公开 Demo 只有授权演示运营人员可以批准、选择收件人和触发通知，普通公开体验用户没有外部写权限。
- 开始本周前准备并验证外部依赖：飞书自建应用、沙箱租户、App ID/Secret 的安全配置、机器人发消息与成员标识读取所需的最小 scopes、事件/接口域名 allowlist、授权演示人员名单、成员映射和回链环境。任一依赖未就绪时通知 feature flag 保持关闭。

### 验收

- 未批准、忽略、稍后提醒、无权限或跨租户时，外部通知数为 0。
- `snoozeUntil` 到期、改期和取消的调度状态与独立状态机 Oracle 100% 一致；稍后提醒到期仍不产生飞书通知。
- 同一批准请求重放 10 次，只产生一个批准状态事件和一个逻辑通知命令。
- 202、429、500、发送前/发送后超时和 Worker 崩溃均有确定性重试或 `delivery_unknown` 结果；Outbox 中不产生重复逻辑通知。验收报告分别披露 Outbox 逻辑去重和飞书端实际 message ID 数，不能用前者替代后者。
- 重发验收按 `(tenant, actionId, actionVersion, channel, requestUUID)` 计数：同一版本最多一个逻辑命令和一个沙箱 message；经重新批准的 reissued 新版本是显式第二条通知，不计为同版本重复，但必须在审计和 UI 中与原 `delivery_unknown` 关联。
- 沙箱中的收件人必须来自当前租户授权映射；伪造 tenant member ID、已移除成员和非演示操作者的发送成功数为 0。
- 通知不得包含模型密钥、连接串、原始 PII 或匿名报告 token。
- 正常飞书沙箱链路至少执行 100 次批准：成功送达率至少 99%，确认后通知 p95 在 60 秒内送达；故障注入样本单独验收状态转换，不得从正常链路分母中删除失败后再冒充 100% 成功。

## 第 9 周：新水位触发自动复盘

### 实现

- 补齐行动生命周期：`proposed -> confirmed -> in_progress -> completed -> reviewed`，并显式支持 ignored、cancelled、blocked 和 reopened。合法转换固定为：proposed 可进入 confirmed/ignored/cancelled；confirmed 可进入 in_progress/cancelled；in_progress 可进入 blocked/completed/cancelled；blocked 可回到 in_progress 或 cancelled；completed 可进入 reviewed/reopened/cancelled；reopened 只能进入 in_progress/cancelled；reviewed 为不可变终态。snooze 不是 action 状态：行动保持 proposed，只更新 reminder 子状态与 `snoozeUntil`；到期回到 reminder due，之后仍可 confirmed/ignored/cancelled 或再次 snooze。只有 `completed` 行动可以进入自动复盘。
- 行动固化 success metric、原始 filters、baseline claim、target、guardrails、evaluation duration 和 review-after watermark。生产环境的 `completed_at` 来自可信服务端壁钟，Demo 来自虚拟业务时钟；两者均保存 UTC instant、tenant timezone 和 `clockType`。复盘生命周期从实际 `completed_at` 开始，不从批准时间或飞书送达时间开始；公开数据 Demo 中的完成操作必须明确标记为历史情景演示。
- 系统只生成一组用于查询、去重和水位判断的 `effectiveReviewStart/End` 半开区间。来源支持相应时间粒度时，取 `[completed_at, completed_at + evaluationDuration)`；若来源只有日粒度，`effectiveReviewStart` 是 `completed_at` 之后第一个 tenant-local 完整日边界，`effectiveReviewEnd` 为该起点加约定数量的完整日。`reviewAfterWatermark` 固定等于 effectiveReviewEnd；报告同时显示原始 `completed_at`、对齐规则和 effective 区间，禁止混入行动完成前的部分日。
- cancelled 行动不创建复盘；已完成但复盘前 reopened 的行动撤销旧待执行复盘，并在再次完成后用新的 `completed_at` 和 action version 计算窗口；已确认后的指标、筛选、目标或护栏编辑必须创建新版本、使旧调度失效并重新确认。已完成的 review 保持不可变，后续更正以新版本追加而非覆盖。
- 只有当前时间已越过 effectiveReviewEnd 且所需数据水位覆盖 effectiveReviewEnd 时，才按 `(tenant, actionId, actionVersion, effectiveReviewStart, effectiveReviewEnd)` 逻辑去重入队复盘；Worker 和队列允许重试，不声称物理 exactly-once。
- 每个复盘 Job 携带 actionVersion、stateVersion 和 effectiveReviewWindow hash；执行前与提交 verdict 前都用 compare-and-set 检查行动仍是同版本 completed。取消、重开、编辑或新完成与 Job 并发时，旧 Job 必须标记 `stale_noop`，不能写入 verdict 或发送通知。
- 数据不足时保持 waiting，不使用旧快照提前下结论。
- 复盘继承原始范围并展示目标、实际结果、护栏和新 Evidence。
- 经营复盘描述为“行动后窗口观察到的结果”，不将历史重放包装成真实行动效果证明。
- 增加旗舰周诊断调度器：v1 业务周固定为 tenant-local 周一 `00:00` 到下一周一 `00:00` 的半开区间；默认迟到容忍期为 26 小时。在完整周结束、容忍期经过且必需来源水位就绪后，按 `(tenant, objective, weekStart, weekEnd)` 建立 canonical diagnosis，同一完整周只有一个当前有效逻辑 Run。
- policyVersion 作为 Run 元数据，不进入 canonical 唯一键；已完成周在策略升级后不自动重跑。material correction 或操作者明确重跑会创建 revision 加一的 superseding Run，旧 Run 保持可审计但不再是 current。
- 调度器停机恢复时按从旧到新补跑最近两个缺失完整周；更早缺口记录为 `skipped_backlog` 并只能由操作者显式补跑，避免恢复时无界消耗模型预算。
- 多来源有效水位取本次指标所需来源水位的最小值；可选来源缺失只触发 capability 降级，必需来源缺失或迟到则继续 waiting。Run 或 review 完成后迟到修正不得静默改写旧 Evidence；只有 Connector 发布带版本的 material correction 时，才创建清楚标注的 superseding Run/review。

### 验收

- 水位未到时复盘任务为 0；水位到达后只入队一次。
- 未完成、已取消或复盘前 reopened 的行动，自动复盘任务为 0；再次完成后只能按新版本和新的 `completed_at` 建立复盘。
- 原始指标、筛选、目标和护栏继承率为 100%。
- 成功指标改善但护栏恶化时，不得判整体成功。
- 达标、未达标、数据不足、护栏突破四类 verdict 与独立 Oracle 一致。
- 数据 ready 后复盘任务 p95 在 15 分钟内入队。
- 跨时区、夏令时、调度器重复启动、Worker 崩溃、必需来源晚到和 material correction 场景中，每个租户/完整周只有一个当前有效逻辑诊断 Run，旧版本与 superseding 版本的关系可审计。

## 第 10 周：系统评测、发布证据和公开 Demo

### 实现

- 将离线集扩展到 100 个案例，其中至少 30 个隐藏回归案例。
- 离线 manifest 固定为：数据健康/来源语义 15 例、日期/scope/基准 15 例、确定性 KPI/Evidence 15 例、自适应诊断 25 例、异常/因果边界 10 例、安全/拒答 10 例、行动/通知/复盘 10 例。最终隐藏集的整数配额依次为 4、4、4、8、3、3、4，共 30 例；其余 70 例可见。manifest 与 Oracle 在执行前冻结 hash。
- 运行 24 个分层关键场景，每个使用发布模型重复 5 次，共 120 次真实模型 Run：自适应诊断 8 个、健康或数据门禁 4 个、日期/scope/基准 4 个、安全/拒答 4 个、行动/通知/复盘 4 个；保存 model、参数、prompt hash、fixture hash、工具数、token、成本、延迟和最终结果。
- 增加成对反事实和变形测试：金额缩放、渠道交换、异常迁移、日期平移、删除分区、增加无关 SKU、护栏恶化等。
- Browser E2E 覆盖桌面和移动：诊断、图表、Evidence、数据失败恢复、行动确认、飞书、等待数据和复盘。

  1. 手动触发“诊断上一完整周”，看到基准、数据截至时间、发现和停止原因；
  2. 趋势型直接查询在正文显示趋势图、峰谷和持续性；
  3. 数据残缺或过期时停止并提供重试/等待入口；
  4. visits 能力缺失时旗舰诊断在数据门禁停止，不输出 conversion 或行动；
  5. 从每条主要结论定位到对应 Evidence 图表或数据行；
  6. 确认最多一个行动、选择授权负责人并在飞书沙箱收到消息；
  7. 将行动推进到 completed，等待新水位后查看成功指标、护栏和复盘 verdict；
  8. Worker 在关键阶段崩溃并重领后恢复进度，不出现重复结果或逻辑副作用。

- 使用 feature flags 依次开启 diagnostic policy、anomaly detection、notifications 和 automatic review。
- 部署公开历史数据 Demo；默认不开真实客户数据和公开多租户写能力。
- 增加公开 Demo 防滥用：每账号每小时最多 5 个诊断、同时最多 2 个活跃 Job，每 IP 每小时最多 20 个诊断，输入正文最多 2,000 字符；单 Run 延续最多 8 次分析调用的硬预算。部署必须设置数值型 `DAILY_MODEL_BUDGET_USD`，预计下一次调用会超限时不得调用模型；外部写权限继续使用 allowlist，并提供全局 kill switch。
- 建立发布监控和告警：数据水位、队列等待、Agent 成功率、工具调用、token/成本、模型限流、Evidence 拒绝、飞书投递状态和复盘积压。
- 第 1–9 周每周把当周新增合同加入持续回归，不把测试集中推迟到第 10 周；第 10 周第 3 个工作日后冻结新功能，至少 40% 容量保留给全量评测发现的问题修复和复测。

### 验收

- 数值准确率和 Evidence 完整率为 100%。
- 确定性日期、时区、完整周期和 Baseline Policy 合同测试为 100%。自然语言 scope 准确率只在 15 个日期/scope/基准案例各 10 个锁定改写上计算，分母 150，门槛至少 98%；显式同比/环比仍为 100%。
- 主要驱动 Top-1 和 Top-3 只在 25 个自适应诊断案例中 20 个具有单一、由受控数据生成器注入的结构性 gold driver 案例上计算，门槛分别至少 90% 和 95%；其余稳定或本应 unknown 的案例单独验收正确停止，不拿真实公开观测数据虚构因果真值。
- 拒答/澄清准确率在 10 个安全/拒答案例各 10 个锁定攻击或改写上计算，分母 100，门槛至少 98%；残缺/过期数据仍作答为 0。
- 数值和 Evidence 门槛应用于全部产生事实输出的离线案例，分母不得少于 50；每项指标同时报告分子、分母、适用子集和失败案例，禁止只报告总体平均掩盖分层失败。
- 无证据事实、跨租户、未批准通知、同一 actionVersion/requestUUID 的重复逻辑副作用、受控飞书沙箱中同一版本观察到的重复 message 和 prompt injection 越权全部为 0；经用户重新批准且标记为 reissued 的新版本单独计数。这是一项测试与发布红线，不宣称无法控制的公网传输具备物理 exactly-once 保证。
- 120 次真实模型 Run 至少 110 次达到完整任务标准；每个非安全场景至少 4/5 成功。每次 Run 都执行其适用的数值、Evidence、权限、副作用和因果边界断言，全部适用断言必须零失败，并分别报告分母；不适用项不得伪记为通过。
- 自主诊断 p95 不超过 60 秒，98% 在 90 秒内完成。
- 性能百分位在固定 reference environment 中验收并记录部署 revision、区域、Worker 数/并发、数据库规格、模型版本、fixture hash 和 cache 状态；自主诊断使用上述至少 120 次样本。同步 API 以并发 10、读写 80/20、每个端点至少 1,000 次请求验收：创建诊断 Job p95 不超过 500 ms、会话/Job/Evidence/readiness 查询 p95 不超过 300 ms，p99 均不超过 1 秒。飞书正常通知和复盘入队各至少 100 次样本；超阈值时测试必须非零退出。
- 防滥用测试必须证明：第 6 个账号小时请求、第 3 个并发 Job、第 21 个 IP 小时请求、超长输入和预算超限均在入队或模型调用前失败；返回稳定 4xx/限流状态且新增模型调用与飞书通知均为 0。kill switch 开启后新模型调用与外部写入为 0，已运行只读 Job 可安全收敛。
- 8 条核心浏览器流程在 Playwright lockfile 固定的 Chromium 版本上，以桌面 `1440x900` 和移动 `390x844` 仿真分别全部完成，共 16 条环境流程；浏览器版本写入发布证据。十周内不把真机兼容性作为已验证能力。流程中无 console error、未捕获异常、横向溢出或文字裁切。
- axe 自动检查的 critical/serious 问题为 0，关键流程可只用键盘完成。
- 至少 5 名未参与开发、熟悉电商运营但未见过该产品的用户，从同一已登录、已重置的 Demo 起始页开始，在统一的一分钟任务说明后不接受口头指导；至少 4/5 能在 3 分钟内完成“诊断 -> 查看证据 -> 确认行动”，失败点必须记录并在发布前复测。

## 6. 跨阶段发布红线

以下任一项出现一次即阻断发布：

- 数据区间残缺或增量数据过期，Agent 仍输出经营结论；
- 输出无法精确回指本 Run Evidence 的数字或业务事实；
- 同一目标面对明显不同的数据仍走相同固定路径并得出相同结论；
- 数据质量问题被当成经营异常，或真实业务峰值被自动删除；
- 未经用户批准产生飞书通知或其他外部副作用；
- Worker 重试造成重复行动、同一 actionVersion/requestUUID 的重复逻辑通知、受控飞书沙箱中同版本可观察到的重复消息或重复复盘；
- 模型或工具数据中的 prompt injection 改变租户、查询范围、权限或副作用；
- 历史公开数据被展示为实时店铺数据；
- 缺少事件和补充证据时，将具体业务机制表述为已确认原因。

## 7. 关键反事实验收

| 数据变化 | 预期行为 |
|---|---|
| GMV 下降来自订单减少，AOV 稳定 | 继续调查 visits 和 conversion，再定位渠道 |
| 同幅 GMV 下降但订单稳定、AOV 下降 | 调查商品、品类和价格带结构 |
| 异常从渠道 A 移到 B | 发现、证据和行动对象全部移动到 B |
| 所有核心 KPI 稳定 | Agent 提前停止，不强行制造三条问题 |
| 总体转化下降但各渠道转化上升 | 识别渠道结构变化，不给出错误总体解释 |
| 删除一个 ready partition | 从正常回答转为数据门禁失败 |
| 所有金额乘 10 | 排名和百分比不变，金额同步乘 10 |
| 增加无关零贡献 SKU | 主要驱动和总结保持不变 |
| 成功指标改善但护栏恶化 | 复盘不得判整体成功 |
| 没有经营事件 | 不得虚构促销、调价、投放或库存事件 |

## 8. 明确不做

10 周内不做：

- 任意 SQL、任意 Schema 或无边界自主 Agent；
- 自动修改价格、广告预算、库存、退款或订单；
- 独立 A/B 实验分析模式；
- 多个通知渠道；
- 更多模型 Provider、RAG、预测模型或长期自主记忆；
- 完整 Shopify OAuth、自助计费和连接器市场；
- 公开多租户生产 SaaS；
- 将调用过 comparison、breakdown、trend 当作 Agent 成功标准。

## 9. 十周后的交付形态

十周交付的是一个可公开体验、行为上真实的 Commerce Data Agent：

- 使用固定版本公开数据和历史水位重放；
- 能完成自适应经营诊断；
- 能生成可验证结论、行动、飞书通知和自动复盘；
- 有反事实、Evidence、安全、幂等和浏览器发布证据；
- 数据 Source Adapter 已为真实店铺 Connector 留出稳定接口。

它不是最终的公开多租户商用 SaaS。正式关联真实店铺时，还需要单独完成 Shopify/GA4/广告/库存 Connector、真实 IdP、不可伪造租户绑定、进程级密钥隔离、隐私治理、客户数据删除与生产 SLO。

## 10. 最终 Definition of Done

项目完成的统一标准：

> 用户只提交经营目标，系统先验证数据和选择基准；面对不同中间结果走不同分析路径；在预算内主动停止；所有结论都能回到同一数据快照和字段级 Evidence；最多一个高影响行动由用户批准后幂等发送飞书；新数据水位到达后，系统自动并按行动版本逻辑去重地完成目标与护栏复盘。

# Observability 观测层设计与口径约定

面向维护者。**规则：UI 上出现的任何「同名指标」都必须能在本文件找到唯一定义；新增页面或指标时，先在这里对齐口径，再写代码。**

「同一个名字、两套算法」是这类平台最容易腐化的地方（例：Traces 列表的「耗时」= trace 总跨度，但早前一度是「首个 generation 的耗时」，与详情页矛盾）。本文件是防止这种分叉的唯一依据。

---

## 1. 概念模型：四切一面

| 概念 | 定义 | 落库位置 |
|---|---|---|
| **Trace** | 一次完整链路执行（用户视角的一次请求 / 一轮对话） | `Trace` |
| **Observation** | 一个 trace 内的一步，`type` ∈ ENTRY / AGENT / STEP / LLM / TOOL / EMBEDDING / CHAIN / RETRIEVER / RERANKER / EVENT / SPAN | `Observation`（自引用 `parentObservationId` 构成调用树） |
| **Generation** | `type` ∈ {`LLM`, `EMBEDDING`} 的 observation，即一次模型调用 | 同上 |
| **Session** | 会话，一串 trace（`trace.sessionId`） | `Trace.sessionId` |
| **对象** | 跨 trace 聚合的实体：Agent / Model | 见下「归属优先级」 |

「一面」指所有视图最终都归到同一条链路上：**注入 → 存储 → 查询聚合 → 评分 → 展示**。

---

## 2. 归属优先级（唯一真源）

| 维度 | 归属表达式 | 空值处理 |
|---|---|---|
| Agent | `COALESCE(trace.agentName, observation.agentName)` | 均空归 `unknown` |
| Model | `observation.model`（**仅** Generation 携带） | 无 model 的调用不计入任何模型 |
| Session | `trace.sessionId` | 无 sessionId 的 trace 不进 Sessions |
| 环境 / 用户 / 标签 | `trace.environment` / `trace.userId` / `trace.tags` | 原样 |

trace 级字段为权威，span 级字段只做兜底。

---

## 3. 指标口径矩阵（关键）

| 指标 | Overview / Agents | Models / Analytics | 备注 |
|---|---|---|---|
| **Trace 数**（`traces`） | Trace 数 | 含该模型调用的**去重** Trace 数 | 一个 trace = 一次完整链路执行 |
| 调用（calls） | 该 Agent 名下 Generation 数 | 该模型 Generation 数 | 两侧一致 |
| 步骤（steps） | 该 Agent 名下**全部** observation 数 | — | 仅 Agents 内部用作错误率分母 |
| 成功率 | trace 级：`trace.status = ERROR` **或**该 trace 含任一步 `level = ERROR` | 同左 | **两侧必须一致**（同一条 trace 不能在一个页面成功、另一个页面失败） |
| 错误率 | `errors / steps`（步骤级） | `errors / calls`（调用级） | 口径不同是**刻意**的，UI 用 `title` 标注 |
| 成本 / Token | 该 Agent 名下**全部** observation 累加 | **仅**该模型 Generation 累加 | Agent 的成本包含它跑过的工具等步骤 |
| P95 / 平均延迟 | **全部** observation 时长 | **仅**该模型 Generation 时长 | 同上，UI 用 `title` 标注 |
| 耗时（Traces 列表 / Trace 详情） | `max(endTime ?? startTime) − min(startTime)`（trace 总跨度） | 同左 | **列表与详情必须一致** |
| 调用耗时（Generations / Models 调用明细） | `endTime − startTime`（单次调用） | 同左 | 逐次调用，不是 trace 跨度 |

> 因此 **Agents 与 Models 的错误率 / P95 / 成本口径不同是刻意设计，不是 bug**。改动任一侧，必须同步更新另一侧的 UI `title` 与本文件。

实现位置：`web/src/server/overview.ts`（全局 + Agent 榜）、`web/src/server/agentStats.ts`（Agent 维度）、`web/src/server/modelStats.ts`（Model 维度）。

---

## 4. 时间窗

统一拆成「当前窗口 vs 前一等长窗口」，用于环比 delta 与异常标记。但**对齐方式目前不统一**（见 §8）：

| 页面 | 默认 | 选项 | 对齐 |
|---|---|---|---|
| Overview / Agents / Models | 7 天 | 7 / 14 / 30 | 日历天（`since = 今天 00:00 − (days−1) 天`） |
| Analytics | 7 天 | 7 / 14 / 30 | 日历天 |
| Sessions | 全部 | 全部 / 7 / 30 | 日历天 |
| Traces | 最近 7 天 | `from` / `to` + 快捷区间 | 滚动（`from = now − 7d`） |

---

## 5. 信号（异常检测）

**单一真源：`web/src/server/signals.ts`，阈值集中在 `SIGNAL_THRESHOLDS`。** 任何页面都不得再自行写阈值。

- **指标信号**（需要前窗对比）：成本↑ / 错误率↑ / P95↑
- **轨迹信号**（单 trace 内判定）：重复调用 / 疑似无效循环 / 长任务

消费方：

| 位置 | 信号类型 | 计算范围 |
|---|---|---|
| Overview「待关注」 | 指标 + 轨迹 | 指标=全局/Agent/Model 聚合；轨迹=窗口内**最近 `TRACE_SIGNAL_SCAN_LIMIT`(=100) 个 trace** |
| Agents / Models 目录「标记」列 | 指标 | 每个对象 |
| Analytics 异常卡 | 指标 | 每个模型 |
| Traces 列表「信号」列 | 轨迹 | **当前页**每个 trace |
| Trace 详情「轨迹信号」条 | 轨迹 | 该 trace 全量 observation（不受「仅异常」过滤影响） |

> 硬性要求：**同一条 trace 在 Traces 列表与 Trace 详情必须给出相同轨迹信号**（两者都基于全量 observation 走同一份 `traceSignalOf`）。

---

## 6. 页面职责与归属

| 页面 | 回答什么问题 | 归属维度 | 可下钻到 |
|---|---|---|---|
| `/` Overview | 现在整体健康吗？今天有什么要看的？ | 跨维度 | Agents / Models / Traces |
| `/traces` | 有哪些 trace？哪个有问题？ | trace | Trace 详情 |
| `/traces/[id]` | 这一个 trace 到底怎么跑的？ | trace | Agent / Model / Session |
| `/sessions` | 一次会话里发生了哪些 trace？ | session | Session 详情 |
| `/agents` | 每个 Agent 表现如何、版本怎么演进？ | agent | Model / Trace / Session |
| `/models` | 每个模型表现如何、谁在用它？ | model | Agent / Trace / Session |
| `/analytics` | 全局指标、趋势、延迟分布 | 跨维度 | Models / Agents / 拓扑 |
| `/analytics/generations` | 逐次模型调用检索与导出 | generation | Trace / Model |

设计原则：**对象视角（Agent / Model）收敛到实体页；Analytics 只留全局指标与趋势，不再重复实体表格。** 旧下钻路由 `/analytics/models?model=` 与重复入口 `/generations` 均已移除（分别重定向与删除）。

---

## 7. 列表与详情约定

1. **排序 / 分页必须下推 SQL**，在「全量结果」上排序后再取当前页；**禁止「只排当前页」**（否则第 2 页可能出现比第 1 页更大的极值）。
2. 空值统一置后（`is null` 作前导排序键，asc/desc 都成立）。
3. 列表页与详情页的同名指标必须同口径（见 §3）。
4. 模糊搜索用 `textSearch()`，不要手写 `LIKE`。
5. **展示命名**（同一事物只能有一个名字）：
   - 实体 / 导航 / 页面标题 → **`Traces`**
   - 「trace 的计数」这一指标 → 统一叫 **`Trace 数`**，**禁止**叫「任务数 / 任务」
   - 文案中 → 「N 个 trace」
   - 字段名一律 `traces`（**不得**再用 `tasks`，历史上因 `tasks` 与「任务」双关导致过同名不同义）
   - 两个例外，不算违规：轨迹信号名「**长任务**」（STEP 节点 ≥8 的已定义概念，不是计数）；评估中心的「**任务**」指评估作业（Evaluation job），与 trace 无关。

---

## 8. 已知取舍与遗留项

| 项 | 现状 | 影响 / 建议 |
|---|---|---|
| Overview 轨迹信号采样 | 只扫描窗口内最近 `TRACE_SIGNAL_SCAN_LIMIT`(=100) 个 trace | Overview 的轨迹信号是采样值，不是全量；Traces 列表信号列不受此限 |
| 聚合未下推 SQL | Overview / Agents / Models 目录仍把窗口内数据全量读入内存再聚合 | 自托管数据量下可用；量级上来需改 SQL 聚合或增量预聚合（不要在无实测瓶颈时动手） |
| 时间窗对齐不统一 | Agents/Models/Analytics 用日历天，Traces 用滚动 7 天（§4） | 跨页对比时会有 <=1 天错位；建议统一为一种并对齐文案 |
| Generations 与 Models 调用明细重叠 | 都能「按模型看调用」 | 前者跨模型检索 + CSV 导出，后者带对象上下文；保留二者，但需在入口文案上区分 |
| Agents / Models 口径差异 | 错误率、P95、成本刻意不同 | 目前只在 UI `title` 层面对齐，未做统一抽象 |
| 鉴权 | 端点均无需鉴权，无多租户隔离（见 README） | 仅供单机 / 内网自托管 |

---

## 附：本文件对应的实现入口

| 关注点 | 文件 |
|---|---|
| 信号阈值与统一判定 | `web/src/server/signals.ts` |
| 全局聚合 | `web/src/server/overview.ts` |
| Agent 维度 | `web/src/server/agentStats.ts` |
| Model 维度 | `web/src/server/modelStats.ts` |
| Traces 筛选与归属条件 | `web/src/server/traceQuery.ts` |
| 轨迹行构建（列表 / 详情共用） | `web/src/server/trajectory.ts` |
| 展示格式化 | `web/src/lib/format.ts` |

# Machora 设计方案

> 参考 Langfuse 架构的简化版 LLM / AI Agent 可观测平台。单进程、零外部依赖（PGlite）。
> 本版重点：**接入 LangChain / LangGraph 等框架的真实 Agent 观测数据（OpenTelemetry 优先）**。

## 1. 定位

面向 LLM 应用的轻量可观测平台，覆盖：**注入 → 存储 → 查询 → 评分 → 展示**。

- **MVP 范围**：traces、observations（span/generation/event）、scores、project 多租户、User（登录预留）、API Key 鉴权、批量注入、**OTel 观测数据接入**。
- **后续项**：Web 仪表盘（UI）、prompts 管理、datasets、自动 evals、webhooks、ClickHouse 列存、RBAC、blob 导出。

## 2. 核心设计原则（继承自 Langfuse）

- **observation 是主分析单元**，trace 只是关联句柄
- **宽事件优先**：一个 observation 携带全部上下文，避免 metrics/log/trace 三套碎片
- **不可变事件**：append-only，更新走 upsert（流式 trace 先入 pending 再补 end）
- **热路径反规范化**：projectId 冗余到 trace/observation 行，免 join
- **API 契约 scale-aware**：强制时间窗、游标分页、字段选择
- **操作简单性是约束**：不引入额外数据库/队列/MV，除非长期负担值得

## 3. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（Node 20+） | 与 Langfuse 对齐，前后端同语言 |
| 包管理 | pnpm + workspace | monorepo 标配 |
| 构建编排 | turbo | 增量构建 |
| 数据库 | PGlite（进程内 Postgres） | 零外部依赖，Prisma 直连 |
| ORM | Prisma | schema 即真源，类型安全 |
| 校验 | Zod | runtime 校验 + 类型推导 |
| 认证 | 预留 next-auth（Credentials）+ API Key Basic Auth | API Key 鉴权已实现 |
| Web 框架 | Next.js（App Router，后续接入） | UI + API 同栈 |
| 协议层 | **OTLP（OpenTelemetry）优先** + 后续 LangSmith 兼容 API | 见 §6 |

## 4. Monorepo 结构

```
machora/
├─ packages/shared/    # 领域模型 + Prisma + OTel 处理（单一真源）
├─ web/                # Next.js: UI（7 页）+ tRPC + 公共 REST（已并入原型）
├─ worker/             # 队列处理器（并入原型；独立进程模式待 Redis）
└─ standalone/         # 单进程入口 start.ts（PGlite + Next.js in-process + worker）
```

依赖方向：standalone → web + worker + shared；web → shared；worker → shared；shared 不反向依赖。

## 5. 数据模型（参考 Langfuse `packages/shared/prisma/schema.prisma`）

见 `packages/shared/prisma/schema.prisma`。要点：

- **Project / ApiKey / User**：多租户 + `pk-`/`sk-` 密钥（bcrypt 存储），Basic Auth 鉴权
- **Trace**：宽事件模型，`id` = OTel traceId（hex），冗余 `projectId`，含 `userId/sessionId/environment/tags/input/output/metadata`
- **Observation**：主分析单元，`id` = OTel spanId，`type ∈ {SPAN, GENERATION, EVENT}`，`parentObservationId` 支持 Agent 多级调用树（Agent → Tool → LLM）；`usage/inputTokens/outputTokens/totalTokens/totalCost` 由服务端从 usage 推算
- **Score**：trace/observation 级评分（NUMERIC/CATEGORICAL/BOOLEAN）

## 6. Agent 观测数据接入（本次重点）

### 6.1 现状与目标

Machora 已有事件注入 API（trace/observation/score 手工上报），但**缺少真实 Agent 运行数据**：
开发者不愿为观测改业务代码。目标：**LangChain / LangGraph 应用通过环境变量或几行配置，零改动把真实 trace 灌入 Machora**。

### 6.2 三通道策略

| 通道 | 机制 | 状态 | 说明 |
|---|---|---|---|
| **B. OTel / OTLP（主）** | `POST /api/public/otel/v1/traces`，兼容 OTLP HTTP 导出 | **Phase 0 已实现（JSON）** | 厂商中立，LangChain py/js、LangGraph、LlamaIndex(OpenInference)、Vercel AI SDK、Pydantic AI、CrewAI 均原生导出 OTel |
| **A. LangSmith 兼容 API（辅）** | 实现 `/api/public/runs` 等端点，`LANGCHAIN_TRACING_V2=true` + `LANGCHAIN_ENDPOINT` 指向 Machora | 后续 Phase | 数据最完整（含流事件/反馈），需逆向兼容字段 |
| **C. 原生 Machora SDK（备）** | TS/Python SDK + LangChain `BaseCallbackHandler` | **Python SDK 已实现（2026-08-02）** | 给不支持前两者的框架或自定义控制用（见 §6.5） |

### 6.3 OTel 接入设计（Phase 0 实现范围）

**端点与协议**
- `POST /api/public/otel/v1/traces`，Basic Auth（`pk:sk`）
- 支持 **OTLP JSON**（`Content-Type: application/json`）与 **OTLP protobuf**（`Content-Type: application/x-protobuf`，多数 SDK 默认格式）；protobuf 由 `protobufjs` 按内嵌 OTLP schema 解码后复用同一处理管线
- 请求体上限 16MB；`int64` 字段按 OTLP 规范以十进制字符串传输，解码时转 number

**Span → Trace / Observation 映射**（参考 Langfuse `OtelIngestionProcessor` + `ObservationTypeMapperRegistry`）

1. **层级重建**：`traceId` → Machora Trace；`spanId` → Observation.id；`parentSpanId` → `parentObservationId`（父不在本批则视为根）。根 span 派生 Trace 记录
2. **类型映射（优先级从高到低）**：
   - `langfuse.observation.type`（span/generation/event…）
   - `openinference.span.kind`（CHAIN/RETRIEVER/LLM/EMBEDDING/AGENT/TOOL…）
   - `gen_ai.operation.name`（chat/completion/embeddings/invoke_agent/execute_tool…）
   - `gen_ai.tool.name` / `gen_ai.tool.call.id` → TOOL
   - 含模型信息（`gen_ai.request.model` 等）→ GENERATION
   - 兜底 SPAN
   - （Machora 当前 `type` 枚举仅 SPAN/GENERATION/EVENT；AGENT/TOOL/CHAIN 语义先落在 SPAN.name 上，后续扩展枚举）
3. **属性提取**：
   - input/output：`langfuse.observation.input/output` → `gen_ai.input.messages/output.messages` → `gen_ai.prompt/completion` → `gen_ai.tool.call.arguments/result`
   - model：`langfuse.observation.model.name` → `gen_ai.request.model` → `gen_ai.response.model`
   - usage/cost：`gen_ai.usage.input_tokens/output_tokens`、`langfuse.observation.usage_details/cost_details`
   - level：`langfuse.observation.level`（OTel 严重级别别名映射），`status.code=2` → ERROR
   - trace 级：`langfuse.trace.name/user.id/session.id/tags/metadata`、`langfuse.environment`、resource 的 `service.name/version`、`deployment.environment`
   - metadata：其余属性（剔除已提取项与噪声键 `gen_ai.prompt*`、`gen_ai.completion*`、`llm.*`）
4. **落库策略**：按 span 顺序 upsert（trace 先、observation 后），流式补全（先 endTime=null 再更新）；单条失败不中断整批，错误收集返回

**LangChain / LangGraph 接入示例**

```bash
# Python：langchain-opentelemetry 自动埋点（LLM + 工具 + 图节点）
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:3100/api/public/otel
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Basic <base64(pk:sk)>"
export OTEL_SERVICE_NAME=my-agent
```

```ts
// JS/TS：@langchain/opentelemetry + OTLPTraceExporter
const exporter = new OTLPTraceExporter({
  url: "http://localhost:3100/api/public/otel/v1/traces",
  headers: { Authorization: `Basic ${btoa("pk:sk")}` },
});
```

### 6.4 OpenClaw 接入（本地 Agent Runtime 自观测）

OpenClaw 是本地常驻的个人智能体，**原生支持 OTel 全链路追踪**（OTLP），且按 GenAI 语义约定
产出 span（agent / tool / LLM 调用）。接入 machora 零代码改动，只需在启动 OpenClaw 的终端
执行：

```bash
source scripts/connect-openclaw.sh   # 设置 OTEL_* 环境变量指向 machora
```

脚本要点：探活 → 生成 Basic Auth（pk:sk）→ 设置
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:3100/api/public/otel`、
`..._PROTOCOL=http/protobuf`（OpenClaw 仅支持此协议）、`..._HEADERS="Authorization=Basic …"`、
`OTEL_SERVICE_NAME`。注意：环境变量只覆盖导出地址，**还需配置启用插件**（
`plugins.entries["diagnostics-otel"].enabled` + `diagnostics.otel.enabled`，见 §7）。
OpenClaw 每次 agent 运行即作为一条 trace（含工具调用/LLM 调用子 span）出现在 machora UI。

### 6.5 原生 Python SDK（通道 C，已实现 2026-08-02）

`sdk/python/`：包名 `machora-sdk`（模块 `machora`），依赖 `httpx` + `pydantic`，
可选依赖 `langchain-core`（回调埋点）。**仓库内实现，未发布 PyPI**。

- **事件契约**：与 `packages/shared/src/domain/index.ts` 的 zod schema 对齐
  （trace-create / observation-create / score-create，字段 camelCase，type 枚举大写）。
  事件先缓存，`flush()` 按 trace→observation→score 稳定排序后批量 POST
  `/api/public/ingestion`（同批先建 trace 满足外键）
- **客户端 API**：`MachoraClient`（Basic Auth；凭据走 `MACHORA_*` / 兼容 `LANGFUSE_*` 环境变量）；
  `client.trace(...)` 上下文管理器自动 flush；`t.span(...)` / `t.generation(...)` handle 在
  `end()` 时生成含 start/end 的完整 observation（服务端 create 非 upsert，重复 id 会失败，
  因此不采用"先建后补"流式补全）；`t.score(...)` 按值推断 dataType
  （bool→BOOLEAN、str→CATEGORICAL、数字→NUMERIC）；低层 `create_trace/create_observation/create_score`
  供手动控制
- **LangChain 回调**：`MachoraCallbackHandler`（`langchain_core.callbacks.BaseCallbackHandler`），
  一次顶层链 run = 一条 trace，LLM/chat 调用 = GENERATION，工具/子链 = SPAN，
  error 事件 → level=ERROR；顶层 chain_end 自动 flush。注意：langchain-core 对简单链
  （`prompt | llm`）做 run 合并优化，子 run 不独立触发回调，此时只有 trace 无 observation，
  属框架行为而非 SDK 缺陷
- **LangGraph 接入（走 OTel 通道，验证于 2026-08-02）**：LangGraph 1.x 默认把节点/模型子 run
  合并进顶层 run，第三方回调拿不到 LLM/工具子级（实测 invoke/ainvoke/stream 均只触发
  graph 级 chain 事件），因此回调 SDK 不适用；正确接入是**通道 B OTel**——标准
  `opentelemetry-sdk` + `OTLPSpanExporter`（http/protobuf）指向 `/api/public/otel/v1/traces`，
  span 按 OTel GenAI 语义约定埋点（`openinference.span.kind`、`gen_ai.operation.name`、
  `gen_ai.request.model`、`gen_ai.usage.*`），machora 映射为 trace + SPAN/GENERATION。
  示例：`sdk/python/examples/langgraph_demo.py`（已验证：agent=SPAN、chat=GENERATION 落库）
- **验证**：18/18 unittest 通过（MockTransport 验证排序/Basic Auth/序列化/回调映射）；
  端到端（standalone production）：原生注入的 trace/observation/score 与 LangChain 回调的
  trace 均在 UI 可见
- **示例**：`sdk/python/examples/demo.py`（原生 + LangChain 两种用法）

## 7. 实现现状与偏差记录（2026-08-01）

- **全量合并（2026-08-01）**：已把原型（`langfuse/machora`，web UI 7 页 + worker + pricing + seed-demo + 65 测试）整体并入本仓库，并叠加 OTel 接入：
  - schema 保留 `parentObservationId`（Agent 调用树）
  - shared 新增 `server/auth.ts` + `otel/`（OTLP 解码 + span→observation 映射）
  - web 新增 `app/api/public/otel/v1/traces/route.ts`（OTLP HTTP JSON 注入）
- **Phase 0 验证**：curl 注入模拟 LangGraph agent 三层 OTLP（agent → tool → LLM），1 trace + 3 observation 落库，层级/类型/token 映射正确。
- **Phase 2（protobuf）**：OTLP protobuf 解码已实现（`packages/shared/src/otel/protobuf.ts`，protobufjs + 内嵌官方 schema），`application/x-protobuf` 与 JSON 双通道输出同构，解码结果复用 `parseOtelPayload` 管线。
- **OpenClaw 真实接入验证（2026-08-01）**：
  - 克隆 `openclaw/openclaw`（`e:\code\opensource\openclaw`，HEAD b5a59e0a），`pnpm install` 后用本地配置（`scripts/openclaw.local.json5`，`OPENCLAW_CONFIG_PATH` 指向）启动 gateway
  - 确认 OpenClaw `diagnostics-otel` 插件**仅支持 `http/protobuf`**（[service.ts](https://github.com/openclaw/openclaw/blob/main/extensions/diagnostics-otel/src/service.ts) 里其他协议直接 abort），因此 `connect-openclaw.sh` 已从 `http/json` 改为 `http/protobuf`
  - 启用要点：`plugins.entries["diagnostics-otel"].enabled` + `diagnostics.otel.{enabled,endpoint,protocol,headers}`（headers 带 Basic Auth pk:sk）
  - 实跑结果：gateway 启动即产生 `openclaw.liveness.warning` / `openclaw.diagnostic.phase` 等 trace 落库，observation 层级、resource/metadata（service.name、host、process 等）映射正确；一次 agent 调用（模型不可用报错）也正确生成 error trace
- **DeepSeek 模型 + 复杂任务验证（2026-08-01）**：
  - 安装 `@openclaw/deepseek-provider`（`openclaw plugins install`，npm 包），配置 `agents.defaults.model.primary=deepseek/deepseek-v4-pro`，API key 经 `DEEPSEEK_API_KEY` 注入（config 同级 `scripts/.env`，dotenv 自动加载）
  - 真实 agent run：`openclaw agent --agent main "say hello"` 成功，trace 含 `openclaw.harness.run → openclaw.run → openclaw.model.call(GENERATION)`，usage 23084/206/23290 正确映射
  - 切 `deepseek/deepseek-v4-flash` 后跑复杂任务（exec 工具 + machora-demo skill + MCP add 工具），agent 三路均完成；machora 侧调用树含 `openclaw.exec`、`openclaw.skill.used`（skill=machora-demo）、多个 `openclaw.model.call`
  - MCP 接入验证方式：`mcp.servers.<name>` 注册本地 stdio server（`scripts/mcp-demo-server.mjs`，零依赖 JSON-RPC），`tools.sandbox.tools.alsoAllow` 放行 `bundle-mcp`；`skills.load.extraDirs` + `agents.defaults.skills` 启用自定义 skill
  - **发现**：OpenClaw 的 OTel 导出对 MCP 工具调用**不产生独立 span**（MCP 工具执行不发 `tool.execution` 诊断事件），exec/skill/模型调用均有 span；machora 侧无需处理，属于 OpenClaw 遥测覆盖边界
- **真实 trace fixture + UT（2026-08-01）**：把 OpenClaw 真实上报保留为测试数据
  - `scripts/capture-otel.mjs` 捕获代理：临时把 `diagnostics.otel.endpoint` 指向 `http://localhost:3105/api/public/otel`，重跑复杂任务，将 OTel exporter 的原始 OTLP protobuf 请求体落盘。注意：exporter 发送 `transfer-encoding: chunked`，转发时须剔除该头，否则 Node fetch 报 `invalid transfer-encoding header`
  - fixture 位于 `packages/shared/src/otel/fixtures/`：`raw/openclaw-{1,2}.bin`（原始 protobuf，同一 trace 分两批导出）、`openclaw-{1,2}.json`（decodeOtlpProtobuf 解码产物）、`openclaw-full.json`（两批按 protobuf 消息拼接规则合并，兼作 mock 数据源）；`scripts/decode-otel-fixture.mjs` 可重新生成 json
  - 新增 `packages/shared/src/otel/openclaw.test.ts`（6 用例）：protobuf/JSON 双通道一致性（decode(bin)===json、decode(bin1+bin2)===openclaw-full.json、两通道 parseOtelPayload 结果 toEqual）、主 trace 层级（harness.run←run←model.call/context.assembled/tool.execution、harness.run←exec）、model.call→GENERATION（model=deepseek-v4-flash、usage 24736/111）、exec/tool.execution→SPAN（gen_ai.tool.name 提取为 observation.name，openclaw.* 与 resource 入 metadata）、liveness.warning/model.usage 独立 trace
- **已知偏差**：
  - Observation 仅冗余 projectId；environment/userId 反规范化待 OTel 维度聚合时补齐
  - worker 独立进程模式未做（同进程共享 queueBus，无 Redis）
- **UI 对齐 Langfuse 修复（2026-08-01）**：核对 UI 发现 observation type 大小写 bug（数据层存 `GENERATION`/`SPAN`，UI 用小写比较），导致 traces 列表"耗时"列恒为 "—"、详情页类型徽章/时间轴颜色全部落 amber。已修复：
  - `web/src/app/traces/page.tsx`：latency 判定改为大写 `GENERATION`
  - `web/src/app/traces/[id]/page.tsx`：typeColor/barColor/badge 改为大写比较
  - 详情页 observations 由平铺表格改为**调用树缩进视图**（按 parentObservationId 递归渲染，depth 缩进）
  - Observation 详情卡片补充 **METADATA / USAGE** 区块（OpenClaw 上报的 `openclaw.*` 字段与 cache tokens 现可在 UI 查看）
  - 已用真实 OpenClaw fixture 注入 machora 验证：HTTP 200，时间轴含紫色 GENERATION 条，缩进 18/36px 两级，badge purple×18 / blue×20
- **traces 列表多维筛选（2026-08-01）**：`web/src/app/traces/page.tsx` 在名称+时间窗基础上新增用户/会话/模型/标签（逗号分隔 hasEvery）/级别（ERROR/WARNING/DEFAULT/DEBUG）筛选；模型与级别通过 `observations.some` 子查询，标签用数组 `hasEvery`，筛选参数随分页链接透传。验证：model=deepseek → 7 条，level=ERROR → 0 条（当前无 ERROR 数据），level=DEFAULT → 75 条
- **span events → EVENT observation（2026-08-01）**：OTLP span 内带时间戳的事件流此前被丢弃，现已映射为 `EVENT` observation：
  - `packages/shared/src/otel/processor.ts`：`FlattenedSpan` 增加 `events` 字段（`{time, name, attrs}[]`，解码时用 `nanosToDate` 转时间、`decodeAttributes` 转 attrs）；observation 循环末尾为每个事件生成 `EVENT` observation，挂在该 span 下（`parentObservationId=spanId`），`startTime=endTime=事件时间`，attrs 入 `metadata`，事件名含 `exception` 时 level=ERROR，否则 DEFAULT
  - 覆盖场景：`gen_ai.choice`（流式输出，attrs 含 delta）、`exception`（异常记录）等
  - `packages/shared/src/otel/protobuf.test.ts` 新增 `buildEventSpanFixture()`（手工 wire-format 构造含 2 事件的 span）+ `describe("span events → EVENT observation")`：断言 1 SPAN + 2 EVENT、id 形如 `<spanId>:e{i}`、exception → ERROR、metadata 正确；全测 44/44 通过
  - 端到端验证：注入 1 trace（2 事件）→ 3 observation（1 GENERATION + 2 EVENT）落库，详情页 HTTP 200，EVENT 徽章（amber）与 gen_ai.choice/exception metadata 均正确渲染
  - **陷阱**：spanId 作为 Observation 主键，注入测试数据若与库中既有 id 冲突，prisma upsert 走 UPDATE 分支不更新 traceId，会把 observation 悬挂到旧 trace——测试数据须保证 id 唯一
- **UI 补强（2026-08-01）**：对照 Langfuse 盘点后补齐三处（Scores/Sessions/时间轴/调用树此前已具备）：
  - 修复首页 [Generation 延迟] 统计的 type 大小写 bug（`type: "generation"` → `"GENERATION"`，此前 OTel 大写数据匹配不到，延迟恒为空；修复后正确显示，如 6.30s）
  - 新增 **Users 页**（`web/src/app/users/page.tsx`，导航 Sessions 旁）：按 userId 聚合 trace 数/obs/token/成本/ERROR/最近活动，行内链接跳 `/traces?user=<userId>` 复用列表筛选
  - traces 列表 **Score 列增强**：由计数徽章改为显示最近 2 条评分 chips（`name:value`，NUMERIC toFixed(3) / BOOLEAN ✓✗），超过显示 `+N` 溢出计数
  - 验证：注入 1 trace（2 score）后列表 chip、Users 聚合均正确渲染
- **消除 RSC 预取噪音（2026-08-01）**：浏览器 console 频繁出现 `net::ERR_ABORTED`（`?_rsc=` 请求）——`next/link` 即使 `prefetch={false}`，点击导航仍走 client router 发 RSC 取数请求，快速导航即被 abort。本应用纯服务端渲染（全部 `force-dynamic`），无需 SPA 过渡：新增 `web/src/components/NativeLink.tsx`（原生 `<a>` 包装，剥离 prefetch prop），10 个页面 import 从 `next/link` 改为该组件，彻底绕开 client router，RSC 请求与 ERR_ABORTED 不再产生。代价：导航为整页加载（页面 <100ms，无感知）。

## 8. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **Phase 0** | schema + shared + OTel JSON 注入端点 | 一条真实格式 OTLP 注入后落库可查 |
| **Phase 1** | LangChain/LangGraph demo 用环境变量灌数 + Web 列表/详情 UI（Next.js） | 一次 Agent 运行完整呈现调用树 |
| **Phase 2** | ~~OTLP protobuf~~ ✅、流事件（gen_ai.choice 等）、metadata 去噪完善 | 与 Python 默认导出兼容 |
| **Phase 3** | LangSmith 兼容 API（通道 A）、查询 API 游标分页、评估 | LangChain 应用零改动接入 |

## 9. 构建与发布（2026-08-01）

- **完整编译产物链路**：此前所有包 tsconfig 均 `noEmit`（生产靠 tsx 运行时转译）。现已改为真实编译：
  - 各包新增 `tsconfig.build.json`（`module/moduleResolution: NodeNext`、`outDir: dist`）；shared/worker 开 `declaration`；shared 另开 `rewriteRelativeImportExtensions`（源码大量 `.ts` 扩展相对导入，emit 时改写为 `.js`，需 TypeScript ≥5.7，已统一升到 ^5.9.0）
  - `@machora/shared`：`main/types/exports` 指向 `dist/*`（`type: module`）；`build` 产出 dist + .d.ts
  - `@machora/worker`：`exports "." → dist/app.js`（导出 `registerQueueProcessors`），`build` 产出 dist
  - `@machora/standalone`：`start` 改为 `NODE_ENV=production node dist/start.js`（**零 tsx**）；`registerQueueProcessors` 从 `import("../../worker/src/app.ts")` 改为 `import("@machora/worker")`（workspace 依赖）；`start.ts` 里 `resolve(import.meta.dirname, "..", "..")` 在 dist 下指向仓库根不变，prisma/next 路径无需调整
  - `turbo.json`：`dev` 加 `dependsOn: ["^build"]`（dev 前先产出 dist）；包级 turbo `outputs: []` 删除，统一用全局 `dist/**`、`.next/**`
  - 验证：`pnpm build` 4/4 成功；`pnpm standalone:start`（production）启动正常（`Next.js 启动（in-process，production）`），全页面 200，ingestion 注入 + users 聚合正常；shared 测试 44/44
- **发布打包（`scripts/release.mjs`，根 `pnpm release`）**：`pnpm build` → 组装 `.release/machora-<version>/`（源码 + dist + prisma schema + web/.next + start.cmd/start.sh + README.txt）→ 系统 `tar`（libarchive）打 zip（**不能用 PowerShell Compress-Archive**：会写 Windows Recent 目录触发沙箱拦截）→ 打印发布指引。分发形态：目标机 `pnpm install --frozen-lockfile` → `start.cmd`（`node standalone/dist/start.js`）
- **npm / pip 发布探索结论**：
  - **npm 可行（推荐）**：`@machora/shared` 已是标准库包形态（dist + .d.ts + exports），去掉 `private` + 加 `files` 后 `pnpm publish --access public` 即可，价值最高（OTel protobuf 解码/解析纯函数可复用）。完整应用也可做成 npm 包（`bin` 入口 + pglite/next 等 dependencies + web/.next 随包），包体积约 10–50MB
  - **pip 不适用**：machora 是 Node/TypeScript 运行时，PyPI 包需内嵌整个 Node 应用（node_modules 无法由 pip 管理）或要求系统 node + 安装时 npm install，跨平台与体积成本高、收益低。若需 Python 生态消费，应走 HTTP API（/api/public/ingestion + OTel 端点）而非本地包装
- **Turbopack Prisma 外部化陷阱（发布包验证发现，2026-08-02）**：
  - 现象：发布包解压全新环境启动后 health 200，但所有页面 500，报 `Cannot find module '.prisma/client/default'`（开发仓库正常）
  - 根因：Next 16 Turbopack 把 `@prisma/client` 外部化为 `web/.next/node_modules/@prisma/client-<hash>` 副本，其 `default.js` 内是 `require('.prisma/client/default')`——**该字符串不是相对路径（缺 `./` 前缀）**，Node 会把它当包名沿 node_modules 链向上解析（`副本/node_modules → web/.next/node_modules/.prisma → web/node_modules → 根 node_modules`）。开发仓库恰好命中 pnpm 虚拟存储里的 `.prisma` 包，发布包全新环境无此目录 → 解析失败
  - 修复：`web/next.config.ts` 配 `serverExternalPackages: ["@prisma/client"]`（未阻止副本生成，仅作语义声明）；真正兜底在 `standalone/src/start.ts` 的 `ensureNextPrismaClientCopy()`——`prisma generate` 后把生成的 client 复制到 **`web/.next/node_modules/.prisma/client`**（包解析链上正确位置），Next.js 启动前完成
  - 验证：重新打包（365.0MB）→ 全新目录解压 → `pnpm install --frozen-lockfile`（110 包）→ production 启动出现 `[Prisma] 已把 client 补到 .next/node_modules/.prisma/client` → 全页面 200，ingestion 401（认证保护，符合预期）

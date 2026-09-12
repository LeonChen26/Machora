# Machora

简化版 LLM / AI Agent 可观测平台，参考 [Langfuse](https://langfuse.com) 架构实现。
**单进程、零外部依赖**（SQLite 嵌入式数据库），一条命令跑起完整的
**注入 → 存储 → 查询 → 评分 → 展示** 可观测链路。

![Machora](machora.jpg)

## 核心能力

- **Traces / Observations / Scores**：observation.type 与 span.kind 一致的多值角色（ENTRY/AGENT/STEP/LLM/TOOL/EMBEDDING/CHAIN/RETRIEVER/RERANKER/EVENT/SPAN），支持父子调用树（`parentObservationId` 嵌套层级）与详情选中详览
- **Trace 详情 5 Tab**：Langfuse 式分区——调用树（左树右详情）、时间线（gantt）、推理轨迹（五色语义 DAG：ENTRY/AGENT/STEP/LLM/TOOL）、对话（从 LLM input/output.messages 提取气泡视图）、评分（ScoreForm + 评分表）；trace 级详情（kv + IO + metadata）并入 tree/timeline 右侧面板
- **Generations 视图**（Analytics 分组下）：独立 LLM 调用列表，支持按模型/级别/时间窗筛选与排序（时间/耗时/Token/成本）
- **CSV 导出**：`GET /api/export/traces`、`GET /api/export/generations`，按当前筛选条件导出
- **Scores API**：UI 标注 `POST /api/scores`；公开查询/写入 `GET/POST /api/public/scores`，支持人工/自动评分写入与查询
- **评估中心**（`/evaluations`）：可插拔评估器（5 规则：error/latency/cost/token/tag + **LLM-as-judge** 对 trace/轨迹打分并输出理由 reasoning）；在线（`autoRun`，ingestion 后自动触发 ONLINE 任务）/实验（手动/批量）双模式；**Prompt 级数据集**（DatasetItem 用例 + 多配置对比评测报告）；按天评分**趋势**折线图；低分样本回流（score&lt;阈值）；评估任务**人工评审**（改分 + 备注写回 ANNOTATION score）
- **Sessions 页**：按 sessionId 聚合 trace（Trace 数 / 成功率 / 平均 Trace 耗时 / Token / 成本 / 跨度汇总 + 时间线串联），支持 sessionId 搜索与分页；详情页提供**会话对话视图**——跨 trace 平铺 LLM input/output.messages 为聊天气泡（role 分色 + model 徽标 + 工具调用 + 跳转对应 trace）
- **Agents / Models 双实体视图**：`/agents`、`/models` 目录页（KPI 卡 + 环比 + 趋势 sparkline + 异常标记），详情页含指标卡、可切每日趋势、版本/工具/模型分布（Agent）、按 Agent 分布与调用明细（Model）、关联会话与评分汇总；对象间可互跳
- **统一异常信号**：阈值集中在 `web/src/server/signals.ts`，覆盖指标信号（成本↑ / 错误率↑ / P95↑）与轨迹信号（重复调用 / 疑似无效循环 / 长任务），在 Overview「待关注」、目录「标记」列、Analytics 异常卡、Traces「信号」列与 Trace 详情信号条统一呈现；指标口径约定见 [OBSERVABILITY.md](OBSERVABILITY.md)
- **OTLP 接入**：`POST /api/public/otel/v1/traces` 接收 OpenTelemetry 数据（JSON + protobuf 双通道），任意 OTLP exporter 可直接上报（示例见 `scripts/connect-openclaw.sh`、`sdk/python/examples/langgraph_demo.py`）
- **Python SDK**（`sdk/python`，包名 `machora-sdk`）：OTel 探针 —— LangChain 回调（`MachoraOtelCallbackHandler`）与 LangGraph 图级探针（`MachoraOtelGraphProbe`），直接输出 `machora.*` 语义
- **Web UI**：侧边栏分「观测 / 质量 / 平台」三组——观测（Overview / Traces / Sessions / Agents / Models / Analytics：总览 / Agent 拓扑 / Generations）、质量（Scores / Evaluations）、平台（System / Docs）；三态主题（亮色 / 暗色 / 跟随系统）、异常行高亮、SVG 导航图标、统一过滤表单、CSV 导出、docs 目录滚动高亮、图表 hover 数值浮层；依赖拓扑为 Agent → Tool → Model 三层 SVG，节点按五色语义着色

## 快速开始

要求：Node.js 与 pnpm workspace（根 `package.json` 的 `devEngines` 指定 pnpm 11.10.0；npm registry 走 npmmirror，见 `.npmrc`）

> **Node 版本**：要求 `>=20 <27`（见根 `package.json` 的 `engines`）。存储层用 `better-sqlite3`
> 原生模块，其预编译二进制**与 Node 大版本的 ABI 强绑定**。用 A 版本 Node 安装、换 B 版本 Node
> 运行会直接报 `NODE_MODULE_VERSION` 不匹配（`ERR_DLOPEN_FAILED`）。切换 Node 版本后请重跑
> `pnpm install`（或 `pnpm rebuild better-sqlite3`）。

> 安装说明：`better-sqlite3` 需预编译二进制。若无法直连 GitHub Releases，请先设置镜像环境变量再安装：
> ```powershell
> $env:npm_config_better_sqlite3_binary_host_mirror="https://registry.npmmirror.com/-/binary/better-sqlite3"
> pnpm install
> ```
> （`.npmrc` 中已写入同名配置，但 pnpm 不会将其透传给生命周期脚本，故仍需环境变量。）

> **从旧版本升级**：本分支不包含任何旧库兼容/迁移逻辑。若 `DATA_DIR` 下存在旧版本数据
> （旧版 `pglite/` 目录，或旧结构的 `machora.db`），请**先删除整个 `DATA_DIR`** 再启动，
> 程序会按 `schema.sql` 的全新结构重建数据库。

```bash
pnpm install
pnpm standalone:start   # 生产模式，默认 http://localhost:3100
```

开发模式（热重载）：`pnpm dev`

常用环境变量（可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3100` | Web 端口 |
| `DATA_DIR` | `./.machora-data` | 数据目录（内含 `machora.db`，删除即清空） |

应用根目录（`start.cmd` / `node standalone/dist/start.js` 所在目录）存在 `.env` 文件时自动加载，可参考 `.env.example` 复制改名。

## 上报示例

`sdk/python/examples/`：

- `call_chain_demo.py`：多层嵌套调用链（演示 parentObservationId 层级树）
- `langgraph_demo.py`：LangGraph 走 OTel 通道（标准 `OTLPSpanExporter`，`openinference.span.kind` 属性直接落库 type）

上报时把环境变量 `MACHORA_HOST`（默认 `http://localhost:3100`）指向目标实例即可。

## 架构

pnpm workspace monorepo，依赖方向：`standalone → web + worker + shared`，`web/worker → shared`。

| 包 | 说明 |
|---|---|
| `packages/shared` | 领域模型（Zod）+ Drizzle schema（schema.sql 幂等建表）+ SQL 方言隔离层 + OTel 解码/解析 + 队列（单一真源） |
| `web` | Next.js App Router UI（force-dynamic SSR）+ tRPC + 公共 REST（otel / health / public 查询） |
| `worker` | 队列处理器（standalone 进程内注册，共享 queueBus，无 Redis） |
| `standalone` | 单进程入口：SQLite + schema.sql 建表 + Next.js in-process |
| `sdk/python` | Python SDK（OTel 探针：`opentelemetry-*`；LangChain 回调需可选 `langchain-core`） |

技术栈：TypeScript · Next.js · tRPC · Drizzle ORM · SQLite（better-sqlite3，嵌入式）· Zod · OpenTelemetry（protobufjs）

## 开发命令（仓库根）

```bash
pnpm dev          # 全量开发模式
pnpm build        # 全量构建
pnpm test         # 全量测试
pnpm typecheck    # 全量类型检查
pnpm lint         # 全量 lint
pnpm release      # 打包发布 zip（scripts/release.mjs）
```

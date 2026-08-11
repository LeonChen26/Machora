# Machora

简化版 LLM / AI Agent 可观测平台，参考 [Langfuse](https://langfuse.com) 架构实现。
**单进程、零外部依赖**（PGlite 进程内 Postgres），一条命令跑起完整的
**注入 → 存储 → 查询 → 评分 → 展示** 可观测链路。

![Machora](machora.jpg)

## 核心能力

- **Traces / Observations / Scores**：observation.type 与 span.kind 一致的多值角色（ENTRY/AGENT/STEP/LLM/TOOL/EMBEDDING/CHAIN/RETRIEVER/RERANKER/EVENT/SPAN），支持父子调用树（`parentObservationId` 嵌套层级）与详情选中详览
- **Trace 详情 4 Tab**：Langfuse 式分区——调用树（左树右详情）、对话（从 LLM input/output.messages 提取气泡视图）、评分（ScoreForm + 评分表）、详情（kv 基本信息 + Trace input/output/metadata）
- **Generations 页**：独立 LLM 调用列表，支持按模型/级别/时间窗筛选与排序（时间/耗时/Token/成本）
- **CSV 导出**：`GET /api/export/traces`、`GET /api/export/generations`，按当前筛选条件导出
- **Scores API**：UI 标注 `POST /api/scores`（session 鉴权）；公开查询/写入 `GET/POST /api/public/scores`（Basic Auth），支持人工/自动评分写入与查询
- **OTLP 接入**：`POST /api/public/otel/v1/traces` 接收 OpenTelemetry 数据（JSON + protobuf 双通道），任意 OTLP exporter 可直接上报（示例见 `scripts/connect-openclaw.sh`、`sdk/python/examples/langgraph_demo.py`）
- **批量注入 API**：`POST /api/public/ingestion`，Basic Auth（pk:sk）鉴权，单批 ≤1000 条、按收到顺序写入（同一批先建 trace 再挂 observation，满足外键依赖）；支持 `parentObservationId` 构建嵌套调用树
- **Python SDK**（`sdk/python`，包名 `machora-sdk`）：原生注入客户端 + LangChain 回调（`MachoraCallbackHandler`）
- **多租户**：Project 隔离 + API Key 管理（bcryptjs 校验）
- **Web UI**：Overview / Traces / Generations / Analytics / Scores / Sessions / Users / Projects / API Keys / Docs（三态主题：亮色 / 暗色 / 跟随系统；异常行高亮、SVG 导航图标、统一过滤表单、CSV 导出）

## 快速开始

要求：Node.js 与 pnpm workspace（根 `package.json` 的 `devEngines` 指定 pnpm 11.10.0；npm registry 走 npmmirror，见 `.npmrc`）

```bash
pnpm install
pnpm standalone:start   # 生产模式，默认 http://localhost:3100
```

开发模式（热重载）：`pnpm dev`

首次启动自动 seed：

| 项 | 值 |
|---|---|
| Project | `Machora Project`（id: `project-standalone`） |
| Public Key | `pk-machora-dev-000000000000000000000` |
| Secret Key | `sk-machora-dev-000000000000000000000` |
| 管理员账号 | `admin@machora.local` / 由 `MACHORA_INIT_USER_PASSWORD` 指定（部署时建议显式设置） |

常用环境变量（可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3100` | Web 端口 |
| `PG_PORT` | `5434` | PGlite 端口 |
| `DATA_DIR` | `./.machora-data` | 数据目录（删除即清空） |
| `MACHORA_INIT_USER_PASSWORD` | 无 | 管理员初始密码（建议在应用目录 `.env` 中设置；未设置时首次启动随机生成并打印在日志） |

应用根目录（`start.cmd` / `node standalone/dist/start.js` 所在目录）存在 `.env` 文件时自动加载，可参考 `.env.example` 复制改名。`MACHORA_SESSION_SECRET` 不设置时自动持久化到 `DATA_DIR/session-secret`。

## 上报示例

`sdk/python/examples/`：

- `demo.py`：原生注入 + LangChain 回调两种用法
- `call_chain_demo.py`：多层嵌套调用链（演示 parentObservationId 层级树）
- `langgraph_demo.py`：LangGraph 走 OTel 通道（标准 `OTLPSpanExporter`，`openinference.span.kind` 属性直接落库 type）

上报时把环境变量 `MACHORA_HOST`（默认 `http://localhost:3100`）指向目标实例即可；凭据走 `MACHORA_PUBLIC_KEY` / `MACHORA_SECRET_KEY`。

## 架构

pnpm workspace monorepo，依赖方向：`standalone → web + worker + shared`，`web/worker → shared`。

| 包 | 说明 |
|---|---|
| `packages/shared` | 领域模型（Zod）+ Drizzle schema（schema.sql 幂等建表）+ OTel 解码/解析 + 鉴权 + 队列（单一真源） |
| `web` | Next.js App Router UI（force-dynamic SSR）+ tRPC + 公共 REST（ingestion / otel / health） |
| `worker` | 队列处理器（standalone 进程内注册，共享 queueBus，无 Redis） |
| `standalone` | 单进程入口：PGlite + schema.sql 建表 + seed + Next.js in-process |
| `sdk/python` | Python SDK（httpx + pydantic，可选 langchain-core） |

技术栈：TypeScript · Next.js · tRPC · Drizzle ORM · PGlite（进程内 Postgres）· Zod · OpenTelemetry（protobufjs）· bcryptjs

## 开发命令（仓库根）

```bash
pnpm dev          # 全量开发模式
pnpm build        # 全量构建
pnpm test         # 全量测试
pnpm typecheck    # 全量类型检查
pnpm lint         # 全量 lint
pnpm release      # 打包发布 zip（scripts/release.mjs）
```

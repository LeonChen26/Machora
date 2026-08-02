# Machora

简化版 LLM / AI Agent 可观测平台，参考 [Langfuse](https://langfuse.com) 架构实现。
**单进程、零外部依赖**（PGlite 进程内 Postgres），一条命令跑起完整的
**注入 → 存储 → 查询 → 评分 → 展示** 可观测链路。

![Machora](machora.jpg)

## 核心能力

- **Traces / Observations / Scores**：SPAN、GENERATION、EVENT 三种观测类型，支持父子调用树与详情选中详览
- **OTLP 接入**：`POST /api/public/otel/v1/traces` 接收 OpenTelemetry 数据（JSON + protobuf 双通道），任意 OTLP exporter 可直接上报（示例见 `scripts/connect-openclaw.sh`、`sdk/python/examples/langgraph_demo.py`）
- **批量注入 API**：`POST /api/public/ingestion`，Basic Auth（pk:sk）鉴权，单批 ≤1000 条、按收到顺序写入（同一批先建 trace 再挂 observation，满足外键依赖）
- **Python SDK**（`sdk/python`，包名 `machora-sdk`）：原生注入客户端 + LangChain 回调（`MachoraCallbackHandler`）
- **多租户**：Project 隔离 + API Key 管理（bcryptjs 校验）
- **Web UI**：概览 / Traces / 模型分析 / Scores / Sessions / Users / Projects / API Keys / 接入文档（三态主题：亮色 / 暗色 / 跟随系统）

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
| Project | `project-standalone` |
| Public Key | `pk-machora-dev-000000000000000000000` |
| Secret Key | `sk-machora-dev-000000000000000000000` |
| 管理员账号 | `admin@machora.local` / `admin123` |

常用环境变量（可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3100` | Web 端口 |
| `PG_PORT` | `5434` | PGlite 端口 |
| `DATA_DIR` | `./.machora-data` | 数据目录（删除即清空） |

## 上报示例

`sdk/python/examples/`：

- `demo.py`：原生注入 + LangChain 回调两种用法
- `call_chain_demo.py`：多层嵌套调用链（演示 parentObservationId 层级树）
- `langgraph_demo.py`：LangGraph 走 OTel 通道（标准 `OTLPSpanExporter`，`openinference.span.kind` 属性映射 SPAN/GENERATION）

上报时把环境变量 `MACHORA_HOST`（默认 `http://localhost:3100`）指向目标实例即可；凭据走 `MACHORA_PUBLIC_KEY` / `MACHORA_SECRET_KEY`。

## 架构

pnpm workspace monorepo，依赖方向：`standalone → web + worker + shared`，`web/worker → shared`。

| 包 | 说明 |
|---|---|
| `packages/shared` | 领域模型（Zod）+ Prisma schema + OTel 解码/解析 + 鉴权 + 队列（单一真源） |
| `web` | Next.js App Router UI（force-dynamic SSR）+ tRPC + 公共 REST（ingestion / otel / health） |
| `worker` | 队列处理器（standalone 进程内注册，共享 queueBus，无 Redis） |
| `standalone` | 单进程入口：PGlite + Prisma push + seed + Next.js in-process |
| `sdk/python` | Python SDK（httpx + pydantic，可选 langchain-core） |

技术栈：TypeScript · Next.js · tRPC · Prisma · PGlite（进程内 Postgres）· Zod · OpenTelemetry（protobufjs）· bcryptjs

## 文档

- [`design.md`](design.md)：完整设计方案（OTel 接入、Python SDK、三态主题、构建与发布等）

## 开发命令（仓库根）

```bash
pnpm dev          # 全量开发模式
pnpm build        # 全量构建
pnpm test         # 全量测试
pnpm typecheck    # 全量类型检查
pnpm lint         # 全量 lint
pnpm release      # 打包发布 zip（scripts/release.mjs）
```

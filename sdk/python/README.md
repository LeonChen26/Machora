# machora-sdk

Machora 可观测平台的 Python SDK：向 Machora 注入 **trace / observation / score**。

Machora 是参考 Langfuse 架构的轻量 LLM / AI Agent 可观测平台（单进程、零外部依赖、PGlite）。
本 SDK 是它的通道 C（原生 SDK），同时支持 LangChain 自动埋点回调。

## 安装

```bash
pip install machora-sdk
```

## 快速开始

```python
from machora import MachoraClient

client = MachoraClient(
    public_key="pk-...",
    secret_key="sk-...",
    host="http://localhost:3100",
)

# 上下文管理器：退出时自动 flush
with client.trace(name="my-agent", user_id="u-1") as t:
    with t.span(name="tool-call", input={"q": 1}) as s:
        s.end(output={"r": 2})

    t.generation(
        name="chat",
        model="gpt-4o-mini",
        input={"role": "user", "content": "hello"},
        output={"role": "assistant", "content": "hi"},
        usage={"prompt_tokens": 10, "completion_tokens": 5},
    ).end()

    t.score(name="quality", value=0.92)

# 手动控制：事件先缓存，flush() 批量发送（自动按 trace→observation→score 排序）
tid = client.create_trace(name="manual")
client.create_observation(tid, type="SPAN", name="step-1", end_time=None)
client.flush()

# 未传凭据时从环境变量读取（MACHORA_* / LANGFUSE_*）
client = MachoraClient()
```

## LangChain 自动埋点

```python
from machora.langchain import MachoraCallbackHandler
from langchain_core.callbacks import CallbackManager

handler = MachoraCallbackHandler()  # 或传入已构造的 client
CallbackManager.configure(handlers=[handler])
```

一次顶层链 run = 一条 trace；LLM/chat 调用 = LLM；工具/子链 = SPAN；错误 → ERROR。

> 注意：LangGraph 1.x 会把节点/模型子 run 合并进顶层 run，回调拿不到子级——
> LangGraph 请走 OTel 通道（见 Machora 仓库 `examples/langchain-agent`）。

## Machora 原生 OTel 探针（可选）

`machora.otel` 提供基于 **machora.\*** 语义的 OTel 探针（安装 `machora-sdk[otel]`），
span 经 `POST /api/public/otel/v1/traces` 上报，`machora.span.kind` 直接落库
`observation.type`（ENTRY/AGENT/STEP/CHAIN/LLM/TOOL/RETRIEVER...）。

LangChain 探针（`MachoraOtelCallbackHandler`）：

```python
from langchain_core.callbacks import CallbackManager
from machora.otel import MachoraOtelCallbackHandler

handler = MachoraOtelCallbackHandler()   # 凭据走 MACHORA_OTEL_* 环境变量
CallbackManager.configure(handlers=[handler])
```

LangGraph 图级探针（`MachoraOtelGraphProbe`，graph → ENTRY、agent 节点 → AGENT、其余 → STEP）：

```python
from machora.otel import MachoraOtelGraphProbe

probe = MachoraOtelGraphProbe()
graph = probe.wrap(graph)                 # 注册节点监听
result = probe.invoke(graph, {"messages": [...]})
```

环境变量：`MACHORA_OTEL_ENDPOINT`（默认 `http://localhost:3100/api/public/otel/v1/traces`）、
`MACHORA_OTEL_HEADERS`（JSON 对象，如 `{"Authorization": "Basic <base64(pk:sk)>"}`）、
`MACHORA_OTEL_SERVICE_NAME`。OTel SDK 缺失或端点不可用时探针静默禁用（fail-open）。

## 事件契约

与 Machora 服务端 `IngestionBatchSchema` 对齐（trace-create / observation-create / score-create，
字段 camelCase，type 枚举大写）。事件先缓存，`flush()` 按 trace→observation→score 排序后批量
POST `/api/public/ingestion`。

## 开发

```bash
pip install -e .[langchain]
pytest
```

## 链接

- 项目仓库：Machora（含 standalone 服务端、OTel 端点、Web UI）
- 兼容：`MACHORA_*` / `LANGFUSE_*` 环境变量（host/public_key/secret_key）

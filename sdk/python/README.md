# machora-sdk

Machora 可观测平台的 Python SDK：通过 **OTLP 探针** 向 Machora 上报 **trace / observation**。

Machora 是参考 Langfuse 架构的轻量 LLM / AI Agent 可观测平台（单进程、零外部依赖、SQLite）。
本 SDK 的通道是 OTel（OpenTelemetry），并内置 LangChain / LangGraph 探针。

## 安装

```bash
pip install 'machora-sdk[otel]'
```

- OTLP 探针 / LangGraph 图级探针（`MachoraOtelGraphProbe`）：`pip install 'machora-sdk[otel]'` 即可
- LangChain 自动埋点（`MachoraOtelCallbackHandler`）：额外需要 langchain-core，请装
  `pip install 'machora-sdk[otel,langchain]'`

## 快速开始

SDK 通过标准 OTLP/HTTP 上报 span，`machora.span.kind` 直接落库 `observation.type`。

### LangChain 自动埋点

（需 `machora-sdk[otel,langchain]`）

```python
from langchain_core.callbacks import CallbackManager
from machora.otel import MachoraOtelCallbackHandler

handler = MachoraOtelCallbackHandler()   # 地址走 MACHORA_OTEL_* 环境变量
CallbackManager.configure(handlers=[handler])
```

一次顶层链 run = 一条 trace；LLM/chat 调用 = LLM；工具 = TOOL；子链 = CHAIN（agent 链 = AGENT）；错误 → ERROR。

### LangGraph 图级探针

LangGraph 1.x 会把节点/模型子 run 合并进顶层 run，回调拿不到子级——LangGraph 请走
OTel 通道。`MachoraOtelGraphProbe` 注册节点监听（graph → ENTRY、agent 节点 → AGENT、其余 → STEP）：

```python
from machora.otel import MachoraOtelGraphProbe

probe = MachoraOtelGraphProbe()
graph = probe.wrap(graph)                 # 注册节点监听
result = probe.invoke(graph, {"messages": [...]})
```

## Machora 原生 OTel 探针

`machora.otel` 提供基于 **machora.\*** 语义的 OTel 探针（安装 `machora-sdk[otel]`），
span 经 `POST /api/public/otel/v1/traces` 上报，`machora.span.kind` 直接落库
`observation.type`（ENTRY/AGENT/STEP/CHAIN/LLM/TOOL/RETRIEVER...）。

暴露的公共 API：

| 名称 | 说明 |
| --- | --- |
| `MachoraOtelCallbackHandler` | LangChain 自动埋点回调 |
| `MachoraOtelGraphProbe` | LangGraph 图级探针（`wrap` / `invoke`） |
| `create_probe_tracer` | 构造 fail-open 的 OTel tracer 基座 |
| `KIND_*`（ENTRY / AGENT / STEP / CHAIN / LLM / TOOL / EMBEDDING / RETRIEVER）/ `SPAN_KIND` / `TRACE_NAME` 等 | `machora.*` 语义键常量 |

也可以不经探针、直接用原生 `opentelemetry-sdk` 接入（参见 `examples/langgraph_demo.py`、
`examples/call_chain_demo.py`）：

```python
from opentelemetry import trace as otel_trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider(resource=Resource(attributes={"service.name": "my-app"}))
provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter(endpoint="http://localhost:3100/api/public/otel/v1/traces")
    )
)
otel_trace.set_tracer_provider(provider)
```

### 配置

环境变量：

- `MACHORA_OTEL_ENDPOINT`（默认 `http://localhost:3100/api/public/otel/v1/traces`）
- `MACHORA_OTEL_HEADERS`（JSON 对象，如 `{"X-Custom": "value"}`）
- `MACHORA_OTEL_SERVICE_NAME`

OTel SDK 缺失或端点不可用时探针静默禁用（fail-open），不影响业务代码。

## 开发

```bash
pip install -e '.[otel]'
pytest
```

## 链接

- 项目仓库：Machora（含 standalone 服务端、OTel 端点、Web UI）

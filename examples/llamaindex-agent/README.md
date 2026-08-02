# LlamaIndex 示例 Agent —— Machora 可观测演示（OpenInference）

一个 LlamaIndex Agent / RAG 示例，演示如何把真实 Agent 调用树灌入
[Machora](../../design.md) 可观测平台。走 **OpenInference 语义**（`openinference.span.kind`），
与 design.md §6.3 参考基线第 2 条对齐。

## 效果

一次 `agent.run()` / `query_engine.query()` 会在 Machora 中产生 **1 条 trace**：

- **真实模型模式**（`OPENAI_API_KEY` 或 `OPENAI_BASE_URL`）：`AgentWorkflow` + 工具

  ```
  agent_workflow（AGENT → SPAN）
  ├── get_weather（TOOL → SPAN）
  ├── add（TOOL → SPAN）
  └── llm_call（LLM → GENERATION，含 token_count / model_name / cost）
  ```

- **离线 RAG 模式**（默认，无需 API key）：`VectorStoreIndex` + `MockEmbedding` + `MockLLM`

  ```
  query_engine（CHAIN → SPAN）
  ├── embed（EMBEDDING → GENERATION）
  └── llm_call（LLM → GENERATION）
  ```

Machora 的 [OTel 处理器](../../packages/shared/src/otel/processor.ts) 会把
`openinference.span.kind` 映射为 Observation 类型（LLM/EMBEDDING → GENERATION，
AGENT/TOOL/CHAIN/RETRIEVER → SPAN），并提取 `input.value`/`output.value`（JSON 解码）、
`llm.token_count.*`、`llm.model_name`、`llm.cost.total`、`user.id`/`session.id`/`tag.tags`/`agent.name`
到专用字段。

## 接入原理

只做一次 SDK 初始化（不写业务埋点），走 **OTLP 通道**（design.md §6.2 通道 B）：

```python
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from openinference.instrumentation.llamaindex import LlamaIndexInstrumentor

provider = TracerProvider()
provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(endpoint=..., headers=...)))
LlamaIndexInstrumentor().instrument(tracer_provider=provider)   # ← 核心注入点
```

> 与 LangChain 内置 OTel（通道 B）不同，OpenInference 需要显式调用 `instrument()`。

## 快速开始

### 1. 安装依赖

```bash
cd examples/llamaindex-agent
python -m venv .venv
.venv/Scripts/activate        # Windows；macOS/Linux 用 source .venv/bin/activate
pip install -r requirements.txt
```

### 2. 启动 Machora

```bash
cd ../..    # 仓库根
pnpm standalone:start        # 默认 http://localhost:3100，seed 凭据见下
```

Machora 默认 seed 的 API Key（见 `standalone/src/start.ts`）：

```
public key: pk-machora-dev-000000000000000000000
secret key: sk-machora-dev-000000000000000000000
```

### 3. 配置环境变量并运行

```bash
# PowerShell 示例
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:3100/api/public/otel/v1/traces"
$env:OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic <base64(pk:sk)>"
$env:OTEL_SERVICE_NAME = "llamaindex-demo"
python agent.py
```

> `OTEL_EXPORTER_OTLP_HEADERS` 需要 base64 编码的 `pk:sk`：
> `python -c "import base64; print(base64.b64encode(b'pk...:sk...').decode())"`
>
> 注意：endpoint 必须是**完整路径含 `/api/public/otel/v1/traces`**（Machora 的 OTel 端点），
> `opentelemetry-exporter-otlp-proto-http` 会原样使用该 URL。

### 4. 模型模式

- **真实模型**：设置 `OPENAI_API_KEY`（或 `OPENAI_BASE_URL` 指向 OpenAI 兼容端点，如
  DeepSeek）即走 `AgentWorkflow` + 真实工具调用。
- **离线模拟（默认）**：不设任何 key 时用 `MockEmbedding` + `MockLLM` 跑一个 RAG 查询，
  无需 API key 即可演示 CHAIN/EMBEDDING/LLM 调用树。

### 5. 查看结果

打开 `http://localhost:3100/traces`，按时间排序可见 `llamaindex-demo` 的 trace；进入详情页
可看到调用树缩进视图与 GENERATION 的模型/token/成本信息；Analytics 页「按 Agent 汇总」
会显示 `openinference.span.attributes.agent.name` 提取的 agent 名。

## 文件说明

| 文件 | 说明 |
|---|---|
| `agent.py` | OTel 初始化 + 工具定义 + Agent（真实）/ RAG（离线）双模式 |
| `requirements.txt` | 依赖（llama-index-core + openinference-instrumentation-llamaindex + OTLP exporter） |

## 备注

- LlamaIndex 需要显式 `LlamaIndexInstrumentor().instrument()`（LangChain 1.x 是内置自动）；
  两者属性体系不同：LangChain 走 `gen_ai.*`，LlamaIndex 走 `openinference.*`，Machora 均兼容。
- 环境变量需在**进程启动前**设置；脚本结束前 `time.sleep(1)` 给 SimpleSpanProcessor flush。

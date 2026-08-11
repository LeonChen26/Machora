# LangChain / LangGraph 示例 Agent —— Machora 可观测演示

一个 ReAct 风格 agent（LangGraph 图：`agent` 节点 + `ToolNode` + 条件边），演示如何把真实
Agent 调用树灌入 [Machora](../../design.md) 可观测平台。

## 效果

一次 `graph.invoke()` 会在 Machora 中产生 **1 条 trace**，调用树形如：

```
agent（根 span）
├── tools / get_weather（SPAN，工具调用）
└── ChatOpenAI / FakeMessagesListChatModel（LLM，模型调用）
```

## 接入原理

不写任何埋点代码，只靠环境变量。走 **OTLP 通道**（design.md §6.2 通道 B）：

- LangChain 1.x 内置 OpenTelemetry 支持（经
  [langsmith](https://docs.smith.langchain.com/) 的 `tracing_mode="otel"`），会把一次 run 自动
  导出为 OTLP span，且 span 自带 `gen_ai.operation.name` / `gen_ai.request.model` /
  `gen_ai.usage.*` 等属性——Machora 的
  [OTel 处理器](../../packages/shared/src/otel/processor.ts) 据此映射为
  Trace / Observation（含 token 统计与层级重建）。

## 快速开始

### 1. 安装依赖

```bash
cd examples/langchain-agent
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
$env:LANGSMITH_TRACING = "true"
$env:LANGSMITH_TRACING_MODE = "otel"
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:3100/api/public/otel/v1/traces"
$env:OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic <base64(pk:sk)>"
$env:OTEL_SERVICE_NAME = "langchain-demo"

# base64(pk:sk) = base64("pk-machora-dev-000000000000000000000:sk-machora-dev-000000000000000000000")
# 可用 python 生成：
#   python -c "import base64; print(base64.b64encode(b'pk...:sk...').decode())"

python agent.py
```

> 注意：langsmith 读的是 `OTEL_EXPORTER_OTLP_ENDPOINT`（无 `_TRACES_` 中缀），且要求
> **完整路径含 `/v1/traces`**（它直接透传给 OTLPSpanExporter，不会自动补后缀）；
> 若漏掉 `/v1/traces` 会得到 `404 Not Found`。

### 4. 模型模式

- **真实模型**：设置 `OPENAI_API_KEY`（或 `OPENAI_BASE_URL` 指向 OpenAI 兼容端点，如
  DeepSeek）即走 `ChatOpenAI`，`OPENAI_MODEL` 可指定模型名。
- **离线模拟（默认）**：不设任何 key 时用 `FakeMessagesListChatModel` 预置一条带
  `tool_calls` 的消息 + 一条最终回答，无需 API key 即可演示完整调用树。

### 5. 查看结果

打开 `http://localhost:3100/traces`，按时间排序可见 `langchain-demo` 的 trace；进入详情页
可看到调用树缩进视图与 LLM 的 token/模型信息。

## 文件说明

| 文件 | 说明 |
|---|---|
| `agent.py` | 示例 agent（工具 + LangGraph 图 + 主流程） |
| `requirements.txt` | 依赖（含 `langsmith[otel]`） |

## 备注

- `langchain-opentelemetry` 独立包已从 PyPI 移除（2026），官方方案为 langsmith 内置 OTel；
  本示例即采用该方案，与 design.md §6.3 的 LangChain 接入示例一致。
- 环境变量需在**进程启动前**设置；span 由 langsmith 后台批量导出，脚本结束前请留出
  少许时间或保持进程运行以完成 flush。

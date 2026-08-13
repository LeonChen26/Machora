"""
LlamaIndex 示例 Agent —— Machora 可观测平台演示（OpenInference 通道）

用 LlamaIndex 构建一个简单的 Agent / RAG 应用，通过 OpenInference instrumentation
自动把完整调用树（AGENT/CHAIN → TOOL → LLM/EMBEDDING）灌入 Machora。

接入方式（零业务代码改动，只做一次 SDK 初始化）：
    OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3100/api/public/otel/v1/traces
    OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(pk:sk)>
    OTEL_SERVICE_NAME=llamaindex-demo

模型选择：
    - 设置了 OPENAI_API_KEY / OPENAI_BASE_URL（OpenAI 兼容端点，如 DeepSeek）→
      FunctionAgent + 真实 LLM + 工具（get_weather / add）
    - 否则 → 离线 RAG 演示（MockEmbedding + MockLLM，无需 API key，
      产生 CHAIN / EMBEDDING / LLM span，演示 OpenInference 调用树）

参考：
    - OpenInference: https://github.com/Arize-ai/openinference
    - LlamaIndex: https://docs.llamaindex.ai/
"""

from __future__ import annotations

import base64
import os
import time

from opentelemetry import trace as otel_trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from openinference.instrumentation.llama_index import LlamaIndexInstrumentor

# 凭据从环境变量读取（缺失时提示设置，不提供硬编码默认值）
PUBLIC_KEY = os.environ.get("MACHORA_PK")
SECRET_KEY = os.environ.get("MACHORA_SK")
if not PUBLIC_KEY or not SECRET_KEY:
    raise SystemExit(
        "缺少凭据：请设置环境变量 MACHORA_PK 与 MACHORA_SK"
        "（默认凭据见项目 .env.example / standalone 启动日志，不要硬编码到代码中）。"
    )


# ---------------------------------------------------------------------------
# 1. OTel 初始化（OpenInference instrumentation）
# ---------------------------------------------------------------------------

def setup_otel() -> None:
    """配置 OTel exporter 并启用 LlamaIndex 自动埋点。"""
    endpoint = os.environ.get(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "http://localhost:3100/api/public/otel/v1/traces",
    )
    # Machora 用 Basic Auth（pk:sk），headers 需自行 base64
    cred = base64.b64encode(f"{PUBLIC_KEY}:{SECRET_KEY}".encode()).decode()
    headers = {"Authorization": f"Basic {cred}"}

    provider = TracerProvider()
    provider.add_span_processor(
        SimpleSpanProcessor(
            OTLPSpanExporter(endpoint=endpoint, headers=headers)
        )
    )
    otel_trace.set_tracer_provider(provider)

    # OpenInference 要求显式调用 instrument()（与 LangChain 内置 OTel 不同）
    LlamaIndexInstrumentor().instrument(tracer_provider=provider)
    print(f"  OTel 已初始化，端点: {endpoint}")


# ---------------------------------------------------------------------------
# 2. 工具定义
# ---------------------------------------------------------------------------

def get_weather(city: str) -> str:
    """查询指定城市的天气（示例工具，返回固定数据）。"""
    weathers = {
        "beijing": "晴，25°C",
        "shanghai": "多云，28°C",
        "shenzhen": "阵雨，30°C",
    }
    return weathers.get(city.lower(), f"{city} 天气未知")


def add(a: float, b: float) -> float:
    """两个数字相加（示例计算工具）。"""
    return a + b


# ---------------------------------------------------------------------------
# 3. 两种运行模式
# ---------------------------------------------------------------------------

def run_agent() -> None:
    """真实模型模式：FunctionAgent + 工具调用。"""
    from llama_index.core.agent.workflow import AgentWorkflow
    from llama_index.core.tools import FunctionTool
    from llama_index.llms.openai import OpenAI

    llm = OpenAI(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        api_key=os.environ.get("OPENAI_API_KEY"),
        base_url=os.environ.get("OPENAI_BASE_URL") or None,
    )
    tools = [
        FunctionTool.from_defaults(fn=get_weather, name="get_weather"),
        FunctionTool.from_defaults(fn=add, name="add"),
    ]
    agent = AgentWorkflow.from_tools(
        tools,
        llm=llm,
        system_prompt="你是天气助手，用 get_weather 查询天气。",
    )
    print("\n" + "=" * 60)
    print("  LlamaIndex FunctionAgent 示例（真实模型）")
    print("=" * 60)
    resp = agent.run("北京今天天气怎么样？顺便算一下 3+4")
    print("\nAgent 回复:", resp)
    print("完整调用链（AGENT → TOOL → LLM）已作为一条 trace 上报 Machora")


def run_rag_offline() -> None:
    """离线模式：RAG 查询（MockEmbedding + MockLLM），无需 API key。

    演示 OpenInference 的 CHAIN / EMBEDDING / LLM span 落库。
    """
    from llama_index.core import Settings, VectorStoreIndex
    from llama_index.core.embeddings import MockEmbedding
    from llama_index.core.llms import MockLLM
    from llama_index.core.schema import Document

    docs = [
        Document(text="Machora 是一个参考 Langfuse 架构的 LLM 可观测平台，"
                      "单进程运行，零外部依赖。"),
        Document(text="Machora 支持通过 OpenTelemetry OTLP 接入观测数据，"
                      "兼容 OTel GenAI 语义与 OpenInference 语义。"),
    ]
    # 离线模式必须注入全局 Settings，否则 as_query_engine 默认解析 OpenAI
    Settings.llm = MockLLM()
    Settings.embed_model = MockEmbedding(embed_dim=8)
    index = VectorStoreIndex.from_documents(
        docs,
        llm=Settings.llm,
        embed_model=Settings.embed_model,
        show_progress=False,
    )
    query_engine = index.as_query_engine(similarity_top_k=1)

    print("\n" + "=" * 60)
    print("  LlamaIndex RAG 示例（离线 Mock）")
    print("=" * 60)
    resp = query_engine.query("Machora 支持什么接入方式？")
    print("\n回答:", resp.response)
    print("调用链（CHAIN → EMBEDDING → LLM）已作为一条 trace 上报 Machora")


# ---------------------------------------------------------------------------
# 4. 主流程
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("  LlamaIndex 示例 Agent —— Machora 可观测演示")
    print("=" * 60)
    setup_otel()

    real = os.environ.get("OPENAI_API_KEY") or os.environ.get("OPENAI_BASE_URL")
    if real:
        run_agent()
    else:
        print("  未设置 OPENAI_API_KEY，走离线 RAG 演示模式")
        run_rag_offline()

    # 给 SimpleSpanProcessor 一点时间 flush
    time.sleep(1)


if __name__ == "__main__":
    main()

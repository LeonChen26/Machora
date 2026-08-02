"""LangGraph 应用接入 Machora（OTel 通道）示例。

LangGraph 1.x 默认把节点/模型子 run 合并进顶层，第三方回调拿不到 LLM/工具子级，
因此推荐走 OTel 通道（Machora /api/public/otel 已实现 OTLP HTTP JSON/protobuf）：
标准 OTEL_* 环境变量 + opentelemetry-sdk 即可，无需改业务代码。

运行：
    python examples/langgraph_demo.py
"""

import base64
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PUBLIC_KEY = os.environ.get(
    "MACHORA_PUBLIC_KEY", "pk-machora-dev-000000000000000000000"
)
SECRET_KEY = os.environ.get(
    "MACHORA_SECRET_KEY", "sk-machora-dev-000000000000000000000"
)
HOST = os.environ.get("MACHORA_HOST", "http://localhost:3100")

# 标准 OTLP 配置（等价于设置 OTEL_EXPORTER_OTLP_TRACES_* 环境变量）
from opentelemetry import trace as otel_trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_basic = base64.b64encode(f"{PUBLIC_KEY}:{SECRET_KEY}".encode()).decode()
provider = TracerProvider(
    resource=Resource(attributes={"service.name": "langgraph-demo"})
)
provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter(
            endpoint=f"{HOST}/api/public/otel/v1/traces",
            headers={"Authorization": f"Basic {_basic}"},
        )
    )
)
otel_trace.set_tracer_provider(provider)
tracer = otel_trace.get_tracer("machora.langgraph-demo")

from langchain_core.language_models.fake_chat_models import (
    FakeMessagesListChatModel,
)
from langchain_core.messages import AIMessage
from langgraph.graph import END, START, StateGraph
from typing import TypedDict


class State(TypedDict):
    q: str
    answer: str


model = FakeMessagesListChatModel(responses=[AIMessage(content="42")])


def agent_node(state: State) -> dict:
    # 节点 = SPAN（openinference.span.kind=AGENT）
    with tracer.start_as_current_span(
        "agent", attributes={"openinference.span.kind": "AGENT"}
    ) as span:
        with tracer.start_as_current_span(
            "chat", attributes={
                "gen_ai.operation.name": "chat",
                "gen_ai.request.model": "fake-chat-model",
                "gen_ai.usage.input_tokens": 8,
                "gen_ai.usage.output_tokens": 4,
            }
        ) as llm:
            answer = model.invoke([{"role": "user", "content": state["q"]}]).content
            llm.set_attribute("gen_ai.completion", answer)
        span.set_attribute("gen_ai.input", state["q"])
        return {"answer": answer}


g = StateGraph(State)
g.add_node("agent", agent_node)
g.add_edge(START, "agent")
g.add_edge("agent", END)
app = g.compile()

result = app.invoke({"q": "what is 6*7?"})
print("[demo] LangGraph 执行完成，answer =", result["answer"])
provider.force_flush()
print("[demo] OTel span 已导出到", HOST)

"""复杂调用链示例（OTel 通道，展示多层嵌套 observation 树）。

构造一条多层级调用链（模拟真实 agent 一次运行）：
    agent (AGENT)
    ├─ search (TOOL)
    │   └─ chat (LLM, gpt-4o-mini)
    └─ plan (CHAIN)
        ├─ chat (LLM, deepseek-v3)
        └─ embed (EMBEDDING, text-embedding-3-small)

span 通过嵌套 context 自动建立 parent-child（OTLP parentSpanId），
machora 处理器重建为 parentObservationId，UI 调用树按层级缩进展示。

运行：
    python examples/call_chain_demo.py
"""

import base64
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PUBLIC_KEY = os.environ.get("MACHORA_PUBLIC_KEY")
SECRET_KEY = os.environ.get("MACHORA_SECRET_KEY")
if not PUBLIC_KEY or not SECRET_KEY:
    raise SystemExit(
        "缺少凭据：请设置环境变量 MACHORA_PUBLIC_KEY 与 MACHORA_SECRET_KEY"
        "（默认凭据见项目 .env.example / standalone 启动日志，不要硬编码到代码中）。"
    )
HOST = os.environ.get("MACHORA_HOST", "http://localhost:3100")

from opentelemetry import trace as otel_trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_basic = base64.b64encode(f"{PUBLIC_KEY}:{SECRET_KEY}".encode()).decode()
provider = TracerProvider(
    resource=Resource(attributes={"service.name": "call-chain-demo"})
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
tracer = otel_trace.get_tracer("machora.call-chain-demo")


def llm_span(name: str, model: str, prompt: str, prompt_tokens: int, completion_tokens: int) -> None:
    with tracer.start_as_current_span(
        name,
        attributes={
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": model,
            "gen_ai.usage.input_tokens": prompt_tokens,
            "gen_ai.usage.output_tokens": completion_tokens,
            "gen_ai.prompt": prompt,
        },
    ) as span:
        time.sleep(0.05)
        span.set_attribute("gen_ai.completion", f"{model} 的回答（模拟）")


with tracer.start_as_current_span(
    "agent",
    attributes={
        "openinference.span.kind": "AGENT",
        "gen_ai.input": "帮我把项目计划整理出来",
    },
) as root:
    # 工具调用：搜索 → 其内部有一次 LLM 调用
    with tracer.start_as_current_span(
        "search",
        attributes={"openinference.span.kind": "TOOL", "gen_ai.tool.name": "search"},
    ) as tool:
        time.sleep(0.02)
        llm_span("chat", "gpt-4o-mini", "从文档中检索关键词：machora", 120, 45)
        tool.set_attribute("gen_ai.tool.call.arguments", '{"query": "machora"}')
        tool.set_attribute("gen_ai.tool.call.result", '{"hits": ["design.md"]}')

    # 子链：规划 → 两次 LLM + 一次向量化
    with tracer.start_as_current_span(
        "plan",
        attributes={"openinference.span.kind": "CHAIN"},
    ) as chain:
        time.sleep(0.02)
        llm_span("chat", "deepseek-v3", "根据检索结果生成实施计划", 300, 80)
        with tracer.start_as_current_span(
            "embed",
            attributes={
                "gen_ai.operation.name": "embeddings",
                "gen_ai.request.model": "text-embedding-3-small",
                "gen_ai.usage.input_tokens": 500,
            },
        ) as emb:
            time.sleep(0.02)
            emb.set_attribute("gen_ai.embedding.count", 3)

    root.set_attribute("gen_ai.output", "计划已生成（模拟）")

provider.force_flush()
print(f"[demo] 复杂调用链已导出到 {HOST}（agent → search/plan → chat/embed）")

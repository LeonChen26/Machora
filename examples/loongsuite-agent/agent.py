"""
LoongSuite 示例 Agent —— Machora 可观测平台演示（LoongSuite GenAI SemConv 通道）

用 LoongSuite GenAI Util（loongsuite-otel-util-genai）的 ExtendedTelemetryHandler
手动构造完整调用树（entry → invoke_agent → react_step → execute_tool(skill) → llm），
一次性演示 LoongSuite 相对 OTel GenAI 的增强语义：

    - entry / react_step / rerank / invoke_skill 操作显式枚举（Machora 映射 SPAN）
    - gen_ai.skill.*（skill.name 提取为 Trace/Observation 的 skillName 专用列）
    - session.id / user.id / gen_ai.agent.name 经 Baggage 染色整条链路

接入方式（Machora 端零代码改动，示例只是埋点方）：
    OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3100/api/public/otel/v1/traces
    OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(pk:sk)>
    OTEL_SERVICE_NAME=loongsuite-demo

模型选择：
    - 设置了 OPENAI_API_KEY / OPENAI_BASE_URL（OpenAI 兼容端点，如 DeepSeek）→
      在 llm span 内真实调用 chat/completions
    - 否则 → 离线 Mock（直接写入 output_messages，无需 API key），
      调用树结构与真实模式完全一致

参考：
    - LoongSuite: https://github.com/alibaba/loongsuite-python
    - GenAI Util 扩展规范: util/opentelemetry-util-genai/README-loongsuite.rst
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.request

from opentelemetry import trace as otel_trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.util.genai.extended_handler import get_extended_telemetry_handler
from opentelemetry.util.genai.extended_types import (
    EntryInvocation,
    ExecuteToolInvocation,
    ReactStepInvocation,
)
from opentelemetry.util.genai.types import InputMessage, OutputMessage, Text

# 凭据从环境变量读取（缺失时提示设置，不提供硬编码默认值）
PUBLIC_KEY = os.environ.get("MACHORA_PK")
SECRET_KEY = os.environ.get("MACHORA_SK")
if not PUBLIC_KEY or not SECRET_KEY:
    raise SystemExit(
        "缺少凭据：请设置环境变量 MACHORA_PK 与 MACHORA_SK"
        "（默认凭据见项目 .env.example / standalone 启动日志，不要硬编码到代码中）。"
    )


# ---------------------------------------------------------------------------
# 1. OTel 初始化（LoongSuite GenAI Util）
# ---------------------------------------------------------------------------

def setup_otel():
    """配置 OTel exporter 并获取 ExtendedTelemetryHandler 单例。

    按 LoongSuite 规范，消息正文默认不采集（NO_CONTENT），这里显式开启
    SPAN_AND_EVENT 以便 Machora UI 看到 input/output。
    """
    os.environ.setdefault("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
    os.environ.setdefault(
        "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "SPAN_AND_EVENT"
    )
    os.environ.setdefault("OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT", "true")

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

    handler = get_extended_telemetry_handler(tracer_provider=provider)
    print(f"  OTel 已初始化，端点: {endpoint}")
    return handler


# ---------------------------------------------------------------------------
# 2. 模型调用（真实 / 离线双模式）
# ---------------------------------------------------------------------------

def call_llm(messages, handler):
    """真实模式：在 llm span 内调用 OpenAI 兼容端点。

    返回 (content, input_tokens, output_tokens)。用标准库 urllib，零额外依赖。
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit(
            "缺少 OPENAI_API_KEY：真实模型模式需要设置 OPENAI_API_KEY 环境变量"
            "（如 DeepSeek 等 OpenAI 兼容端点的 key）；"
            "如需离线演示请去掉 OPENAI_BASE_URL 后重跑。"
        )
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps({"model": model, "messages": messages}).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    content = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return (
        content,
        usage.get("prompt_tokens", 0),
        usage.get("completion_tokens", 0),
    )


def mock_llm(messages):
    """离线模式：直接返回预置回复（调用树结构与真实模式一致）。"""
    return "北京今天晴，25°C。3 + 4 = 7。", 12, 8


def get_weather(city: str) -> str:
    """示例工具：查询天气（固定数据）。"""
    weathers = {
        "beijing": "晴，25°C",
        "shanghai": "多云，28°C",
        "shenzhen": "阵雨，30°C",
    }
    return weathers.get(city.lower(), f"{city} 天气未知")


def add(a: float, b: float) -> float:
    """示例工具：加法。"""
    return a + b


# ---------------------------------------------------------------------------
# 3. 构造调用树（LoongSuite 增强语义演示）
# ---------------------------------------------------------------------------

def run_demo(handler):
    """entry → invoke_agent → react_step → execute_tool(skill) + llm。

    - entry: session.id / user.id 写入 Baggage，染色整条链路
    - invoke_agent: agent_name 写入 Baggage + 本 span，下游自动带上
    - react_step: ReAct 单轮标识（round）
    - execute_tool: get_weather，并附加 gen_ai.skill.*（skillName 专用列演示）
    - llm: 真实模型或离线 Mock
    """
    real = bool(os.environ.get("OPENAI_API_KEY") or os.environ.get("OPENAI_BASE_URL"))

    with handler.entry(
        EntryInvocation(session_id="sess-loong-1", user_id="user-loong-1")
    ):
        with handler.invoke_agent() as agent_inv:
            agent_inv.provider = "openai"
            agent_inv.request_model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
            agent_inv.agent_name = "WeatherAssistant"
            agent_inv.input_messages = [
                InputMessage(role="user", parts=[Text(content="北京天气怎么样？顺便算 3+4")])
            ]

            with handler.react_step(ReactStepInvocation(round=1)):
                with handler.execute_tool(
                    ExecuteToolInvocation(tool_name="get_weather")
                ) as tool_inv:
                    tool_inv.skill_name = "weather"
                    tool_inv.skill_id = "workspace:default:weather"
                    tool_inv.skill_description = "查询城市天气"
                    tool_inv.skill_version = "1.0"
                    tool_inv.tool_call_arguments = {"city": "Beijing"}
                    tool_inv.tool_call_result = get_weather("Beijing")

                with handler.execute_tool(
                    ExecuteToolInvocation(tool_name="add")
                ) as tool_inv:
                    tool_inv.tool_call_arguments = {"a": 3, "b": 4}
                    tool_inv.tool_call_result = add(3, 4)

                with handler.llm() as llm_inv:
                    llm_inv.provider = "openai"
                    llm_inv.request_model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
                    llm_inv.input_messages = [
                        InputMessage(
                            role="user",
                            parts=[Text(content="总结：北京天气 + 3 与 4 的和")],
                        )
                    ]
                    messages = [
                        {"role": "user", "content": "北京天气怎么样？顺便算 3+4"}
                    ]
                    if real:
                        content, in_tok, out_tok = call_llm(messages)
                    else:
                        content, in_tok, out_tok = mock_llm(messages)
                    llm_inv.output_messages = [
                        OutputMessage(
                            role="assistant",
                            parts=[Text(content=content)],
                            finish_reason="stop",
                        )
                    ]
                    llm_inv.input_tokens = in_tok
                    llm_inv.output_tokens = out_tok

            agent_inv.output_messages = [
                OutputMessage(
                    role="assistant",
                    parts=[Text(content="北京今天晴，25°C；3 + 4 = 7。")],
                    finish_reason="stop",
                )
            ]

    print(f"  模式: {'真实模型' if real else '离线 Mock'}")
    print("  调用树已上报: entry → invoke_agent → react_step → execute_tool(skill) + llm")
    print("  skillName / agentName / sessionId / userId 已在 Machora 落库")


# ---------------------------------------------------------------------------
# 4. 主流程
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("  LoongSuite 示例 Agent —— Machora 可观测演示")
    print("=" * 60)
    handler = setup_otel()
    run_demo(handler)

    # 给 SimpleSpanProcessor 一点时间 flush
    time.sleep(1)


if __name__ == "__main__":
    main()

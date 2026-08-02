"""
LangChain / LangGraph 示例 Agent —— Machora 可观测平台演示

一个 ReAct 风格 agent（LangGraph 图：agent 节点 + ToolNode + 条件边），
通过 OpenTelemetry 自动把完整调用树（agent → tool → LLM）灌入 Machora。

接入方式（零业务代码改动，纯环境变量，走 LangChain 1.x 内置 OTel）：
    LANGSMITH_TRACING=true                     # 开启 LangSmith tracing 管线
    LANGSMITH_TRACING_MODE=otel                # 导出走 OTel 而非 LangSmith 云
    OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3100/api/public/otel/v1/traces
    OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(pk:sk)>
    OTEL_SERVICE_NAME=my-agent
    # 注意：langsmith 要求 endpoint 含完整 /v1/traces 后缀，漏掉会 404

模型选择：
    - 设置了 OPENAI_API_KEY / OPENAI_BASE_URL（OpenAI 兼容端点，如 DeepSeek）→ 真实模型
    - 否则 → FakeMessagesListChatModel 离线模拟（无需 API key，演示调用树）

参考：
    - LangGraph quickstart: https://langchain-ai.github.io/langgraph/tutorials/
    - LangChain OTel: https://docs.langchain.com/oss/python/observability/opentelemetry
"""

from __future__ import annotations

import os
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.graph.state import CompiledStateGraph


# ---------------------------------------------------------------------------
# 1. 工具定义
# ---------------------------------------------------------------------------

@tool
def get_weather(city: str) -> str:
    """查询指定城市的天气（示例工具，返回固定数据）。"""
    weathers = {
        "beijing": "晴，25°C",
        "shanghai": "多云，28°C",
        "shenzhen": "阵雨，30°C",
    }
    return weathers.get(city.lower(), f"{city} 天气未知")


@tool
def add(a: float, b: float) -> float:
    """两个数字相加（示例计算工具）。"""
    return a + b


TOOLS = [get_weather, add]


# ---------------------------------------------------------------------------
# 2. 模型选择：真实模型 或 离线模拟
# ---------------------------------------------------------------------------

def build_model():
    if os.environ.get("OPENAI_API_KEY") or os.environ.get("OPENAI_BASE_URL"):
        from langchain_openai import ChatOpenAI

        model = ChatOpenAI(model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))
        return model.bind_tools(TOOLS)

    # 离线模式：FakeMessagesListChatModel 按序返回预设消息，
    # 第一步带 tool_calls（触发工具执行），第二步给最终回答。
    # 注意：FakeMessagesListChatModel 未实现 bind_tools，直接返回预设消息即可。
    from langchain_core.language_models.fake_chat_models import (
        FakeMessagesListChatModel,
    )

    return FakeMessagesListChatModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "get_weather",
                        "args": {"city": "beijing"},
                        "id": "call_weather_1",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(
                content="北京今天的天气是晴，25°C。",
            ),
        ]
    )


# ---------------------------------------------------------------------------
# 3. LangGraph 图：agent 节点 + ToolNode + 条件边
# ---------------------------------------------------------------------------

class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]


def build_graph() -> CompiledStateGraph:
    model = build_model()

    def agent_node(state: AgentState) -> dict:
        response = model.invoke(state["messages"])
        return {"messages": [response]}

    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", ToolNode(TOOLS))
    graph.add_edge(START, "agent")

    def should_continue(state: AgentState) -> str:
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return "tools"
        return END

    graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")
    return graph.compile()


# ---------------------------------------------------------------------------
# 4. 主流程
# ---------------------------------------------------------------------------

def main() -> None:
    graph = build_graph()

    print("=" * 60)
    print("  LangChain / LangGraph 示例 Agent")
    print(f"  模型模式: {'真实模型' if (os.environ.get('OPENAI_API_KEY') or os.environ.get('OPENAI_BASE_URL')) else '离线模拟 (Fake)'}")
    print(f"  OTel 端点: {os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT', '<未设置>')}")
    print("=" * 60)

    result = graph.invoke(
        {"messages": [{"role": "user", "content": "北京今天天气怎么样？"}]}
    )
    print("\nAgent 回复:", result["messages"][-1].content)
    print("完整调用链已作为一条 trace 上报 Machora（若已配置 OTel 端点）")


if __name__ == "__main__":
    main()

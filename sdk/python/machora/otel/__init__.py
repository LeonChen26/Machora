"""machora.otel — Machora 原生 OTel 探针（Python SDK 可选模块）。

LangChain / LangGraph 探针基于本模块的 machora.* 语义键与 fail-open tracer
基座，把框架 run 映射为 machora.span.kind span，经 OTLP/HTTP 上报 Machora。
安装：pip install 'machora-sdk[otel]'
"""

from .constants import (
    AGENT_NAME,
    INPUT,
    KIND_AGENT,
    KIND_CHAIN,
    KIND_EMBEDDING,
    KIND_ENTRY,
    KIND_LLM,
    KIND_RETRIEVER,
    KIND_STEP,
    KIND_TOOL,
    LEVEL,
    MODEL_NAME,
    OPERATION,
    OUTPUT,
    SESSION_ID,
    SKILL_NAME,
    SPAN_KIND,
    TAGS,
    TOKEN_INPUT,
    TOKEN_OUTPUT,
    TOKEN_TOTAL,
    TOOL_CALL_ID,
    TOOL_NAME,
    TRACE_NAME,
    USER_ID,
    WORKFLOW_NAME,
)
from .base import create_probe_tracer

# 惰性导出：MachoraOtelCallbackHandler 依赖 langchain-core（可选 extra），
# MachoraOtelGraphProbe 依赖 LangGraph 运行时上下文。若在包顶层直接 import，
# 只安装 machora-sdk[otel] 的用户会因缺 langchain-core 导致整个包不可导入
# （连 MachoraOtelGraphProbe 也用不了）。改为 PEP 562 惰性加载：真正取用时
# 才导入对应子模块，缺依赖时给出明确指引。
_LAZY_EXPORTS = {
    "MachoraOtelCallbackHandler": (".langchain", "MachoraOtelCallbackHandler"),
    "MachoraOtelGraphProbe": (".langgraph", "MachoraOtelGraphProbe"),
}


def __getattr__(name: str):
    target = _LAZY_EXPORTS.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib

    module = importlib.import_module(target[0], __name__)
    return getattr(module, target[1])

__all__ = [
    "AGENT_NAME",
    "INPUT",
    "KIND_AGENT",
    "KIND_CHAIN",
    "KIND_EMBEDDING",
    "KIND_ENTRY",
    "KIND_LLM",
    "KIND_RETRIEVER",
    "KIND_STEP",
    "KIND_TOOL",
    "LEVEL",
    "MODEL_NAME",
    "OPERATION",
    "OUTPUT",
    "SESSION_ID",
    "SKILL_NAME",
    "SPAN_KIND",
    "TAGS",
    "TOKEN_INPUT",
    "TOKEN_OUTPUT",
    "TOKEN_TOTAL",
    "TOOL_CALL_ID",
    "TOOL_NAME",
    "TRACE_NAME",
    "USER_ID",
    "WORKFLOW_NAME",
    "create_probe_tracer",
    "MachoraOtelCallbackHandler",
    "MachoraOtelGraphProbe",
]

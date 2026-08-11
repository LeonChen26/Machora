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
from .langchain import MachoraOtelCallbackHandler
from .langgraph import MachoraOtelGraphProbe

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

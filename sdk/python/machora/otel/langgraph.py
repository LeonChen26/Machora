"""LangGraph 图级探针：graph.invoke → ENTRY，节点 → STEP/AGENT（machora.* 语义）。

用法：

    from machora.otel import MachoraOtelGraphProbe

    probe = MachoraOtelGraphProbe()          # 凭据走 MACHORA_OTEL_* 环境变量
    graph = probe.wrap(graph)                # 注册节点监听
    result = probe.invoke(graph, {...})      # 根 ENTRY span 包裹整次执行

span 树：
    graph.invoke       -> ENTRY（根，携带 machora.trace.name / user / session）
    agent 节点         -> AGENT（节点名含 "agent"）
    其余节点           -> STEP
    节点内 LLM/Tool    -> 由 LangChain 探针（MachoraOtelCallbackHandler，同一 tracer）
                          上报并挂到当前 active context（根 ENTRY 下）

图内模型/工具若未配置 LangChain 探针，则只看到图级 ENTRY/STEP/AGENT。
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .base import create_probe_tracer
from .constants import (
    INPUT,
    KIND_AGENT,
    KIND_ENTRY,
    KIND_STEP,
    LEVEL,
    OUTPUT,
    SESSION_ID,
    SPAN_KIND,
    TRACE_NAME,
    USER_ID,
)

logger = logging.getLogger(__name__)

try:
    from opentelemetry.trace import StatusCode
except Exception:  # pragma: no cover - fail-open
    StatusCode = None


class MachoraOtelGraphProbe:
    """LangGraph 图级探针（fail-open：无 OTel SDK 时静默跳过）。"""

    def __init__(
        self,
        *,
        tracer: Any = None,
        service_name: str = "langgraph",
        trace_name: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Optional[str] = None,
    ):
        self.tracer = tracer or create_probe_tracer(service_name)
        self._trace_name = trace_name
        self._user_id = user_id
        self._session_id = session_id
        self._active: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # 节点监听
    # ------------------------------------------------------------------

    def _on_node_start(self, node_name: str, state: Any) -> None:
        if self.tracer is None:
            return
        kind = KIND_AGENT if "agent" in node_name.lower() else KIND_STEP
        span = self.tracer.start_span(
            node_name,
            attributes={
                SPAN_KIND: kind,
                INPUT: _jsonable(state),
            },
        )
        self._active[node_name] = span

    def _on_node_end(self, node_name: str, state: Any) -> None:
        span = self._active.pop(node_name, None)
        if span is None:
            return
        if state is not None:
            span.set_attribute(OUTPUT, _jsonable(state))
        span.end()

    def _on_node_error(self, node_name: str, error: Any) -> None:
        span = self._active.pop(node_name, None)
        if span is None:
            return
        if StatusCode is not None:
            span.set_status(StatusCode.ERROR)
        span.set_attribute(LEVEL, "ERROR")
        span.end()

    # ------------------------------------------------------------------
    # 对外 API
    # ------------------------------------------------------------------

    def wrap(self, graph: Any) -> Any:
        """注册 on_node_start/on_node_end 监听；API 缺失时容错返回原图。"""
        try:
            graph.on_node_start(self._on_node_start)
            graph.on_node_end(self._on_node_end)
        except Exception as exc:  # pragma: no cover - 版本差异容错
            logger.warning("Machora langgraph probe: 节点监听注册失败: %s", exc)
        return graph

    def invoke(self, graph: Any, inputs: Any, **kwargs: Any) -> Any:
        """以 ENTRY 根 span 包裹一次 graph.invoke；探针不可用时原样执行。"""
        if self.tracer is None:
            return graph.invoke(inputs, **kwargs)
        attrs: dict[str, Any] = {
            SPAN_KIND: KIND_ENTRY,
            TRACE_NAME: self._trace_name or "langgraph",
            INPUT: _jsonable(inputs),
        }
        if self._user_id:
            attrs[USER_ID] = self._user_id
        if self._session_id:
            attrs[SESSION_ID] = self._session_id
        with self.tracer.start_as_current_span("graph", attributes=attrs) as root:
            try:
                result = graph.invoke(inputs, **kwargs)
            except Exception as exc:
                root.set_status(StatusCode.ERROR)
                root.set_attribute(LEVEL, "ERROR")
                raise
            root.set_attribute(OUTPUT, _jsonable(result))
            return result


def _jsonable(value: Any) -> Any:
    import json as _json

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    try:
        _json.dumps(value)
        return value
    except Exception:
        return str(value)

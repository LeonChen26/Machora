"""LangChain OTel 探针：把 chain/LLM/tool/retriever run 映射为 machora.* span。

用法：

    from langchain_core.callbacks import CallbackManager
    from machora.otel import MachoraOtelCallbackHandler

    handler = MachoraOtelCallbackHandler()   # 凭据走 MACHORA_OTEL_* 环境变量
    CallbackManager.configure(handlers=[handler])

span 树（与 machora.span.kind 对齐）：
    根 chain run  -> ENTRY（trace 根，携带 machora.trace.name）
    子 chain run  -> CHAIN；agent 链 -> AGENT
    LLM / chat    -> LLM（machora.model.name + machora.token.*）
    Tool run      -> TOOL
    Retriever run -> RETRIEVER
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .base import create_probe_tracer
from .constants import (
    AGENT_NAME,
    INPUT,
    KIND_AGENT,
    KIND_CHAIN,
    KIND_ENTRY,
    KIND_LLM,
    KIND_RETRIEVER,
    KIND_TOOL,
    LEVEL,
    MODEL_NAME,
    OUTPUT,
    SESSION_ID,
    SPAN_KIND,
    TOKEN_INPUT,
    TOKEN_OUTPUT,
    TOKEN_TOTAL,
    TOOL_NAME,
    TRACE_NAME,
    USER_ID,
)

logger = logging.getLogger(__name__)

try:
    from langchain_core.callbacks import BaseCallbackHandler
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "使用 MachoraOtelCallbackHandler 需要安装 langchain-core："
        "pip install 'machora-sdk[langchain]'"
    ) from exc

try:
    from opentelemetry import trace
    from opentelemetry.trace import StatusCode
    from opentelemetry.trace.propagation import set_span_in_context
except ImportError:  # pragma: no cover - fail-open
    trace = None
    StatusCode = None
    set_span_in_context = None

# agent 链名启发式（serialized["name"]）→ AGENT 角色
_AGENT_NAMES = {"AgentExecutor", "create_agent", "LangGraph", "agent"}


class MachoraOtelCallbackHandler(BaseCallbackHandler):
    """把 LangChain run 流式映射为 machora.* OTel span。"""

    def __init__(
        self,
        *,
        tracer: Any = None,
        service_name: str = "langchain",
        trace_name: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Optional[str] = None,
        agent_name: Optional[str] = None,
    ):
        super().__init__()
        self.tracer = tracer or create_probe_tracer(service_name)
        self._trace_name = trace_name
        self._user_id = user_id
        self._session_id = session_id
        self._agent_name = agent_name
        self._open: dict[str, Any] = {}

    @property
    def always_verbose(self) -> bool:
        return True

    # ------------------------------------------------------------------
    # 工具
    # ------------------------------------------------------------------

    def _serialized_name(self, serialized: Optional[dict[str, Any]]) -> Optional[str]:
        if not serialized:
            return None
        name = serialized.get("name") or (serialized.get("kwargs") or {}).get("name")
        return name if isinstance(name, str) and name else None

    def _start_span(self, run_id: Any, name: str, kind: str, parent_run_id: Any = None,
                    attrs: Optional[dict[str, Any]] = None) -> Any:
        """启动 span 并挂到父 span 上下文（若父存在）。"""
        if self.tracer is None:
            return None
        parent = self._open.get(str(parent_run_id)) if parent_run_id is not None else None
        ctx = set_span_in_context(parent) if parent is not None else None
        span = self.tracer.start_span(name, context=ctx, attributes=attrs or {})
        span.set_attribute(SPAN_KIND, kind)
        self._open[str(run_id)] = span
        return span

    def _end_span(self, run_id: Any, *, output: Any = None, error: Any = None) -> None:
        span = self._open.pop(str(run_id), None)
        if span is None:
            return
        if output is not None:
            span.set_attribute(OUTPUT, _jsonable(output))
        if error is not None:
            if StatusCode is not None:
                span.set_status(StatusCode.ERROR)
            span.set_attribute(LEVEL, "ERROR")
        span.end()

    # ------------------------------------------------------------------
    # Chain（根 → ENTRY，子链 → CHAIN/AGENT）
    # ------------------------------------------------------------------

    def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: Any,
        parent_run_id: Optional[Any] = None,
        **kwargs: Any,
    ) -> None:
        if self.tracer is None:
            return
        name = self._serialized_name(serialized) or "chain"
        is_root = parent_run_id is None or str(parent_run_id) not in self._open
        if is_root:
            kind = KIND_ENTRY
            attrs: dict[str, Any] = {
                TRACE_NAME: self._trace_name or name,
                INPUT: _jsonable(inputs),
            }
            if self._user_id:
                attrs[USER_ID] = self._user_id
            if self._session_id:
                attrs[SESSION_ID] = self._session_id
            if self._agent_name:
                attrs[AGENT_NAME] = self._agent_name
        else:
            kind = KIND_AGENT if name in _AGENT_NAMES or "agent" in name.lower() else KIND_CHAIN
            attrs = {INPUT: _jsonable(inputs)}
        self._start_span(run_id, name, kind, parent_run_id, attrs)

    def on_chain_end(
        self,
        outputs: dict[str, Any],
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        self._end_span(run_id, output=outputs)

    def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        self._end_span(run_id, error=error)

    # ------------------------------------------------------------------
    # LLM / ChatModel（→ LLM）
    # ------------------------------------------------------------------

    def _on_llm_start(self, run_id: Any, name: str, parent_run_id: Optional[Any],
                      inputs: Any, model: Optional[str] = None) -> None:
        if self.tracer is None:
            return
        attrs: dict[str, Any] = {INPUT: _jsonable(inputs)}
        if model:
            attrs[MODEL_NAME] = model
        self._start_span(run_id, name, KIND_LLM, parent_run_id, attrs)

    def on_llm_start(
        self,
        serialized: dict[str, Any],
        prompts: list[str],
        *,
        run_id: Any,
        parent_run_id: Optional[Any] = None,
        **kwargs: Any,
    ) -> None:
        self._on_llm_start(
            run_id,
            self._serialized_name(serialized) or "llm",
            parent_run_id,
            prompts if len(prompts) != 1 else prompts[0],
        )

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[Any]],
        *,
        run_id: Any,
        parent_run_id: Optional[Any] = None,
        **kwargs: Any,
    ) -> None:
        model = (
            (serialized.get("kwargs") or {}).get("model_name")
            or (serialized.get("kwargs") or {}).get("model")
        )
        msgs = []
        for batch in messages:
            for m in batch:
                msgs.append(m.dict() if hasattr(m, "dict") else str(m))
        self._on_llm_start(
            run_id,
            self._serialized_name(serialized) or "chat",
            parent_run_id,
            msgs,
            model=model,
        )

    def on_llm_end(
        self,
        response: Any,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        span = self._open.get(str(run_id))
        if span is not None:
            usage = getattr(response, "llm_output", None) or {}
            tokens = (usage or {}).get("token_usage") or (usage or {}).get("usage") or {}
            if isinstance(tokens, dict):
                if tokens.get("prompt_tokens") is not None:
                    span.set_attribute(TOKEN_INPUT, int(tokens["prompt_tokens"]))
                if tokens.get("completion_tokens") is not None:
                    span.set_attribute(TOKEN_OUTPUT, int(tokens["completion_tokens"]))
                if tokens.get("total_tokens") is not None:
                    span.set_attribute(TOKEN_TOTAL, int(tokens["total_tokens"]))
        output = None
        try:
            generations = response.generations
            if generations and generations[0]:
                msg = generations[0][0]
                output = getattr(msg, "text", None) or getattr(msg, "message", None)
        except Exception as exc:  # pragma: no cover - 宽松解析
            logger.warning("Machora otel callback: 解析 LLM 输出失败: %s", exc)
            output = None
        self._end_span(run_id, output=output)

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        self._end_span(run_id, error=error)

    # ------------------------------------------------------------------
    # Tool（→ TOOL）
    # ------------------------------------------------------------------

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: Any,
        parent_run_id: Optional[Any] = None,
        **kwargs: Any,
    ) -> None:
        if self.tracer is None:
            return
        name = self._serialized_name(serialized) or "tool"
        attrs: dict[str, Any] = {
            TOOL_NAME: name,
            INPUT: _jsonable(input_str),
        }
        self._start_span(run_id, name, KIND_TOOL, parent_run_id, attrs)

    def on_tool_end(
        self,
        output: Any,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        self._end_span(run_id, output=output)

    def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        self._end_span(run_id, error=error)

    # ------------------------------------------------------------------
    # Retriever（→ RETRIEVER，langchain-core 1.x）
    # ------------------------------------------------------------------

    def on_retriever_start(
        self,
        serialized: dict[str, Any],
        query: str,
        *,
        run_id: Any,
        parent_run_id: Optional[Any] = None,
        **kwargs: Any,
    ) -> None:
        if self.tracer is None:
            return
        name = self._serialized_name(serialized) or "retriever"
        self._start_span(
            run_id,
            name,
            KIND_RETRIEVER,
            parent_run_id,
            {INPUT: _jsonable(query)},
        )

    def on_retriever_end(
        self,
        documents: Any,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        self._end_span(run_id, output=documents)

    def on_retriever_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        self._end_span(run_id, error=error)

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def flush(self) -> None:
        """结束所有未关闭 span（异常路径兜底）。"""
        for run_id in list(self._open):
            self._end_span(run_id)


def _jsonable(value: Any) -> Any:
    """把不可 JSON 序列化的对象转为字符串（保留可序列化结构）。"""
    import json as _json

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    try:
        _json.dumps(value)
        return value
    except Exception:
        return str(value)

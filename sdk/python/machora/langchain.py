"""LangChain 自动埋点回调处理器。

一条链运行（顶层 chain run）对应一条 Machora trace；其内的 LLM 调用记为
LLM、工具/子链调用记为 SPAN。事件在 run 结束时入队，顶层链结束时
flush —— 保证 trace 先于 observation 落库。

用法：

    from langchain_core.callbacks import CallbackManager
    from machora.langchain import MachoraCallbackHandler

    handler = MachoraCallbackHandler()   # 凭据走 MACHORA_* 环境变量
    CallbackManager.configure(handlers=[handler])
"""

from __future__ import annotations

from typing import Any, Optional

try:
    from langchain_core.callbacks import BaseCallbackHandler
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "使用 MachoraCallbackHandler 需要安装 langchain-core：pip install machora-sdk[langchain]"
    ) from exc

from ._client import MachoraClient, Span


def _serialized_name(serialized: dict[str, Any]) -> Optional[str]:
    name = serialized.get("name") or (serialized.get("kwargs") or {}).get("name")
    return name if isinstance(name, str) and name else None


def _llm_usage(response: Any) -> dict[str, Any]:
    """从 LLM run 响应中宽松提取 token 计数（兼容 langchain 各版本格式）。"""
    llm_output = getattr(response, "llm_output", None) or {}
    tu = llm_output.get("token_usage") or llm_output.get("usage") or {}
    usage: dict[str, Any] = {}
    if isinstance(tu, dict):
        for k in ("prompt_tokens", "completion_tokens", "total_tokens"):
            v = tu.get(k)
            if isinstance(v, (int, float)):
                usage[k] = int(v)
    return usage


class MachoraCallbackHandler(BaseCallbackHandler):
    """把 LangChain run 流式映射为 Machora trace / observation。"""

    def __init__(
        self,
        client: Optional[MachoraClient] = None,
        *,
        trace_name: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Optional[str] = None,
        **client_kwargs: Any,
    ):
        super().__init__()
        self.client = client or MachoraClient(**client_kwargs)
        self._trace_name = trace_name
        self._user_id = user_id
        self._session_id = session_id
        self._trace_id: Optional[str] = None
        self._root_run_id: Optional[str] = None
        self._open: dict[str, Span] = {}

    # -- 顶层链 = trace ----------------------------------------------------

    def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: Any,
        parent_run_id: Optional[Any] = None,
        **kwargs: Any,
    ) -> None:
        if self._root_run_id is None or parent_run_id is None:
            if self._trace_id is not None:
                # 并发/嵌套根链：先落库已收集的，避免串台
                self.client.flush()
            self._root_run_id = str(run_id)
            self._trace_id = self.client.create_trace(
                name=self._trace_name or _serialized_name(serialized) or "chain",
                user_id=self._user_id,
                session_id=self._session_id,
                input=inputs,
            )
            return
        # 非根链记为 SPAN
        self._open[str(run_id)] = self.client.span(
            self._trace_id,
            name=_serialized_name(serialized) or "chain",
            input=inputs,
        )

    def on_chain_end(
        self,
        outputs: dict[str, Any],
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        if str(run_id) == self._root_run_id:
            self.client.flush()
            self._root_run_id = None
            self._trace_id = None
            return
        self._end_span(str(run_id), output=outputs)

    def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        if str(run_id) == self._root_run_id:
            self.client.flush()
            self._root_run_id = None
            self._trace_id = None
            return
        self._end_span(str(run_id), output=str(error), level="ERROR")

    # -- LLM = LLM ------------------------------------------------------

    def on_llm_start(
        self,
        serialized: dict[str, Any],
        prompts: list[str],
        *,
        run_id: Any,
        parent_run_id: Optional[Any] = None,
        **kwargs: Any,
    ) -> None:
        if self._trace_id is None:
            return
        self._open[str(run_id)] = self.client.generation(
            self._trace_id,
            name=_serialized_name(serialized) or "llm",
            input=prompts if len(prompts) != 1 else prompts[0],
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
        if self._trace_id is None:
            return
        model = (
            serialized.get("kwargs", {}).get("model_name")
            or serialized.get("kwargs", {}).get("model")
        )
        self._open[str(run_id)] = self.client.generation(
            self._trace_id,
            name=_serialized_name(serialized) or "chat",
            model=model,
            input=[m.dict() if hasattr(m, "dict") else str(m) for m in messages[0]],
        )

    def on_llm_end(
        self,
        response: Any,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        gen = self._open.pop(str(run_id), None)
        if gen is None:
            return
        # response: LLMResult（generations[0][0].text / llm_output）
        output = None
        try:
            generations = response.generations
            if generations and generations[0]:
                msg = generations[0][0]
                output = getattr(msg, "text", None) or getattr(msg, "message", None)
        except Exception:
            output = None
        gen.end(
            output=output,
            end_time=kwargs.get("end_time"),
            usage=_llm_usage(response),
        )

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        gen = self._open.pop(str(run_id), None)
        if gen is not None:
            gen.end(output=str(error), level="ERROR")

    # -- Tool = SPAN ---------------------------------------------------------

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: Any,
        parent_run_id: Optional[Any] = None,
        **kwargs: Any,
    ) -> None:
        if self._trace_id is None:
            return
        self._open[str(run_id)] = self.client.span(
            self._trace_id,
            name=_serialized_name(serialized) or "tool",
            input=input_str,
        )

    def on_tool_end(self, output: Any, *, run_id: Any, **kwargs: Any) -> None:
        self._end_span(str(run_id), output=output)

    def on_tool_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> None:
        self._end_span(str(run_id), output=str(error), level="ERROR")

    def _end_span(self, run_id: str, *, output: Any = None, level: str = "DEFAULT") -> None:
        span = self._open.pop(run_id, None)
        if span is not None:
            span.end(output=output, level=level)  # type: ignore[arg-type]

"""Machora Python SDK：向 Machora 观测平台注入 trace / observation / score。

快速开始
--------

    from machora import MachoraClient

    client = MachoraClient(
        public_key="pk-...",
        secret_key="sk-...",
        host="http://localhost:3100",
    )

    # 上下文管理器：退出时自动 flush
    with client.trace(name="my-agent", user_id="u-1") as t:
        with t.span(name="tool-call", input={"q": 1}) as s:
            s.end(output={"r": 2})

        t.generation(
            name="chat",
            model="gpt-4o-mini",
            input={"role": "user", "content": "hello"},
            output={"role": "assistant", "content": "hi"},
            usage={"prompt_tokens": 10, "completion_tokens": 5},
        ).end()

        t.score(name="quality", value=0.92)

    # 手动控制：事件先缓存，flush() 批量发送（自动按 trace→observation→score 排序）
    tid = client.create_trace(name="manual")
    client.create_observation(tid, type="SPAN", name="step-1", end_time=None)
    client.flush()

    # 未传凭据时从环境变量读取（MACHORA_* / LANGFUSE_*）
    client = MachoraClient()

LangChain 自动埋点
------------------

    from machora.langchain import MachoraCallbackHandler
    from langchain_core.callbacks import CallbackManager

    handler = MachoraCallbackHandler()  # 或传入已构造的 client
    CallbackManager.configure(handlers=[handler])
"""

from ._client import MachoraClient, MachoraError, Span, Trace

__all__ = ["MachoraClient", "MachoraError", "Trace", "Span"]
__version__ = "0.1.0"

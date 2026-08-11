"""Machora Python SDK 接入示例（原生注入 + LangChain 回调）。

运行：
    python examples/demo.py

凭据从 MACHORA_* 环境变量读取，缺省用 standalone 种子凭据。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from machora import MachoraClient

PUBLIC_KEY = os.environ.get(
    "MACHORA_PUBLIC_KEY", "pk-machora-dev-000000000000000000000"
)
SECRET_KEY = os.environ.get(
    "MACHORA_SECRET_KEY", "sk-machora-dev-000000000000000000000"
)
HOST = os.environ.get("MACHORA_HOST", "http://localhost:3100")


def demo_native() -> None:
    """原生 SDK：上下文管理器自动 flush，事件按 trace→observation→score 排序。"""
    with MachoraClient(PUBLIC_KEY, SECRET_KEY, HOST) as client:
        with client.trace(name="sdk-demo-native", user_id="demo-user") as t:
            with t.span(name="search", input={"q": "machora"}) as s:
                s.end(output={"hits": 3})

            t.generation(
                name="chat",
                model="gpt-4o-mini",
                input={"content": "总结一下"},
                output={"content": "Machora 是 Agent 观测平台"},
                usage={"prompt_tokens": 12, "completion_tokens": 8},
            ).end()

            t.score(name="helpfulness", value=0.95, comment="demo")
    print("[demo] 原生注入完成")


def demo_langchain() -> None:
    """LangChain 回调：一次链调用 = 一条 trace，LLM 调用 = LLM。"""
    from langchain_core.callbacks import CallbackManager
    from langchain_core.language_models.fake_chat_models import (
        FakeMessagesListChatModel,
    )
    from langchain_core.messages import AIMessage
    from langchain_core.prompts import ChatPromptTemplate

    from machora.langchain import MachoraCallbackHandler

    handler = MachoraCallbackHandler(
        public_key=PUBLIC_KEY,
        secret_key=SECRET_KEY,
        host=HOST,
        trace_name="sdk-demo-langchain",
    )
    callbacks = CallbackManager([handler])

    model = FakeMessagesListChatModel(responses=[AIMessage(content="hi!")])
    chain = ChatPromptTemplate.from_messages([("human", "{q}")]) | model
    chain.invoke({"q": "hello"}, config={"callbacks": callbacks})
    print("[demo] LangChain 注入完成")


if __name__ == "__main__":
    demo_native()
    demo_langchain()

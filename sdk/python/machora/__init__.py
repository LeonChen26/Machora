"""Machora Python SDK：通过 OTLP 探针向 Machora 观测平台上报 trace。

本 SDK 只保留 OTel 通道：`machora.otel` 提供基于 `machora.*` 语义键的
OpenTelemetry 探针，span 经 `POST /api/public/otel/v1/traces` 上报，无需改业务代码。

LangChain 自动埋点
------------------

    from langchain_core.callbacks import CallbackManager
    from machora.otel import MachoraOtelCallbackHandler

    handler = MachoraOtelCallbackHandler()   # 地址走 MACHORA_OTEL_* 环境变量
    CallbackManager.configure(handlers=[handler])

LangGraph 图级探针
------------------

    from machora.otel import MachoraOtelGraphProbe

    probe = MachoraOtelGraphProbe()
    graph = probe.wrap(graph)                 # 注册节点监听
    result = probe.invoke(graph, {"messages": [...]})

详见 `machora.otel` 模块文档与 SDK README。
"""

__version__ = "0.1.0"

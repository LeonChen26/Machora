"""machora.otel 基础常量与惰性导入回归。

不依赖 opentelemetry / langchain，可在「仅安装 machora-sdk（无 extra）」的环境运行，
用于守住「导入 machora.otel 不应因缺可选依赖而失败」这一契约，并锁定与
packages/shared 语义键对齐的关键常量值。
"""

import pytest

import machora.otel
from machora.otel import constants as c


def test_package_import_is_lazy():
    # 顶层导入 machora.otel 不得因缺 langchain-core 而失败
    assert callable(machora.otel.create_probe_tracer)


def test_semantic_keys_match_shared_schema():
    assert c.SPAN_KIND == "machora.span.kind"
    assert c.TRACE_NAME == "machora.trace.name"
    assert c.USER_ID == "machora.user.id"
    assert c.SESSION_ID == "machora.session.id"
    assert c.AGENT_NAME == "machora.agent.name"
    assert c.WORKFLOW_NAME == "machora.workflow.name"
    assert c.SKILL_NAME == "machora.skill.name"
    assert c.MODEL_NAME == "machora.model.name"


def test_span_kind_enum_values():
    # observation.type 与 span.kind 一致，取值必须与接入层 MACHORA_SPAN_KINDS 对齐
    assert c.KIND_ENTRY == "ENTRY"
    assert c.KIND_AGENT == "AGENT"
    assert c.KIND_STEP == "STEP"
    assert c.KIND_CHAIN == "CHAIN"
    assert c.KIND_LLM == "LLM"
    assert c.KIND_TOOL == "TOOL"
    assert c.KIND_EMBEDDING == "EMBEDDING"
    assert c.KIND_RETRIEVER == "RETRIEVER"


def test_callback_handler_missing_extra_raises_helpful_error():
    """LangChain 回调处理器为惰性导出：缺 langchain-core 时给出安装指引而非包级失败。"""
    try:
        handler = machora.otel.MachoraOtelCallbackHandler
    except ImportError as exc:
        assert "machora-sdk[langchain]" in str(exc)
    except AttributeError:  # pragma: no cover
        pytest.fail("MachoraOtelCallbackHandler 未通过 __getattr__ 导出")
    else:
        # 已安装 langchain-core 时正常返回类对象
        assert handler is not None

"""otel_openinference — Hermes plugin for OpenInference OTLP observability.

Traces Hermes sessions, turns, LLM calls, tool calls, and subagents to any
OTLP/HTTP traces endpoint using the OpenInference semantic conventions
(https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md).

The exported span tree follows the OpenInference span-kind vocabulary so
backends like Machora classify spans without extra configuration:

    session (span.kind=AGENT)            <- on_session_start / on_session_end
    └── turn (span.kind=CHAIN)           <- pre_llm_call / post_llm_call
        ├── llm (span.kind=LLM)          <- pre_api_request / post_api_request / api_request_error
        └── tool (span.kind=TOOL)        <- pre_tool_call / post_tool_call
    subagent (span.kind=AGENT)           <- subagent_start / subagent_stop

Attributes follow OpenInference keys (input.value, output.value,
llm.model_name, llm.token_count.prompt/completion, tool.name, tool_call.id,
session.id, user.id, agent.name). ``openinference.span.kind`` drives backend
classification — Machora stores the kind directly as ``observation.type``.

Activation is handled by the Hermes plugin system — standalone plugins only
load when listed in ``plugins.enabled`` (via ``hermes plugins enable
observability/otel_openinference``). At runtime the plugin also requires the
OpenTelemetry SDK (``pip install 'hermes-agent[otlp]'``) and an endpoint; if
either is missing the hooks are inert (fail-open).

Env vars (set via ``hermes tools`` or ~/.hermes/.env):
  HERMES_OTEL_OPENINFERENCE_ENDPOINT - full OTLP/HTTP traces URL
      (default: http://localhost:3100/api/public/otel/v1/traces)
  HERMES_OTEL_OPENINFERENCE_HEADERS - comma-separated "K=V" headers, e.g.
      Authorization=Basic <base64(pk:sk)> for Machora
  HERMES_OTEL_OPENINFERENCE_SERVICE_NAME - resource service.name (default: hermes)
  HERMES_OTEL_OPENINFERENCE_MAX_CHARS - max chars per input/output value
      (default: 12000)
  HERMES_OTEL_OPENINFERENCE_DEBUG - set to "true" for verbose logging
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

try:
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.trace import SpanKind, set_span_in_context
except Exception:  # pragma: no cover - fail-open when optional dep is missing
    OTLPSpanExporter = None
    Resource = None
    TracerProvider = None
    BatchSpanProcessor = None
    SpanKind = None
    set_span_in_context = None

# Sentinel: "_get_provider() has tried and failed". Lets us short-circuit
# every subsequent hook call without re-checking env vars or re-attempting
# SDK init. Runtime callers cannot reset the cache; if an operator fixes a
# misconfiguration they must restart the process.
_INIT_FAILED = object()

_LOCK = threading.RLock()
_PROVIDER: Any = _INIT_FAILED
_SESSIONS: dict[str, "_SessionState"] = {}
_MAX_SESSIONS = 256

_DEFAULT_ENDPOINT = "http://localhost:3100/api/public/otel/v1/traces"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_bool(*names: str) -> bool:
    for name in names:
        value = _env(name).lower()
        if value:
            return value in {"1", "true", "yes", "on"}
    return False


def _debug_enabled() -> bool:
    return _env_bool("HERMES_OTEL_OPENINFERENCE_DEBUG")


def _debug(message: str) -> None:
    if _debug_enabled():
        logger.info("OpenInference OTLP: %s", message)


def _max_chars() -> int:
    raw = _env("HERMES_OTEL_OPENINFERENCE_MAX_CHARS", "12000")
    try:
        return max(0, int(raw))
    except ValueError:
        return 12000


def _parse_headers(raw: str) -> Optional[dict[str, str]]:
    headers: dict[str, str] = {}
    for part in raw.split(","):
        if "=" not in part:
            continue
        key, _, value = part.partition("=")
        key = key.strip()
        value = value.strip()
        if key:
            headers[key] = value
    return headers or None


def _get_provider():
    """Return a cached TracerProvider, or None if unavailable."""
    global _PROVIDER
    if _PROVIDER is not _INIT_FAILED:
        return _PROVIDER
    if OTLPSpanExporter is None or TracerProvider is None:
        _PROVIDER = _INIT_FAILED
        return None

    endpoint = _env("HERMES_OTEL_OPENINFERENCE_ENDPOINT") or _DEFAULT_ENDPOINT
    headers = _parse_headers(_env("HERMES_OTEL_OPENINFERENCE_HEADERS"))
    service_name = _env("HERMES_OTEL_OPENINFERENCE_SERVICE_NAME", "hermes")

    try:
        resource = Resource.create({"service.name": service_name})
        provider = TracerProvider(resource=resource)
        processor = BatchSpanProcessor(
            OTLPSpanExporter(endpoint=endpoint, headers=headers or None)
        )
        provider.add_span_processor(processor)
        _PROVIDER = provider
    except Exception as exc:  # pragma: no cover - fail-open
        logger.warning(
            "OpenInference OTLP plugin: provider init failed, tracing disabled: %s",
            exc,
        )
        _PROVIDER = _INIT_FAILED
        return None
    _debug(f"provider ready, endpoint={endpoint} headers={headers}")
    return _PROVIDER


def _flush() -> None:
    provider = _get_provider()
    if provider is None:
        return
    try:
        provider.force_flush()
    except Exception as exc:  # pragma: no cover - fail-open
        _debug(f"force_flush failed: {exc}")


# ---------------------------------------------------------------------------
# Payload helpers
# ---------------------------------------------------------------------------

def _truncate(value: str) -> str:
    limit = _max_chars()
    if limit and len(value) > limit:
        return value[:limit] + f"…[{len(value)} chars]"
    return value


def _json_value(value: Any) -> str:
    """Serialize a sanitized JSON-compatible payload into an input/output.value string."""
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            text = str(value)
    return _truncate(text)


def _usage_tokens(usage: Any) -> tuple[Optional[int], Optional[int]]:
    """Extract (input, output) token counts from a CanonicalUsage summary dict."""
    if not isinstance(usage, dict):
        return None, None
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens") or usage.get("completion_tokens")
    if not isinstance(input_tokens, int):
        try:
            input_tokens = int(input_tokens) if input_tokens is not None else None
        except (TypeError, ValueError):
            input_tokens = None
    if not isinstance(output_tokens, int):
        try:
            output_tokens = int(output_tokens) if output_tokens is not None else None
        except (TypeError, ValueError):
            output_tokens = None
    return input_tokens, output_tokens


def _as_dict(value: Any) -> Optional[dict]:
    """Best-effort conversion of a hook payload to a plain dict.

    Hermes hook payloads may be plain dicts, pydantic models, or other
    ``__dict__``-shaped objects.  Returns None when conversion is impossible.
    """
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    try:
        dump = getattr(value, "model_dump", None)
        if callable(dump):
            return dump()
        asdict = getattr(value, "dict", None)
        if callable(asdict):
            return asdict()
        if hasattr(value, "__dict__"):
            return dict(value.__dict__)
    except Exception:
        pass
    return None


def _chat_messages_from_request(request: Any) -> Optional[list]:
    """Extract the chat message list from a Hermes ``pre_api_request`` request.

    Hermes wraps the provider body as ``{"method": "POST", "body": {...}}``
    where the OpenAI-compatible ``messages`` array lives at
    ``body["messages"]`` (see ``_api_request_payload_for_hook``).  Storing the
    whole envelope in ``input.value`` makes the frontend fall back to raw JSON;
    storing just the messages array lets it render per-role.
    """
    d = _as_dict(request)
    if d is None:
        return None
    body = d.get("body")
    if isinstance(body, dict) and isinstance(body.get("messages"), list):
        msgs = body["messages"]
        if msgs:
            return msgs
    # fallback: top-level messages
    if isinstance(d.get("messages"), list):
        msgs = d["messages"]
        if msgs:
            return msgs
    return None


def _chat_messages_from_response(response: Any) -> Optional[list]:
    """Extract the assistant message list from a Hermes ``post_api_request``.

    Hermes wraps the provider response as ``{"model", "finish_reason",
    "assistant_message": {"role", "content", "tool_calls"}, "usage"}``.  Storing
    just the assistant message(s) lets the frontend render by role instead of
    showing the whole JSON envelope.
    """
    d = _as_dict(response)
    if d is None:
        return None
    am = d.get("assistant_message")
    if isinstance(am, dict):
        return [am]
    # OpenAI-compatible shape: {"choices": [{"message": {...}}]}
    choices = d.get("choices")
    if isinstance(choices, list):
        out: list[dict] = []
        for c in choices:
            cd = _as_dict(c)
            if cd is not None and isinstance(cd.get("message"), dict):
                out.append(cd["message"])
        if out:
            return out
    return None


# ---------------------------------------------------------------------------
# In-memory span tree state (per session)
# ---------------------------------------------------------------------------

class _SessionState:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.root_span: Any = None
        self.turn_span: Any = None
        # request key (api_request_id or api_call_count) -> (span, started_at)
        self.llms: dict[str, tuple[Any, float]] = {}
        # tool_call_id -> (span, started_at)
        self.tools: dict[str, tuple[Any, float]] = {}
        # tool name -> queue of (span, started_at) for calls without an id
        self.pending_tools_by_name: dict[str, list[tuple[Any, float]]] = {}
        # subagent key -> (span, started_at)
        self.subagents: dict[str, tuple[Any, float]] = {}
        self.last_updated_at: float = time.time()


def _start_span(provider, name: str, kind: str, parent_span: Any = None,
                attributes: Optional[dict[str, Any]] = None):
    tracer = provider.get_tracer("hermes.otel_openinference")
    kwargs: dict[str, Any] = {"name": name}
    if parent_span is not None:
        kwargs["context"] = set_span_in_context(parent_span)
    span = tracer.start_span(
        **kwargs,
        kind=SpanKind.INTERNAL,
        attributes=attributes or {},
    )
    span.set_attribute("openinference.span.kind", kind)
    return span


def _end_span(span: Any) -> None:
    if span is None:
        return
    try:
        span.end()
    except Exception:  # pragma: no cover - fail-open
        pass


# OTel StatusCode.ERROR (SDK 常量；避免在模块顶层 import opentelemetry.trace.StatusCode
# 以便 SDK 缺失时模块仍可导入)。set_status 传 StatusCode 数值即可。
_STATUS_ERROR = 2


def _end_session_state(state: "_SessionState") -> None:
    """Close every open span under a session, then the root."""
    for _span, _ in list(state.llms.values()):
        _end_span(_span)
    state.llms.clear()
    for _span, _ in list(state.tools.values()):
        _end_span(_span)
    state.tools.clear()
    for queue in list(state.pending_tools_by_name.values()):
        for _span, _ in queue:
            _end_span(_span)
    state.pending_tools_by_name.clear()
    for _span, _ in list(state.subagents.values()):
        _end_span(_span)
    state.subagents.clear()
    _end_span(state.turn_span)
    state.turn_span = None
    _end_span(state.root_span)
    state.root_span = None


def _evict_stale_locked() -> None:
    """Bound in-memory session state (evict oldest when over cap)."""
    if len(_SESSIONS) <= _MAX_SESSIONS:
        return
    ordered = sorted(_SESSIONS.items(), key=lambda kv: kv[1].last_updated_at)
    for session_id, state in ordered[: len(_SESSIONS) - _MAX_SESSIONS]:
        _end_session_state(state)
        _SESSIONS.pop(session_id, None)
        _debug(f"evicted stale session {session_id}")


def _get_state(session_id: str) -> Optional[_SessionState]:
    if not session_id:
        return None
    with _LOCK:
        return _SESSIONS.get(session_id)


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------

def on_session_start(*, session_id: str = "", user_id: str = "",
                     agent_name: str = "", **_: Any) -> None:
    if not session_id:
        return
    provider = _get_provider()
    if provider is None:
        return
    with _LOCK:
        if session_id in _SESSIONS:
            return
        state = _SessionState(session_id)
        attributes: dict[str, Any] = {"session.id": session_id}
        if user_id:
            attributes["user.id"] = user_id
        if agent_name:
            attributes["agent.name"] = agent_name
        state.root_span = _start_span(
            provider,
            "Hermes Agent",
            "AGENT",
            attributes=attributes,
        )
        _SESSIONS[session_id] = state
        _evict_stale_locked()
        _debug(f"session start {session_id}")


def on_session_end(*, session_id: str = "", **_: Any) -> None:
    if not session_id:
        return
    with _LOCK:
        state = _SESSIONS.pop(session_id, None)
    if state is None:
        return
    _end_session_state(state)
    _flush()
    _debug(f"session end {session_id}")


# ---------------------------------------------------------------------------
# Turn-scoped hooks
# ---------------------------------------------------------------------------

def pre_llm_call(*, session_id: str = "", turn_id: str = "", model: str = "",
                 provider: str = "", platform: str = "", user_message: Any = None,
                 **_: Any) -> None:
    provider_obj = _get_provider()
    if provider_obj is None:
        return
    state = _get_state(session_id)
    if state is None or state.root_span is None:
        return
    attributes: dict[str, Any] = {}
    if turn_id:
        attributes["hermes.turn_id"] = turn_id
    if model:
        attributes["llm.model_name"] = model
    with _LOCK:
        _end_span(state.turn_span)
        state.turn_span = _start_span(
            provider_obj,
            f"turn {turn_id}" if turn_id else "turn",
            "CHAIN",
            parent_span=state.root_span,
            attributes=attributes,
        )
        state.last_updated_at = time.time()


def post_llm_call(*, session_id: str = "", turn_id: str = "", **_: Any) -> None:
    state = _get_state(session_id)
    if state is None:
        return
    with _LOCK:
        _end_span(state.turn_span)
        state.turn_span = None
        state.last_updated_at = time.time()


# ---------------------------------------------------------------------------
# Request-scoped LLM hooks
# ---------------------------------------------------------------------------

def pre_api_request(*, task_id: str = "", session_id: str = "", model: str = "",
                    provider: str = "", base_url: str = "", api_mode: str = "",
                    api_call_count: int = 0, request: Any = None,
                    turn_id: str = "", api_request_id: str = "", **_: Any) -> None:
    provider_obj = _get_provider()
    if provider_obj is None:
        return
    state = _get_state(session_id)
    if state is None or state.root_span is None:
        return
    attributes: dict[str, Any] = {}
    if model:
        attributes["llm.model_name"] = model
    if provider:
        attributes["llm.provider"] = provider
    # OpenInference input.value：优先存消息数组（前端按 role 渲染），
    # 提取失败时回退存完整 request 信封。
    req_msgs = _chat_messages_from_request(request)
    req_value = _json_value(req_msgs if req_msgs is not None else request)
    if req_value:
        attributes["input.value"] = req_value
        attributes["input.mime_type"] = "application/json"
    req_key = api_request_id or f"c{api_call_count}"
    with _LOCK:
        previous = state.llms.pop(req_key, None)
        if previous is not None:
            _end_span(previous[0])
        parent = state.turn_span if state.turn_span is not None else state.root_span
        span = _start_span(
            provider_obj,
            f"LLM {api_call_count}" if api_call_count else "LLM",
            "LLM",
            parent_span=parent,
            attributes=attributes,
        )
        state.llms[req_key] = (span, time.time())
        state.last_updated_at = time.time()


def post_api_request(*, session_id: str = "", model: str = "", response: Any = None,
                     usage: Any = None, api_duration: float = 0.0,
                     api_call_count: int = 0, api_request_id: str = "",
                     finish_reason: str = "", **_: Any) -> None:
    state = _get_state(session_id)
    if state is None:
        return
    req_key = api_request_id or f"c{api_call_count}"
    with _LOCK:
        entry = state.llms.pop(req_key, None)
    if entry is None:
        return
    span, _started = entry
    if model:
        span.set_attribute("llm.model_name", model)
    # OpenInference output.value：优先存 assistant 消息数组（前端按 role 渲染），
    # 提取失败时回退存完整 response 信封。
    out_msgs = _chat_messages_from_response(response)
    out_value = _json_value(out_msgs if out_msgs is not None else response)
    if out_value:
        span.set_attribute("output.value", out_value)
        span.set_attribute("output.mime_type", "application/json")
    if finish_reason:
        span.set_attribute("llm.finish_reason", finish_reason)
    input_tokens, output_tokens = _usage_tokens(usage)
    if input_tokens is not None:
        span.set_attribute("llm.token_count.prompt", input_tokens)
    if output_tokens is not None:
        span.set_attribute("llm.token_count.completion", output_tokens)
    if api_duration and api_duration > 0:
        span.set_attribute("llm.duration_s", round(api_duration, 3))
    _end_span(span)
    state.last_updated_at = time.time()


def api_request_error(*, session_id: str = "", api_call_count: int = 0,
                      api_request_id: str = "", reason: str = "",
                      error: Any = None, status_code: Any = None, **_: Any) -> None:
    state = _get_state(session_id)
    if state is None:
        return
    req_key = api_request_id or f"c{api_call_count}"
    with _LOCK:
        entry = state.llms.pop(req_key, None)
    if entry is None:
        return
    span, _started = entry
    span.set_status(_STATUS_ERROR)
    if reason:
        span.set_attribute("llm.error.reason", reason)
    if error:
        if isinstance(error, dict):
            for k, v in error.items():
                if k in ("type", "message") and isinstance(v, (str, int, float, bool)):
                    span.set_attribute(f"llm.error.{k}", v)
        else:
            span.set_attribute("llm.error.message", _truncate(str(error)))
    if status_code is not None:
        try:
            span.set_attribute("llm.error.status_code", int(status_code))
        except (TypeError, ValueError):
            pass
    _end_span(span)
    state.last_updated_at = time.time()


# ---------------------------------------------------------------------------
# Tool hooks
# ---------------------------------------------------------------------------

def pre_tool_call(*, tool_name: str = "", args: Any = None, session_id: str = "",
                  tool_call_id: str = "", turn_id: str = "", **_: Any) -> None:
    provider_obj = _get_provider()
    if provider_obj is None:
        return
    state = _get_state(session_id)
    if state is None or state.root_span is None:
        return
    attributes: dict[str, Any] = {}
    if tool_name:
        attributes["tool.name"] = tool_name
    if tool_call_id:
        attributes["tool_call.id"] = tool_call_id
    args_value = _json_value(args)
    if args_value:
        attributes["input.value"] = args_value
        attributes["input.mime_type"] = "application/json"
    with _LOCK:
        parent = state.turn_span if state.turn_span is not None else state.root_span
        span = _start_span(
            provider_obj,
            f"Tool: {tool_name}" if tool_name else "Tool",
            "TOOL",
            parent_span=parent,
            attributes=attributes,
        )
        if tool_call_id:
            state.tools[tool_call_id] = (span, time.time())
        else:
            state.pending_tools_by_name.setdefault(tool_name or "", []).append(
                (span, time.time())
            )
        state.last_updated_at = time.time()


def post_tool_call(*, tool_name: str = "", result: Any = None, session_id: str = "",
                   tool_call_id: str = "", status: str = "", duration_ms: Any = None,
                   **_: Any) -> None:
    state = _get_state(session_id)
    if state is None:
        return
    span = None
    with _LOCK:
        if tool_call_id:
            entry = state.tools.pop(tool_call_id, None)
        else:
            entry = None
        if entry is None:
            queue = state.pending_tools_by_name.get(tool_name or "")
            if queue:
                entry = queue.pop(0)
                if not queue:
                    state.pending_tools_by_name.pop(tool_name or "", None)
        if entry is not None:
            span = entry[0]
    if span is None:
        return
    if result is not None:
        out_value = _json_value(result)
        if out_value:
            span.set_attribute("output.value", out_value)
            span.set_attribute("output.mime_type", "application/json")
    if status:
        span.set_attribute("tool.status", status)
        if status in ("error", "blocked", "cancelled"):
            span.set_status(_STATUS_ERROR)
    if duration_ms is not None:
        try:
            span.set_attribute("tool.duration_ms", int(duration_ms))
        except (TypeError, ValueError):
            pass
    _end_span(span)
    state.last_updated_at = time.time()


# ---------------------------------------------------------------------------
# Subagent hooks
# ---------------------------------------------------------------------------

def subagent_start(*, parent_session_id: str = "", child_session_id: str = "",
                   child_role: str = "", child_goal: str = "", **_: Any) -> None:
    provider_obj = _get_provider()
    if provider_obj is None:
        return
    state = _get_state(parent_session_id)
    if state is None or state.root_span is None:
        return
    attributes: dict[str, Any] = {}
    if child_session_id:
        attributes["session.id"] = child_session_id
    if child_role:
        attributes["agent.name"] = child_role
    if child_goal:
        attributes["agent.goal"] = _truncate(child_goal)
    with _LOCK:
        span = _start_span(
            provider_obj,
            f"subagent {child_role}" if child_role else "subagent",
            "AGENT",
            parent_span=state.root_span,
            attributes=attributes,
        )
        state.subagents[child_session_id] = (span, time.time())
        state.last_updated_at = time.time()


def subagent_stop(*, parent_session_id: str = "", child_session_id: str = "",
                  child_summary: Any = None, duration_ms: Any = None,
                  status: str = "", **_: Any) -> None:
    state = _get_state(parent_session_id)
    if state is None:
        return
    span = None
    with _LOCK:
        entry = state.subagents.pop(child_session_id, None)
        if entry is not None:
            span = entry[0]
    if span is None:
        return
    if child_summary is not None:
        out_value = _json_value(child_summary)
        if out_value:
            span.set_attribute("output.value", out_value)
            span.set_attribute("output.mime_type", "application/json")
    if status:
        span.set_attribute("agent.status", status)
    if duration_ms is not None:
        try:
            span.set_attribute("agent.duration_ms", int(duration_ms))
        except (TypeError, ValueError):
            pass
    _end_span(span)
    state.last_updated_at = time.time()


# ---------------------------------------------------------------------------
# Plugin registration
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    if _env_bool("HERMES_OTEL_OPENINFERENCE_DISABLED"):
        return
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("on_session_end", on_session_end)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_hook("pre_api_request", pre_api_request)
    ctx.register_hook("post_api_request", post_api_request)
    ctx.register_hook("api_request_error", api_request_error)
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("post_tool_call", post_tool_call)
    ctx.register_hook("subagent_start", subagent_start)
    ctx.register_hook("subagent_stop", subagent_stop)

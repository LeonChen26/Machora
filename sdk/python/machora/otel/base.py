"""Machora OTel 探针基座：fail-open 的 TracerProvider + OTLP/HTTP exporter。

OTel SDK 未安装或初始化失败时返回 None（惰性），不影响应用主流程。
端点/凭据走环境变量：

    MACHORA_OTEL_ENDPOINT        OTLP/HTTP traces URL（默认 http://localhost:3100/api/public/otel/v1/traces）
    MACHORA_OTEL_HEADERS         HTTP 头（JSON 对象字符串，如 {"Authorization": "Basic ..."}）
    MACHORA_OTEL_SERVICE_NAME    resource service.name
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

_DEFAULT_ENDPOINT = "http://localhost:3100/api/public/otel/v1/traces"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _parse_headers(raw: str) -> Optional[dict[str, str]]:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Machora otel probe: MACHORA_OTEL_HEADERS 不是合法 JSON，忽略")
        return None
    if not isinstance(parsed, dict):
        return None
    headers = {str(k): str(v) for k, v in parsed.items()}
    return headers or None


def create_probe_tracer(service_name: str = "machora-probe") -> Any:
    """返回一个 Tracer；OTel SDK 不可用或初始化失败时返回 None。"""
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except Exception:
        logger.warning(
            "Machora otel probe: opentelemetry SDK 未安装，探针禁用"
            "（pip install 'machora-sdk[otel]'）"
        )
        return None

    endpoint = _env("MACHORA_OTEL_ENDPOINT") or _DEFAULT_ENDPOINT
    headers = _parse_headers(_env("MACHORA_OTEL_HEADERS"))
    try:
        resource = Resource.create(
            {"service.name": _env("MACHORA_OTEL_SERVICE_NAME", service_name)}
        )
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint, headers=headers))
        )
        return provider.get_tracer("machora.sdk.otel")
    except Exception as exc:  # pragma: no cover - fail-open
        logger.warning("Machora otel probe: provider 初始化失败，探针禁用: %s", exc)
        return None

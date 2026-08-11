"""Machora 上报客户端。

事件先缓存在内存，flush() 时按依赖重排（trace-create → observation-create →
score-create）后批量 POST /api/public/ingestion。
"""

from __future__ import annotations

import base64
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from ._models import (
    IngestionEvent,
    ObservationBody,
    ScoreBody,
    TraceBody,
    event_payload,
    score_data_type,
)

DEFAULT_HOST = "http://localhost:3100"

_ORDER = {"trace-create": 0, "observation-create": 1, "score-create": 2}


def utcnow_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def new_id(prefix: str = "") -> str:
    """Langfuse 风格 id：毫秒时间戳 + 随机后缀，天然有序且唯一。"""
    uid = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:12]}"
    return f"{prefix}-{uid}" if prefix else uid


class MachoraError(RuntimeError):
    """平台返回非 2xx 或响应异常时抛出。"""


class MachoraClient:
    """Machora ingestion 客户端。

    认证：Basic Auth（publicKey:secretKey）。未显式传参时从环境变量读取
    MACHORA_PUBLIC_KEY / MACHORA_SECRET_KEY / MACHORA_HOST
    （兼容 LANGFUSE_* / LANGFUSE_HOST 变量）。
    """

    def __init__(
        self,
        public_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        host: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self.public_key = (
            public_key
            or os.environ.get("MACHORA_PUBLIC_KEY")
            or os.environ.get("LANGFUSE_PUBLIC_KEY")
            or ""
        )
        self.secret_key = (
            secret_key
            or os.environ.get("MACHORA_SECRET_KEY")
            or os.environ.get("LANGFUSE_SECRET_KEY")
            or ""
        )
        self.host = (host or os.environ.get("MACHORA_HOST") or DEFAULT_HOST).rstrip("/")
        self._timeout = timeout
        self._http = httpx.Client(timeout=timeout)
        self._lock = threading.Lock()
        self._pending: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    # 事件记录（先缓存）
    # ------------------------------------------------------------------

    def create_trace(
        self,
        name: Optional[str] = None,
        trace_id: Optional[str] = None,
        *,
        user_id: Optional[str] = None,
        session_id: Optional[str] = None,
        input: Any = None,
        output: Any = None,
        metadata: Optional[dict[str, Any]] = None,
        tags: Optional[list[str]] = None,
        environment: str = "default",
        timestamp: Optional[str] = None,
    ) -> str:
        """创建 trace-create 事件并返回 trace id。"""
        tid = trace_id or new_id()
        body = TraceBody(
            id=tid,
            name=name,
            timestamp=timestamp or utcnow_iso(),
            environment=environment,
            user_id=user_id,
            session_id=session_id,
            input=input,
            output=output,
            metadata=metadata,
            tags=tags or [],
        )
        self._push({"type": "trace-create", "body": body})
        return tid

    def create_observation(
        self,
        trace_id: str,
        *,
        type: str = "SPAN",
        name: Optional[str] = None,
        observation_id: Optional[str] = None,
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
        model: Optional[str] = None,
        input: Any = None,
        output: Any = None,
        metadata: Optional[dict[str, Any]] = None,
        level: str = "DEFAULT",
        usage: Any = None,
    ) -> str:
        """创建 observation-create 事件并返回 observation id。"""
        oid = observation_id or new_id()
        body = ObservationBody(
            id=oid,
            trace_id=trace_id,
            type=type,  # type: ignore[arg-type]
            name=name,
            start_time=start_time or utcnow_iso(),
            end_time=end_time,
            model=model,
            input=input,
            output=output,
            metadata=metadata,
            level=level,  # type: ignore[arg-type]
            usage=usage,
        )
        self._push({"type": "observation-create", "body": body})
        return oid

    def create_score(
        self,
        name: str,
        value: Any,
        *,
        trace_id: Optional[str] = None,
        observation_id: Optional[str] = None,
        score_id: Optional[str] = None,
        data_type: Optional[str] = None,
        source: str = "API",
        comment: Optional[str] = None,
    ) -> str:
        """创建 score-create 事件并返回 score id。

        data_type 缺省按值推断（bool→BOOLEAN，str→CATEGORICAL，数字→NUMERIC）。
        """
        sid = score_id or new_id()
        body = ScoreBody(
            id=sid,
            trace_id=trace_id,
            observation_id=observation_id,
            name=name,
            value=value,
            data_type=data_type or score_data_type(value),  # type: ignore[arg-type]
            source=source,  # type: ignore[arg-type]
            comment=comment,
        )
        self._push({"type": "score-create", "body": body})
        return sid

    def _push(self, event: dict[str, Any]) -> None:
        with self._lock:
            self._pending.append(event)

    # ------------------------------------------------------------------
    # 便捷 handle（上下文管理器，退出时补 end 并 flush）
    # ------------------------------------------------------------------

    def trace(
        self,
        name: Optional[str] = None,
        *,
        trace_id: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Optional[str] = None,
        input: Any = None,
        output: Any = None,
        metadata: Optional[dict[str, Any]] = None,
        tags: Optional[list[str]] = None,
        environment: str = "default",
        flush_on_exit: bool = True,
    ) -> "Trace":
        return Trace(
            self,
            trace_id=trace_id or new_id(),
            name=name,
            user_id=user_id,
            session_id=session_id,
            input=input,
            output=output,
            metadata=metadata,
            tags=tags,
            environment=environment,
            flush_on_exit=flush_on_exit,
        )

    def span(
        self,
        trace_id: str,
        name: Optional[str] = None,
        *,
        input: Any = None,
        output: Any = None,
        metadata: Optional[dict[str, Any]] = None,
        level: str = "DEFAULT",
    ) -> "Span":
        return Span(self, trace_id, name=name, input=input, output=output,
                    metadata=metadata, level=level)

    def generation(
        self,
        trace_id: str,
        name: Optional[str] = None,
        *,
        model: Optional[str] = None,
        input: Any = None,
        output: Any = None,
        metadata: Optional[dict[str, Any]] = None,
        usage: Any = None,
        level: str = "DEFAULT",
    ) -> "Span":
        """返回一个可 end() 的 handle；end 时创建 LLM observation。"""
        return Span(self, trace_id, name=name, input=input, output=output,
                    metadata=metadata, level=level, type="LLM",
                    model=model, usage=usage)

    # ------------------------------------------------------------------
    # 发送
    # ------------------------------------------------------------------

    def flush(self) -> dict[str, Any]:
        """按依赖顺序重排并发送所有缓存事件。返回平台响应。"""
        with self._lock:
            pending = self._pending
            self._pending = []
        if not pending:
            return {"success": True, "received": 0}

        # 稳定排序：trace-create 必须先于其 observation 落库（外键约束）
        pending.sort(key=lambda e: _ORDER.get(e["type"], 9))

        payload = {
            "batch": [
                {"type": e["type"], "body": event_payload(e["body"])}
                for e in pending
            ]
        }
        return self._post("/api/public/ingestion", payload)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        auth = base64.b64encode(
            f"{self.public_key}:{self.secret_key}".encode()
        ).decode()
        try:
            resp = self._http.post(
                f"{self.host}{path}",
                json=payload,
                headers={
                    "Authorization": f"Basic {auth}",
                    "Content-Type": "application/json",
                },
            )
        except httpx.HTTPError as exc:
            raise MachoraError(f"请求失败: {exc}") from exc
        if resp.status_code >= 400:
            raise MachoraError(
                f"平台返回 {resp.status_code}: {resp.text[:500]}"
            )
        return resp.json()

    def close(self) -> None:
        self.flush()
        self._http.close()

    def __enter__(self) -> "MachoraClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class Trace:
    """一条 trace 的句柄。首次使用或进入 with 时创建事件，with 退出时（可选）flush。"""

    def __init__(
        self,
        client: MachoraClient,
        *,
        trace_id: str,
        name: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Optional[str] = None,
        input: Any = None,
        output: Any = None,
        metadata: Optional[dict[str, Any]] = None,
        tags: Optional[list[str]] = None,
        environment: str = "default",
        flush_on_exit: bool = True,
    ):
        self.client = client
        self.id = trace_id
        self._name = name
        self._user_id = user_id
        self._session_id = session_id
        self._input = input
        self._output = output
        self._metadata = metadata
        self._tags = tags
        self._environment = environment
        self._flush_on_exit = flush_on_exit
        self._started = False

    def _ensure_started(self) -> None:
        if not self._started:
            self.client.create_trace(
                name=self._name,
                trace_id=self.id,
                user_id=self._user_id,
                session_id=self._session_id,
                input=self._input,
                output=self._output,
                metadata=self._metadata,
                tags=self._tags,
                environment=self._environment,
            )
            self._started = True

    def span(self, name: Optional[str] = None, **kwargs: Any) -> "Span":
        self._ensure_started()
        return self.client.span(self.id, name, **kwargs)

    def generation(self, name: Optional[str] = None, **kwargs: Any) -> "Span":
        self._ensure_started()
        return self.client.generation(self.id, name, **kwargs)

    def observation(
        self, type: str = "SPAN", name: Optional[str] = None, **kwargs: Any
    ) -> str:
        self._ensure_started()
        return self.client.create_observation(self.id, type=type, name=name, **kwargs)

    def score(
        self,
        name: str,
        value: Any,
        *,
        observation_id: Optional[str] = None,
        data_type: Optional[str] = None,
        source: str = "API",
        comment: Optional[str] = None,
    ) -> str:
        self._ensure_started()
        return self.client.create_score(
            name,
            value,
            trace_id=self.id,
            observation_id=observation_id,
            data_type=data_type,
            source=source,
            comment=comment,
        )

    def flush(self) -> dict[str, Any]:
        self._ensure_started()
        return self.client.flush()

    def __enter__(self) -> "Trace":
        self._ensure_started()
        return self

    def __exit__(self, *exc: Any) -> None:
        if self._flush_on_exit:
            self.client.flush()


class Span:
    """一个 observation 的句柄；end() 或 with 退出时创建完整事件（含 start/end）。"""

    def __init__(
        self,
        client: MachoraClient,
        trace_id: str,
        *,
        observation_id: Optional[str] = None,
        name: Optional[str] = None,
        input: Any = None,
        output: Any = None,
        metadata: Optional[dict[str, Any]] = None,
        level: str = "DEFAULT",
        type: str = "SPAN",
        model: Optional[str] = None,
        usage: Any = None,
    ):
        self.client = client
        self.trace_id = trace_id
        self.id = observation_id or new_id()
        self._name = name
        self._input = input
        self._output = output
        self._metadata = metadata
        self._level = level
        self._type = type
        self._model = model
        self._usage = usage
        self._start_time = utcnow_iso()
        self._ended = False

    def end(
        self,
        output: Any = None,
        *,
        end_time: Optional[str] = None,
        level: Optional[str] = None,
        usage: Any = None,
    ) -> None:
        if self._ended:
            return
        self._ended = True
        self.client.create_observation(
            self.trace_id,
            type=self._type,
            name=self._name,
            observation_id=self.id,
            start_time=self._start_time,
            end_time=end_time or utcnow_iso(),
            model=self._model,
            input=self._input,
            output=output if output is not None else self._output,
            metadata=self._metadata,
            level=level or self._level,  # type: ignore[arg-type]
            usage=usage if usage is not None else self._usage,
        )

    def __enter__(self) -> "Span":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.end()

"""Ingestion 事件数据模型。

字段与 packages/shared/src/domain/index.ts 的 zod schema 对齐。
注意：发送时需 camelCase 别名（userId/sessionId/traceId/startTime/endTime/dataType）。
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class TraceBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: Optional[str] = None
    timestamp: str
    environment: str = "default"
    user_id: Optional[str] = Field(default=None, alias="userId")
    session_id: Optional[str] = Field(default=None, alias="sessionId")
    input: Any = None
    output: Any = None
    metadata: Optional[dict[str, Any]] = None
    tags: list[str] = Field(default_factory=list)


class ObservationBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    trace_id: str = Field(alias="traceId")
    type: Literal["SPAN", "GENERATION", "EVENT"] = "SPAN"
    name: Optional[str] = None
    start_time: str = Field(alias="startTime")
    end_time: Optional[str] = Field(default=None, alias="endTime")
    model: Optional[str] = None
    input: Any = None
    output: Any = None
    metadata: Optional[dict[str, Any]] = None
    level: Literal["DEBUG", "DEFAULT", "WARNING", "ERROR"] = "DEFAULT"
    # 原始 usage 对象（OpenAI/Anthropic 风格），服务端据此推算 token 与成本
    usage: Any = None


class ScoreBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: Optional[str] = None
    trace_id: Optional[str] = Field(default=None, alias="traceId")
    observation_id: Optional[str] = Field(default=None, alias="observationId")
    name: str
    value: Any
    data_type: Literal["NUMERIC", "CATEGORICAL", "BOOLEAN"] = Field(alias="dataType")
    source: Literal["API", "ANNOTATION"] = "API"
    comment: Optional[str] = None


class TraceEvent(BaseModel):
    type: Literal["trace-create"]
    body: TraceBody


class ObservationEvent(BaseModel):
    type: Literal["observation-create"]
    body: ObservationBody


class ScoreEvent(BaseModel):
    type: Literal["score-create"]
    body: ScoreBody


IngestionEvent = TraceEvent | ObservationEvent | ScoreEvent


def event_payload(body: BaseModel) -> dict[str, Any]:
    """把事件 body 序列化为 ingestion API 所需 JSON（camelCase）。"""
    return body.model_dump(mode="json", by_alias=True)


def score_data_type(value: Any) -> str:
    """按值推断 dataType：bool → BOOLEAN，str → CATEGORICAL，数字 → NUMERIC。"""
    if isinstance(value, bool):
        return "BOOLEAN"
    if isinstance(value, str):
        return "CATEGORICAL"
    return "NUMERIC"

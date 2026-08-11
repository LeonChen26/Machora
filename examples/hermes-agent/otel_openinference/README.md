# OpenInference OTLP Observability

Optional Hermes observability plugin that exports agent execution to any
OTLP/HTTP traces endpoint (Machora, OTel Collector, DataDog) using the
[OpenInference semantic conventions](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md).

## Span tree

```
session   span.kind=AGENT  ← on_session_start / on_session_end
└── turn   span.kind=CHAIN ← pre_llm_call / post_llm_call
    ├── llm   span.kind=LLM  ← pre_api_request / post_api_request / api_request_error
    └── tool  span.kind=TOOL ← pre_tool_call / post_tool_call
subagent   span.kind=AGENT  ← subagent_start / subagent_stop
```

`openinference.span.kind` drives backend classification — Machora stores it
directly as `observation.type` (LLM → LLM, AGENT → AGENT, CHAIN → CHAIN, ...).
Inputs/outputs use `input.value` /
`output.value` (JSON-encoded, `application/json` mime), models use
`llm.model_name`, token counts use `llm.token_count.prompt/completion`, and
tools use `tool.name` / `tool_call.id`. `session.id`, `user.id`, and
`agent.name` are set on the session root span so backends like Machora
promote them to trace-level fields.

## Enablement

```bash
pip install 'hermes-agent[otlp]'
hermes plugins enable observability/otel_openinference
```

## Configuration (env vars)

| Env var | Default | Meaning |
| --- | --- | --- |
| `HERMES_OTEL_OPENINFERENCE_ENDPOINT` | `http://localhost:3100/api/public/otel/v1/traces` | Full OTLP/HTTP traces URL |
| `HERMES_OTEL_OPENINFERENCE_HEADERS` | *(none)* | Comma-separated `K=V` headers, e.g. `Authorization=Basic <base64(pk:sk)>` for Machora |
| `HERMES_OTEL_OPENINFERENCE_SERVICE_NAME` | `hermes` | Resource `service.name` |
| `HERMES_OTEL_OPENINFERENCE_MAX_CHARS` | `12000` | Max chars per input/output value |
| `HERMES_OTEL_OPENINFERENCE_DEBUG` | *(off)* | `true` for verbose logging |
| `HERMES_OTEL_OPENINFERENCE_DISABLED` | *(off)* | `true` to skip hook registration |

Hooks are fail-open: if the SDK or endpoint is unavailable the plugin is
inert and never affects the agent loop. In-memory session state is bounded
(256 sessions, LRU-style eviction).

Example pointing at a local Machora:

```bash
export HERMES_OTEL_OPENINFERENCE_ENDPOINT=http://localhost:3100/api/public/otel/v1/traces
export HERMES_OTEL_OPENINFERENCE_HEADERS=Authorization=Basic <base64(pk:sk)>
```

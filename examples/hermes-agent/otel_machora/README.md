# Machora 原生 OTLP Observability（otel_machora）

Hermes 可观测性插件：把 agent 执行导出到 Machora OTLP/HTTP traces 端点，
使用 **machora.\*** 原生语义键（与 `packages/shared/src/otel/semantics/machora.ts`
对齐），接入层 machora adapter（最高优先级）直接落库 `observation.type`。

## Span 树

```
session   machora.span.kind=ENTRY  ← on_session_start / on_session_end
└── turn   machora.span.kind=STEP  ← pre_llm_call / post_llm_call
    ├── llm   machora.span.kind=LLM  ← pre_api_request / post_api_request / api_request_error
    └── tool  machora.span.kind=TOOL ← pre_tool_call / post_tool_call
subagent   machora.span.kind=AGENT  ← subagent_start / subagent_stop
```

`machora.span.kind` 直接落库为 `observation.type`（ENTRY/STEP/LLM/TOOL/AGENT）。
输入输出用 `machora.input` / `machora.output`（JSON 字符串，接入层自动解码），
模型用 `machora.model.name`，token 用 `machora.token.input/output`，工具用
`machora.tool.name` / `machora.tool.call.id`。根 span 携带 `machora.session.id` /
`machora.user.id` / `machora.agent.name`，由接入层提升为 trace 级字段。
错误通过 `machora.level=ERROR` + OTel span status 标记。

## 启用

```bash
pip install 'hermes-agent[otlp]'
hermes plugins enable observability/otel_machora
```

## 配置（环境变量）

| Env var | 默认 | 含义 |
| --- | --- | --- |
| `HERMES_OTEL_MACHORA_ENDPOINT` | `http://localhost:3100/api/public/otel/v1/traces` | OTLP/HTTP traces URL |
| `HERMES_OTEL_MACHORA_HEADERS` | *(none)* | 逗号分隔 `K=V` 请求头，如 `Authorization=Basic <base64(pk:sk)>` |
| `HERMES_OTEL_MACHORA_SERVICE_NAME` | `hermes` | Resource `service.name` |
| `HERMES_OTEL_MACHORA_MAX_CHARS` | `12000` | input/output 单值最大字符数 |
| `HERMES_OTEL_MACHORA_DEBUG` | *(off)* | `true` 输出详细日志 |
| `HERMES_OTEL_MACHORA_DISABLED` | *(off)* | `true` 跳过 hook 注册 |

Hook 全部 fail-open：SDK 或端点不可用时插件保持惰性，不影响 agent 循环。
内存会话状态有界（256 会话，LRU 淘汰）。

指向本地 Machora 的示例：

```bash
export HERMES_OTEL_MACHORA_ENDPOINT=http://localhost:3100/api/public/otel/v1/traces
export HERMES_OTEL_MACHORA_HEADERS=Authorization=Basic <base64(pk:sk)>
```

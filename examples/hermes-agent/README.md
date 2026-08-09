# Hermes Agent — OpenInference OTLP 探针

[`otel_openinference/`](./otel_openinference/) 是面向 [Hermes Agent](https://github.com/NousResearch/hermes-agent)
的可选可观测插件，按
[OpenInference 语义规范](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md)
将 session / turn / LLM / tool / subagent 跨度导出到任意 OTLP/HTTP traces 端点
（Machora、OTel Collector、DataDog 等）。

## 接入 Machora

```bash
pip install 'hermes-agent[otlp]'
hermes plugins enable observability/otel_openinference

export HERMES_OTEL_OPENINFERENCE_ENDPOINT=http://localhost:3100/api/public/otel/v1/traces
export HERMES_OTEL_OPENINFERENCE_HEADERS=Authorization=Basic <base64(pk:sk)>
```

LLM 调用的 `input.value` / `output.value` 存储为 `[{role, content}, ...]` 消息数组，
Machora 前端按 role 渲染气泡（调用树详情面板 + 「对话」Tab），而非原始 JSON 信封。

完整配置说明见 [`otel_openinference/README.md`](./otel_openinference/README.md)。

# OpenClaw → Machora OpenInference 探针

将 OpenClaw 的[诊断事件](https://github.com/openclaw/openclaw)（`model.call.*`、`tool.execution.*`、`run.*`、`harness.run.*`）
转换为 [OpenInference](https://github.com/Arize-ai/openinference) 语义 span，通过 OTLP HTTP 上报到
Machora 的 trace 端点，使 OpenClaw 的 Agent 运行在 Machora 轨迹视图中按角色分类展示
（ENTRY/AGENT/STEP/LLM/TOOL），并正确关联 session。

本探针由 Machroa 仓库维护，不依赖 hermes-agent 或任何其他探针实现。

## 目录结构

```
examples/openclaw/
├── index.ts              # 插件入口（definePluginEntry）
├── runtime-api.ts        # 公开 createMachoraOpenInferenceService
├── openclaw.plugin.json  # 插件 manifest + configSchema
├── package.json          # 依赖与 openclaw.extensions 声明
└── src/
    ├── service.ts        # 服务：订阅诊断事件 → 构建 span 树
    ├── exporter.ts       # 独立 OTel SDK + OTLP exporter
    └── attributes.ts     # OpenInference 属性键常量
```

## 安装

探针以 OpenClaw 原生插件形式安装（本地路径或 archive）：

```bash
openclaw plugins install /path/to/Machroa/examples/openclaw
# 或链接模式（开发时改动即时生效）
openclaw plugins install -l /path/to/Machroa/examples/openclaw --force
```

安装后确认已启用：

```bash
openclaw plugins list | grep machora-openinference
```

## 配置

在 `openclaw.json` 中配置端点与认证头（任选其一：插件 config 或环境变量）：

```jsonc
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "traces": true,
      "captureContent": true   // 必须开启，否则 input/output 内容不随事件下发
    }
  },
  "plugins": {
    "entries": {
      "machora-openinference": {
        "config": {
          "endpoint": "http://localhost:3100/api/public/otel/v1/traces",
          "headers": { "Authorization": "Basic <base64>" }
        }
      }
    }
  }
}
```

`captureContent: true` 由 OpenClaw 核心侧的
[`resolveDiagnosticModelContentCapturePolicy`](https://github.com/openclaw/openclaw)
控制，必须开启探针才能拿到 `privateData.modelContent` 中的真实输入输出内容。

也可用环境变量配置（与插件 config 等价，config 优先）：

```bash
export MACHORA_OTEL_ENDPOINT=http://localhost:3100/api/public/otel/v1/traces
export MACHORA_OTEL_HEADERS='{"Authorization":"Basic <base64>"}'
export MACHORA_OTEL_SERVICE_NAME=openclaw
```

## 工作原理

| OpenClaw 诊断事件 | OpenInference span kind | 父链 | 关键属性 |
| --- | --- | --- | --- |
| `harness.run.started/completed/error` | `AGENT` | 根 | `agent.name=harnessId`、`session.id` |
| `run.started/completed` | `CHAIN` | 同 runId 的 harness | `session.id` |
| `model.call.started/completed/error` | `LLM` | 同 runId 的 run | `llm.model_name`、`llm.token_count.*`、`input.value`/`output.value` |
| `tool.execution.started/completed/error` | `TOOL` | 同 runId 的 run | `tool.name`、`tool_call.id`、`input.value`/`output.value` |

要点：

- **session 关联**：span 直接写 `session.id` 属性（来自事件的 `sessionId`/`sessionKey`），
  Machora 据此把同一会话的 span 归入同一 trace。
- **角色分类**：所有 span 带 `openinference.span.kind`，Machora 的 processor 以它为
  第 2 优先分类来源，轨迹视图即可显示 AGENT/LLM/TOOL 等角色。
- **内容捕获**：`model.call` 与 `tool.execution` 的 `input.value`/`output.value` 来自
  `privateData.modelContent` / `privateData.toolContent`，按 JSON 字符串写入，Machora
  前端会解析为消息数组并渲染 parts 结构。
- **独立 SDK**：探针使用独立的 `NodeSDK` 实例与专属 `BatchSpanProcessor`，不与
  `diagnostics-otel` 插件共享全局 exporter，互不干扰。
- **事件丢失兜底**：若 `*_started` 事件因异步队列丢弃而未到达，`*_completed/error`
  事件会用 `ts - durationMs` 推导起始时间补建 span。

## 验证

本地起 Machora（默认 `http://localhost:3100`）后运行一次 OpenClaw 会话，然后在
Machora trace 列表页确认出现新的 trace，展开调用树应能看到：
`AGENT (harness) → CHAIN (run) → LLM (model) / TOOL (tool)` 的层级，且各 span 名称、
token 用量与输入输出内容正确。

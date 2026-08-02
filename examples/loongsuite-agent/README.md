# LoongSuite 示例 Agent（Machora 可观测演示）

用阿里云 LoongSuite 的 GenAI Util（`loongsuite-otel-util-genai`）手动构造一条完整
调用树并灌入 Machora，演示 **LoongSuite GenAI SemConv 增强语义**：

```
entry（session.id / user.id 染色整条链路）
└── invoke_agent（agent_name → Baggage + agentName 专用列）
    └── react_step（ReAct 单轮，round=1）
        ├── execute_tool: get_weather（gen_ai.skill.* → skillName 专用列）
        ├── execute_tool: add
        └── llm（input/output 消息 → GENERATION）
```

Machora 侧映射（2026-08-02 补齐）：

| LoongSuite 语义 | Machora 呈现 |
|---|---|
| `gen_ai.operation.name=entry / react_step / rerank / invoke_skill` | SPAN（AGENT_OPERATIONS 显式枚举） |
| `gen_ai.skill.name`（挂在 execute_tool 上） | Trace/Observation `skillName` 专用列 + UI 徽章 + 查询 API `skill=` 过滤 |
| `gen_ai.skill.id / description / version` | metadata 保留 |
| `session.id` / `user.id` / `gen_ai.agent.name`（Baggage 传播） | trace 级 userId / sessionId / agentName |

## 运行

```bash
# 1. 安装依赖
python -m venv .venv
.venv/Scripts/activate            # Windows
pip install -r requirements.txt

# 2. 指向 Machora（Basic Auth 需自行 base64(pk:sk)）
#    PowerShell: [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("pk:sk"))
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3100/api/public/otel/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <b64(pk:sk)>
export OTEL_SERVICE_NAME=loongsuite-demo

# 3a. 离线模式（无需 API key，调用树与真实模式一致）
python agent.py

# 3b. 真实模型模式（OpenAI 兼容端点，如 DeepSeek）
export OPENAI_API_KEY=sk-xxx
export OPENAI_BASE_URL=https://api.deepseek.com/v1
python agent.py
```

运行后在 Machora `/traces` 可见一条 `loongsuite-demo` 的 trace：详情页调用树 =
entry(SPAN) → WeatherAssistant(SPAN) → step(SPAN) → get_weather(SPAN, skillName=weather)
+ add(SPAN) + llm(GENERATION)，Agent 徽章 = WeatherAssistant、Skill 徽章 = weather、
会话 = sess-loong-1、用户 = user-loong-1。

> 注意：`loongsuite-otel-util-genai` 与社区 `opentelemetry-util-genai` 混装会触发依赖
> 冲突，请只装 LoongSuite 发行链路（官方建议）。

## 参考

- 仓库：<https://github.com/alibaba/loongsuite-python>
- GenAI Util 扩展规范：`util/opentelemetry-util-genai/README-loongsuite.rst`
- Machora 语义映射：`design.md` §6.3 / §6.8

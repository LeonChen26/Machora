import { Link } from "../../components/NativeLink";
import { requireUser } from "../../server/session";

export const dynamic = "force-dynamic";

export default async function DocsPage() {
  await requireUser();
  const port = process.env.PORT ?? "3100";
  const publicKey = process.env.MACHORA_INIT_PROJECT_PUBLIC_KEY ?? "pk-machora-dev-000000000000000000000";
  const secretKey = process.env.MACHORA_INIT_PROJECT_SECRET_KEY ?? "sk-machora-dev-000000000000000000000";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Docs</h1>
          <div className="sub">通过 REST API 注入 trace / observation / score</div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="label" style={{ marginBottom: 6 }}>端点</div>
        <pre className="code">
{`POST http://localhost:${port}/api/public/ingestion`}
        </pre>
        <div style={{ marginTop: 8 }}>
          <div className="label" style={{ marginBottom: 4 }}>认证（Basic Auth）</div>
          <pre className="code">
{`用户名: ${publicKey}
密码:   ${secretKey}`}
          </pre>
        </div>
      </div>

      <div className="section-title">请求体格式</div>
      <div className="card">
        <pre className="code">
{`{
  "batch": [
    {
      "type": "trace-create" | "observation-create" | "score-create",
      "body": { ... }
    }
  ]
}`}
        </pre>
        <div className="muted" style={{ marginTop: 8 }}>
          batch 内事件按顺序处理（trace 须先于其 observation 创建，否则外键失败）。
        </div>
      </div>

      <div className="section-title">事件类型</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">type</th>
              <th scope="col">关键字段</th>
              <th scope="col">说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="badge blue">trace-create</span></td>
              <td className="mono">id, name, timestamp</td>
              <td className="muted">创建一条 Trace，id 由客户端指定</td>
            </tr>
            <tr>
              <td><span className="badge purple">observation-create</span></td>
              <td className="mono">id, traceId, type, startTime</td>
              <td className="muted">type ∈ SPAN / GENERATION / EVENT（大小写敏感）</td>
            </tr>
            <tr>
              <td><span className="badge amber">score-create</span></td>
              <td className="mono">id, traceId, name, value, dataType, source</td>
              <td className="muted">dataType ∈ NUMERIC / BOOLEAN / CATEGORICAL</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="section-title">完整示例</div>
      <div className="card">
        <pre className="code">
{`curl -X POST http://localhost:${port}/api/public/ingestion \\
  -u "${publicKey}:${secretKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "batch": [
      {
        "type": "trace-create",
        "body": {
          "id": "trace-1",
          "name": "chat-session",
          "timestamp": "${new Date().toISOString()}",
          "userId": "user-42",
          "metadata": {"channel": "web"}
        }
      },
      {
        "type": "observation-create",
        "body": {
          "id": "obs-1",
          "traceId": "trace-1",
          "type": "GENERATION",
          "name": "llm-call",
          "startTime": "${new Date().toISOString()}",
          "model": "gpt-4o-mini",
          "input": [{"role": "user", "content": "你好"}],
          "output": [{"role": "assistant", "content": "你好！有什么可以帮你？"}]
        }
      },
      {
        "type": "score-create",
        "body": {
          "id": "score-1",
          "traceId": "trace-1",
          "name": "helpfulness",
          "value": 0.95,
          "dataType": "NUMERIC",
          "source": "API",
          "comment": "回答切题"
        }
      }
    ]
  }'`}
        </pre>
      </div>

      <div className="section-title">响应</div>
      <div className="card">
        <pre className="code">
{`// 成功
{ "success": true, "received": 3 }

// 部分失败（仍返回 200，逐条记录错误）
{
  "success": true,
  "received": 3,
  "errors": [{ "index": 1, "error": "Foreign key constraint violated" }]
}`}
        </pre>
      </div>

      <div className="section-title">其它端点</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">方法</th>
              <th scope="col">路径</th>
              <th scope="col">说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="badge green">GET</span></td>
              <td className="mono">/api/public/health</td>
              <td className="muted">健康检查</td>
            </tr>
            <tr>
              <td><span className="badge blue">POST</span></td>
              <td className="mono">/api/public/ingestion</td>
              <td className="muted">批量注入</td>
            </tr>
            <tr>
              <td><span className="badge green">GET</span></td>
              <td className="mono">/api/trpc/traces.list</td>
              <td className="muted">tRPC 查询（需时间窗参数）</td>
            </tr>
            <tr>
              <td><span className="badge green">GET</span></td>
              <td className="mono">/api/trpc/traces.byId</td>
              <td className="muted">tRPC 单条查询（需 id 参数）</td>
            </tr>
            <tr>
              <td><span className="badge blue">POST</span></td>
              <td className="mono">/api/public/otel/v1/traces</td>
              <td className="muted">OTLP 注入（JSON / protobuf，Basic Auth）</td>
            </tr>
            <tr>
              <td><span className="badge blue">POST</span></td>
              <td className="mono">/api/public/otel/v1/metrics</td>
              <td className="muted">OTLP metrics 注入（JSON / protobuf，Basic Auth）</td>
            </tr>
            <tr>
              <td><span className="badge green">GET</span></td>
              <td className="mono">/api/public/traces</td>
              <td className="muted">查询 Trace（时间窗 + 游标分页 + select 字段选择）</td>
            </tr>
            <tr>
              <td><span className="badge green">GET</span></td>
              <td className="mono">/api/public/observations</td>
              <td className="muted">查询 Observation（traceId/type/level/model 过滤）</td>
            </tr>
            <tr>
              <td><span className="badge green">GET</span></td>
              <td className="mono">/api/public/scores</td>
              <td className="muted">查询 Score（traceId/name 过滤）</td>
            </tr>
            <tr>
              <td><span className="badge blue">POST</span></td>
              <td className="mono">/api/public/scores</td>
              <td className="muted">提交 annotation 评分（source 强制 ANNOTATION）</td>
            </tr>
            <tr>
              <td><span className="badge blue">POST</span></td>
              <td className="mono">/api/public/evaluations</td>
              <td className="muted">创建服务端评估任务（异步，规则评估器）</td>
            </tr>
            <tr>
              <td><span className="badge green">GET</span></td>
              <td className="mono">/api/public/evaluations</td>
              <td className="muted">查询评估任务（traceId/status 过滤）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="section-title">查询与评估</div>
      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>
          查询 API 对齐 Langfuse 公开 API：Basic Auth 认证，列表返回{" "}
          <span className="mono">{"{ data, meta: { limit, nextCursor, hasMore, totalCount } }"}</span>{" "}
          信封；支持时间窗（from/to）、游标分页（limit/cursor）与字段选择（select=name,tags）。示例：
        </div>
        <pre className="code">
{`# 查询近 7 天 Trace（只取部分字段）
curl -u "${publicKey}:${secretKey}" \\
  "http://localhost:${port}/api/public/traces?from=${new Date(Date.now() - 7 * 864e5).toISOString()}&select=id,name,tags"

# 提交 annotation 评分
curl -u "${publicKey}:${secretKey}" \\
  -X POST http://localhost:${port}/api/public/scores \\
  -H "Content-Type: application/json" \\
  -d '{"traceId":"<traceId>","name":"helpfulness","value":0.95,"dataType":"NUMERIC"}'

# 运行服务端评估（error 规则：trace 是否含 ERROR observation）
curl -u "${publicKey}:${secretKey}" \\
  -X POST http://localhost:${port}/api/public/evaluations \\
  -H "Content-Type: application/json" \\
  -d '{"traceId":"<traceId>","evaluatorType":"error"}'`}
        </pre>
        <div className="muted" style={{ marginTop: 8 }}>
          内置评估器：<span className="mono">error</span> / <span className="mono">latency</span> /{" "}
          <span className="mono">cost</span> / <span className="mono">token</span> / <span className="mono">tag</span>
          （阈值经 config 传入，如 {"{ thresholdMs, thresholdUsd, thresholdTokens, tag }"}）；
          评估结果异步写回 <span className="mono">source=EVALUATION</span> 的 Score。
        </div>
      </div>

      <div className="muted" style={{ marginTop: "1rem" }}>
        <Link href="/traces" prefetch={false}>查看 Traces →</Link>
      </div>

      {/* ===================== Agent / 框架接入指南 ===================== */}
      <div className="section-title" style={{ marginTop: "2.5rem" }}>
        Agent / 框架接入指南
      </div>
      <div className="muted mb-1">
        下方接入步骤均基于真实测试 fixture / 官方源码验证通过。OTLP 端点统一为
        <span className="mono"> POST /api/public/otel/v1/traces </span>
        （支持 JSON / Protobuf 双协议，Basic Auth 鉴权）。
      </div>

      {/* ---------- 1. OpenClaw ---------- */}
      <div className="card mb-3">
        <div className="label" style={{ marginBottom: 6 }}>
          1. OpenClaw 接入（零代码 · 纯配置 · 真实 fixture 2026-08-01）
        </div>
        <div className="muted" style={{ marginBottom: 8 }}>
          OpenClaw 内置 <span className="mono">diagnostics-otel</span> 插件，
          只需启用插件 + 配置端点，即可把每次 agent 运行完整链路上报到 Machora。
          <span className="text-danger">仅支持 http/protobuf 协议</span>，
          设为其他协议会被 OpenClaw 静默跳过。
        </div>

        <div className="label" style={{ marginBottom: 4 }}>1.1 方式 A：持久化配置（推荐）</div>
        <div className="muted" style={{ marginBottom: 4 }}>
          在 OpenClaw 配置目录（默认 <span className="mono">~/.openclaw/openclaw.local.json5</span>）
          中加入如下内容；pk/sk 做 base64 替换为 <span className="mono">{"Basic <BASE64(pk:sk)>"}</span>。
        </div>
        <pre className="code">{`{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:${port}/api/public/otel",
      "protocol": "http/protobuf",
      "serviceName": "openclaw",
      "traces": true,
      "metrics": false,
      "logs": false,
      "headers": {
        "Authorization": "Basic <BASE64(pk:sk)>"
      }
    }
  },
  "plugins": {
    "allow": [
      "diagnostics-otel"
    ],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  }
}`}</pre>

        <div className="label" style={{ margin: "8px 0 4px" }}>1.2 方式 B：环境变量临时生效</div>
        <div className="muted" style={{ marginBottom: 4 }}>
          在 <b>启动 OpenClaw 的同一终端</b> 设置 <span className="mono">OTEL_*</span> 变量
          （注意中缀带 <span className="mono">_TRACES_</span>）：
        </div>
        <pre className="code">{`# PowerShell
$env:OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://localhost:${port}/api/public/otel"
$env:OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/protobuf"
$env:OTEL_EXPORTER_OTLP_TRACES_HEADERS  = "Authorization=Basic <BASE64(pk:sk)>"
$env:OTEL_SERVICE_NAME = "openclaw"

# 脚本方式：仓库 scripts/connect-openclaw.sh
#   source scripts/connect-openclaw.sh`}</pre>

        <div className="label" style={{ margin: "8px 0 4px" }}>1.3 语义映射（openclaw.test.ts · 6 it 全部通过）</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">OpenClaw Span</th>
                <th scope="col">Machora 映射</th>
                <th scope="col">说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">openclaw.model.call</td>
                <td><span className="badge purple">GENERATION</span></td>
                <td className="muted">
                  模型=deepseek-v4-flash；
                  input/output/total tokens 已提取；cache_read 量保留在 metadata
                </td>
              </tr>
              <tr>
                <td className="mono">openclaw.harness.run / openclaw.run</td>
                <td><span className="badge blue">SPAN（父-子嵌套）</span></td>
                <td className="muted">
                  harness.run → run → model.call / tool.execution，层级完整还原
                </td>
              </tr>
              <tr>
                <td className="mono">openclaw.exec</td>
                <td><span className="badge blue">SPAN</span></td>
                <td className="muted">
                  openclaw.exec.target/mode/exit_code 与 outcome 保留 metadata
                </td>
              </tr>
              <tr>
                <td className="mono">tool.execution（gen_ai.tool.name）</td>
                <td><span className="badge blue">SPAN</span></td>
                <td className="muted">
                  observation.name = 工具名；
                  metadata 保留 openclaw.toolName / tool.source
                </td>
              </tr>
              <tr>
                <td className="mono">openclaw.liveness.warning</td>
                <td><span className="badge blue">SPAN（独立 Trace）</span></td>
                <td className="muted">
                  事件循环延迟等告警，metadata 含 openclaw.liveness.reason
                </td>
              </tr>
              <tr>
                <td className="mono">openclaw.model.usage</td>
                <td><span className="badge purple">GENERATION（独立 Trace）</span></td>
                <td className="muted">
                  汇总 token 用量，metadata 含 openclaw.agent / tokens.total
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          常见坑：① plugins.allow 漏加 diagnostics-otel → 插件不加载；
          ② endpoint 漏掉 /api/public/otel 前缀 → 404；
          ③ protocol 设为 http/json → OpenClaw 直接跳过（必须 http/protobuf）。
        </div>
      </div>

      {/* ---------- 2. JiuwenSwarm 九问（华为开源） ---------- */}
      <div className="card mb-3">
        <div className="label" style={{ marginBottom: 6 }}>
          2. JiuwenSwarm（九问 · 华为开源）接入（推荐方案 B · Team 协同模式 · 纯 YAML 零代码）
        </div>
        <div className="muted" style={{ marginBottom: 8 }}>
          JiuwenSwarm（九问）为 <b>华为开源</b> 的多智能体协同框架。
          内部通过 openjiuwen 内核的 OtelCallbackHandler 自动发射 LLM / 工具 span，
          根 span 由框架自动打开关闭；对外暴露的配置段是 <b>
          <span className="mono">team_observability</span></b>（Team 协同模式，本方案主推荐）和 <b>
          <span className="mono">agent_observability</span></b>（单 Agent / Code 模式，方案 A 备选）。
          <span className="text-danger">通用 OTEL_* 环境变量不生效</span>，
          必须写配置文件；认证走 JiuwenSwarm 专有的 <span className="mono">langfuse_public_key</span> /
          <span className="mono"> langfuse_secret_key</span> 两字段（内部拼成 {"`Authorization: Basic BASE64(pk:sk)`"}，与 Machora 认证格式完全兼容）。
        </div>

        <div className="label" style={{ marginBottom: 4 }}>
          ✅ 方案 B · Team 协同模式（推荐）（~/.jiuwenswarm/config/config.yaml）
        </div>
        <div className="muted" style={{ marginBottom: 4 }}>
          开启后 TeamAgent 的 <b>team / member / task / message</b> span 完整上报，
          同时复用同一全局 TracerProvider 承载 LLM / 工具调用。endpoint <b>必须写完整
          /api/public/otel/v1/traces 后缀</b>。
        </div>
        <pre className="code">{`# TeamAgent 的 team/member/task/message span（主推荐方案）
team_observability:
  enabled: true
  exporter: otlp_http                                    # otlp_http / otlp_grpc / file / console
  endpoint: "http://localhost:${port}/api/public/otel/v1/traces"
  service_name: jiuwenswarm
  sample_rate: 1.0
  langfuse_public_key:  "${publicKey}"
  langfuse_secret_key:  "${secretKey}"
  traces_dir: ""                                         # 空 → 默认 ~/.jiuwenswarm/.trace
  file_retention_days: 7
  attribute_value_max_length: 10240`}</pre>

        <div className="label" style={{ margin: "12px 0 4px" }}>方案 A · 单 Agent / Code 模式（备选：仅用 agent.plan / agent.fast / code.* 时）</div>
        <div className="muted" style={{ marginBottom: 4 }}>
          若项目不需要 Team 协同，仅跑独立 agent，则只配置 <span className="mono">agent_observability</span> 段。
        </div>
        <pre className="code">{`# 仅作用于 agent.* / code.* 模式的 OTel 上报
agent_observability:
  enabled: true
  exporter: otlp_http
  endpoint: "http://localhost:${port}/api/public/otel/v1/traces"
  service_name: jiuwenswarm-agent
  sample_rate: 1.0
  langfuse_public_key:  "${publicKey}"
  langfuse_secret_key:  "${secretKey}"
  redact_prompts: false
  redact_completions: false`}</pre>

        <div className="label" style={{ margin: "12px 0 4px" }}>临时调试：/debug + 本地 dump + OTel（debug_trace 段）</div>
        <div className="muted" style={{ marginBottom: 4 }}>
          不常开 OTel，只想在特定轮次捕获：对话输入 <span className="mono">/debug 你的问题</span>；
          可配合 <span className="mono">debug_trace.*.otel_enabled = true</span> 顺带 force 拉起 OTel（force 一旦用过，本进程全局不再自动 teardown provider）。
        </div>
        <pre className="code">{`# ~/.jiuwenswarm/config/config.yaml
debug_trace:
  agent:                # agent.* 模式（agent.plan / agent.fast …）
    otel_enabled: true
  code:                 # code.* 模式（code.normal / code.plan …）
    otel_enabled: true

# 对话里直接输入（仅本轮生效，无需改配置）：
#   /debug 帮我修复 tests/test_login.py 里失败的用例`}</pre>

        <div className="label" style={{ margin: "12px 0 4px" }}>输出语义 &amp; Machora 映射（实锤 · agent_observability.py + openjiuwen OtelCallbackHandler）</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">JiuwenSwarm 输出（实锤）</th>
                <th scope="col">Machora 呈现</th>
                <th scope="col">专用列 / 说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  根 span 名 <span className="mono">agent.{"<mode>.<session_id>"}</span>
                  <br />（mode=agent.plan/agent.fast/code.normal/code.plan）
                </td>
                <td><span className="badge blue">SPAN（整棵树父节点）</span></td>
                <td className="mono">trace.name</td>
              </tr>
              <tr>
                <td className="mono">jiuwenswarm.mode = agent.plan | code.normal …</td>
                <td className="muted">整树携带，供 Analytics 按模式切片</td>
                <td className="muted">span attribute → metadata 保留</td>
              </tr>
              <tr>
                <td className="mono">LANGFUSE_SESSION_ID（= 会话 id，挂根 span）</td>
                <td className="muted">自动提升为 trace 级列</td>
                <td className="mono">trace.sessionId（兼容 session.id / langfuse.session.id 双通道）</td>
              </tr>
              <tr>
                <td>Team 模式 span：<b>team / member / task / message</b></td>
                <td><span className="badge blue">SPAN（层级嵌套）</span></td>
                <td className="muted">方案 B 开启后出现；父子关系由 parentSpanId 原样还原</td>
              </tr>
              <tr>
                <td>OtelCallbackHandler 自动发射 LLM span<br />（内置 langfuse.* 属性族 + GenAI 语义）</td>
                <td><span className="badge purple">GENERATION</span></td>
                <td className="muted">
                  model / inputTokens / outputTokens / totalTokens / totalCost<br />
                  input / output（JSON 自动解码）
                </td>
              </tr>
              <tr>
                <td>OtelCallbackHandler 自动发射工具调用 span<br />（TOOLS / EVENT 类）</td>
                <td><span className="badge blue">SPAN</span></td>
                <td>observation.name = 工具名（bash / mcp_exec_command / write_file 等）</td>
              </tr>
              <tr>
                <td className="mono">langfuse.trace.tags（任何 span 挂的 trace 级标签）</td>
                <td><span className="badge">tags 徽章</span></td>
                <td className="mono">trace.tags</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          常见坑：① endpoint 漏写 /api/public/otel/v1/traces 后缀 → 404（otlp_http exporter 不自动拼接路径）；② 填 OTEL_* 环境变量 → JiuwenSwarm 内部不读，必须写文件；③ 混用 otlp_grpc exporter → Machora 当前仅测过 HTTP JSON/Protobuf 双栈，gRPC 需另起 collector。
        </div>
      </div>

      {/* ---------- 3. π-Agent ---------- */}
      <div className="card mb-3">
        <div className="label" style={{ marginBottom: 6 }}>
          3. π-Agent（π-Actor 框架）接入（标准 OTel · OpenInference 语义）
        </div>
        <div className="muted" style={{ marginBottom: 8 }}>
          π-Agent 基于标准 OpenTelemetry + OpenInference 语义（<span className="mono">openinference.span.kind</span>），
          与 LlamaIndex / LangGraph 走同一套语义通道。Machora 的 OTel 处理器已按
          OpenInference 规范映射，无需额外适配器。
        </div>

        <div className="label" style={{ marginBottom: 4 }}>3.1 环境变量（Node.js / Python 通用）</div>
        <pre className="code">{`# 端点：完整带 /api/public/otel/v1/traces 后缀
OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:${port}/api/public/otel/v1/traces"
OTEL_EXPORTER_OTLP_HEADERS  = "Authorization=Basic <BASE64(pk:sk)>"
OTEL_SERVICE_NAME           = "pi-agent"
OTEL_RESOURCE_ATTRIBUTES    = "service.version=1.0.0"`}</pre>

        <div className="label" style={{ margin: "8px 0 4px" }}>3.2 Python 初始化（OpenInference 通用手工埋点）</div>
        <pre className="code">{`from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

# 1) exporter（Basic Auth 经 headers 传入）
exporter = OTLPSpanExporter(
    endpoint=f"http://localhost:${port}/api/public/otel/v1/traces",
    headers={"Authorization": "Basic <BASE64(pk:sk)>"},
)
provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(exporter))

# 2) 若 π-Agent 内部用 LangChain / LlamaIndex：
#
#   from openinference.instrumentation.langchain import LangChainInstrumentor
#   LangChainInstrumentor().instrument(tracer_provider=provider)
#
#   或：
#   from openinference.instrumentation.llamaindex import LlamaIndexInstrumentor
#   LlamaIndexInstrumentor().instrument(tracer_provider=provider)

# 3) 手工埋点示例（openinference.span.kind → 类型自动映射）
tracer = provider.get_tracer("pi-demo")

# 3a) 根 Span（Agent 入口 → SPAN + trace 级属性提升）
with tracer.start_as_current_span("pi.main") as s:
    s.set_attribute("openinference.span.kind", "AGENT")
    s.set_attribute("user.id",       "user-pi-001")   # → trace.userId
    s.set_attribute("session.id",    "sess-pi-001")   # → trace.sessionId
    s.set_attribute("agent.name",    "PiScheduler")   # → trace.agentName
    s.set_attribute("tag.tags",      '["prod","v2"]') # → trace.tags

    # 3b) 工具调用（TOOL → SPAN）
    with tracer.start_as_current_span("search") as t:
        t.set_attribute("openinference.span.kind", "TOOL")
        t.set_attribute("gen_ai.tool.name", "web_search")
        t.set_attribute("input.value",  '"2026年8月北京天气"')
        t.set_attribute("output.value", '{"temp":"32C"}')

    # 3c) LLM 调用（LLM → GENERATION + token/成本）
    with tracer.start_as_current_span("llm.chat") as g:
        g.set_attribute("openinference.span.kind", "LLM")
        g.set_attribute("llm.model_name",          "deepseek-v4-flash")
        g.set_attribute("llm.token_count.prompt",  420)
        g.set_attribute("llm.token_count.completion", 60)
        g.set_attribute("llm.cost.total",          0.000084)
        g.set_attribute("input.messages",          '[{"role":"user","content":"你好"}]')
        g.set_attribute("output.value",            '{"role":"assistant","content":"你好！"}')`}</pre>

        <div className="label" style={{ margin: "8px 0 4px" }}>3.3 OpenInference 语义 → Machora 映射（openinference.test.ts · 5 it 全部通过）</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">openinference.span.kind</th>
                <th scope="col">Observation 类型</th>
                <th scope="col">提取的专用字段</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">LLM</td>
                <td><span className="badge purple">GENERATION</span></td>
                <td className="muted">
                  llm.model_name → model；
                  llm.token_count.* → input/outputTokens；
                  llm.cost.total → totalCost；
                  input.* / output.* → input/output（JSON 自动解码）
                </td>
              </tr>
              <tr>
                <td className="mono">EMBEDDING</td>
                <td><span className="badge purple">GENERATION</span></td>
                <td className="muted">
                  embedding.model_name → model；
                  embedding.token_count → totalTokens
                </td>
              </tr>
              <tr>
                <td className="mono">AGENT / CHAIN / TOOL / RETRIEVER / RERANKER</td>
                <td><span className="badge blue">SPAN</span></td>
                <td className="muted">
                  gen_ai.tool.name → observation.name；
                  其余属性留 metadata
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          常见坑：① endpoint 只写到 .../otel 没加 /v1/traces → 404；
          ② 进程结束前未等待 BatchSpanProcessor flush → trace 丢失；
          ③ input.messages / output.value 传 Python dict 而非 JSON 字符串（建议 json.dumps(...) 序列化后再写入）。
        </div>
      </div>

      <div className="muted" style={{ marginTop: "0.5rem" }}>
        更多可运行示例（LangChain / LlamaIndex / LoongSuite 完整脚本）见仓库{" "}
        <span className="mono">examples/</span> 目录；OTLP 捕获 &amp; 解码辅助工具见{" "}
        <span className="mono">scripts/capture-otel.mjs / decode-otel-fixture.mjs</span>。
      </div>

      {/* ===================== 语义规范（Semantic Conventions） ===================== */}
      <div className="section-title" style={{ marginTop: "2.5rem" }} id="semantic-conventions">
        语义规范（Semantic Conventions）
      </div>
      <div className="muted mb-1">
        OTLP 处理器按优先级从多套语义（Langfuse / OpenTelemetry GenAI / OpenInference / LoongSuite
        增强）中识别 observation 类型并提取专用字段；其余原始属性保留在{" "}
        <span className="mono">metadata</span>。映射规则对应{" "}
        <span className="mono">packages/shared/src/otel/attributes.ts</span> 与{" "}
        <span className="mono">processor.ts</span>。
      </div>

      <div className="card mb-3">
        <div className="label" style={{ marginBottom: 6 }}>
          Observation 类型判定（优先级从高到低）
        </div>
        <ol className="muted" style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            <span className="mono">langfuse.observation.type</span> 显式指定 →{" "}
            <span className="badge purple">GENERATION</span> /{" "}
            <span className="badge amber">EVENT</span>，其余视为{" "}
            <span className="badge blue">SPAN</span>
          </li>
          <li>
            <span className="mono">openinference.span.kind</span>：LLM / EMBEDDING →{" "}
            <span className="badge purple">GENERATION</span>；CHAIN / AGENT / TOOL / RETRIEVER /
            RERANKER / GUARDRAIL / EVALUATOR / PROMPT → <span className="badge blue">SPAN</span>
          </li>
          <li>
            <span className="mono">gen_ai.operation.name</span>：chat / completion / generate* /
            embeddings → <span className="badge purple">GENERATION</span>；agent / workflow / plan /
            memory / retrieval 系列 → <span className="badge blue">SPAN</span>
          </li>
          <li>
            LoongSuite <span className="mono">gen_ai.span.kind</span>：LLM / EMBEDDING →{" "}
            <span className="badge purple">GENERATION</span>；STEP / TOOL / AGENT / ENTRY →{" "}
            <span className="badge blue">SPAN</span>
          </li>
          <li>
            存在 <span className="mono">gen_ai.tool.name</span> /{" "}
            <span className="mono">gen_ai.tool.call.id</span> → <span className="badge blue">SPAN</span>
          </li>
          <li>兜底 → <span className="badge blue">SPAN</span></li>
        </ol>
      </div>

      <div className="section-title">属性 → 专用字段映射</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">属性（多语义兼容）</th>
              <th scope="col">提取字段</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">gen_ai.tool.name / openinference tool.name</td>
              <td className="mono">observation.name（工具调用节点名）</td>
            </tr>
            <tr>
              <td className="mono">gen_ai.request.model / llm.model_name / langfuse.observation.model.name</td>
              <td className="mono">observation.model</td>
            </tr>
            <tr>
              <td className="mono">gen_ai.usage.input_tokens / llm.token_count.prompt</td>
              <td className="mono">inputTokens</td>
            </tr>
            <tr>
              <td className="mono">gen_ai.usage.output_tokens / llm.token_count.completion</td>
              <td className="mono">outputTokens</td>
            </tr>
            <tr>
              <td className="mono">llm.cost.total / langfuse.observation.cost_details</td>
              <td className="mono">totalCost</td>
            </tr>
            <tr>
              <td className="mono">
                gen_ai.input.messages / gen_ai.tool.call.arguments / gen_ai.prompt / input.value
              </td>
              <td className="mono">input（JSON 自动解码）</td>
            </tr>
            <tr>
              <td className="mono">gen_ai.output.messages / gen_ai.completion / output.value</td>
              <td className="mono">output（JSON 自动解码）</td>
            </tr>
            <tr>
              <td className="mono">gen_ai.agent.name / agent.name / gen_ai.user.id</td>
              <td className="mono">trace/observation.agentName · trace.userId</td>
            </tr>
            <tr>
              <td className="mono">gen_ai.workflow.name / gen_ai.skill.name</td>
              <td className="mono">workflowName · skillName</td>
            </tr>
            <tr>
              <td className="mono">session.id / gen_ai.session.id</td>
              <td className="mono">trace.sessionId</td>
            </tr>
            <tr>
              <td className="mono">langfuse.trace.tags / tag.tags</td>
              <td className="mono">trace.tags</td>
            </tr>
            <tr>
              <td className="mono">error.type（且无显式 level / 非 OK status）</td>
              <td className="mono">observation.level = ERROR</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="section-title">LoongSuite gen_ai.span.kind（Agent 行为角色）</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">span.kind</th>
              <th scope="col">含义</th>
              <th scope="col">Observation 类型</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">ENTRY</td>
              <td className="muted">Agent 调用入口，还原最原始的模型/用户输入输出</td>
              <td><span className="badge blue">SPAN</span></td>
            </tr>
            <tr>
              <td className="mono">AGENT</td>
              <td className="muted">Agent 本体</td>
              <td><span className="badge blue">SPAN</span></td>
            </tr>
            <tr>
              <td className="mono">STEP</td>
              <td className="muted">ReAct 单轮循环（反思 → 工具调用 → 模型调用）</td>
              <td><span className="badge blue">SPAN</span></td>
            </tr>
            <tr>
              <td className="mono">LLM</td>
              <td className="muted">模型调用</td>
              <td><span className="badge purple">GENERATION</span></td>
            </tr>
            <tr>
              <td className="mono">TOOL</td>
              <td className="muted">工具调用（execute_tool，可挂 gen_ai.skill.*）</td>
              <td><span className="badge blue">SPAN</span></td>
            </tr>
            <tr>
              <td className="mono">EMBEDDING</td>
              <td className="muted">嵌入调用</td>
              <td><span className="badge purple">GENERATION</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="section-title">gen_ai.operation.name（操作枚举）</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">operation.name</th>
              <th scope="col">语义</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">chat / completion / text_completion / generate_content / generate / embeddings</td>
              <td className="muted">模型 / 嵌入生成 → GENERATION</td>
            </tr>
            <tr>
              <td className="mono">invoke_agent / create_agent / entry</td>
              <td className="muted">Agent 入口与本体</td>
            </tr>
            <tr>
              <td className="mono">plan / react_step</td>
              <td className="muted">任务规划 / ReAct 单步</td>
            </tr>
            <tr>
              <td className="mono">invoke_workflow / create_workflow</td>
              <td className="muted">工作流</td>
            </tr>
            <tr>
              <td className="mono">retrieval / rerank</td>
              <td className="muted">RAG 检索 / 重排</td>
            </tr>
            <tr>
              <td className="mono">create / search / upsert / update / get / delete_memory、memory</td>
              <td className="muted">记忆读写</td>
            </tr>
            <tr>
              <td className="mono">invoke_skill / create_skill / skill</td>
              <td className="muted">业务技能</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="label" style={{ marginBottom: 6 }}>metadata 保留规则</div>
        <div className="muted">
          被提取为专用字段的属性不再进 metadata；前缀{" "}
          <span className="mono">gen_ai.prompt</span> / <span className="mono">gen_ai.completion</span>{" "}
          / <span className="mono">llm.</span> / <span className="mono">openinference.</span> /{" "}
          <span className="mono">embedding.</span> 会从 metadata 剔除（避免噪声）；其余原始属性与
          resource 资源属性保留在 <span className="mono">observation.metadata</span>。
          <b>例外</b>：<span className="mono">gen_ai.span.kind</span> /{" "}
          <span className="mono">gen_ai.operation.name</span> / <span className="mono">gen_ai.tool.name</span>{" "}
          / <span className="mono">gen_ai.tool.call.id</span> 无专用列，
          虽在提取键清单中也保留在 metadata，供轨迹视图角色分类使用。
        </div>
      </div>

      <div className="section-title">轨迹视图（推理轨迹）角色分类</div>
      <div className="muted mb-1">
        trace 详情页「轨迹」tab 把 observation 按行为角色重组为主链视图；分类实现见{" "}
        <span className="mono">packages/shared/src/otel/trajectory.ts</span>（判定优先级从高到低）。
        <span className="mono">event / other</span> 不占行，聚合为父节点的计数徽标；
        同名工具在决策序列中连续出现 ≥3 次标记「重复调用」；若段内含无进展信号
        （工具 ERROR 或输出显式为空）则 ≥2 次即升级标记「疑似无效循环」；
        STEP 思考节点 ≥8 标记「长任务」。
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">角色</th>
              <th scope="col">判定依据（按优先级）</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">entry 入口</td>
              <td className="muted">gen_ai.span.kind=ENTRY；或根 SPAN（无父）且无其它语义</td>
            </tr>
            <tr>
              <td className="mono">agent</td>
              <td className="muted">span.kind=AGENT / operation=invoke_agent|create_agent|entry / agentName 列</td>
            </tr>
            <tr>
              <td className="mono">workflow 工作流</td>
              <td className="muted">operation=invoke_workflow|create_workflow / workflowName 列</td>
            </tr>
            <tr>
              <td className="mono">think 思考</td>
              <td className="muted">span.kind=STEP / operation=react_step|plan</td>
            </tr>
            <tr>
              <td className="mono">llm 模型</td>
              <td className="muted">span.kind=LLM / operation=chat|completion|generate* / GENERATION 兜底</td>
            </tr>
            <tr>
              <td className="mono">tool 工具</td>
              <td className="muted">span.kind=TOOL / metadata 含 gen_ai.tool.name</td>
            </tr>
            <tr>
              <td className="mono">retrieval 检索</td>
              <td className="muted">operation=retrieval|rerank</td>
            </tr>
            <tr>
              <td className="mono">memory 记忆</td>
              <td className="muted">operation=create/search/upsert/update/get/delete_memory、memory</td>
            </tr>
            <tr>
              <td className="mono">skill 技能</td>
              <td className="muted">operation=invoke_skill|create_skill|skill / skillName 列</td>
            </tr>
            <tr>
              <td className="mono">embedding 嵌入</td>
              <td className="muted">span.kind=EMBEDDING / operation=embeddings / model 含 embed</td>
            </tr>
            <tr>
              <td className="mono">event 日志</td>
              <td className="muted">type=EVENT（聚合计数，不占行）</td>
            </tr>
            <tr>
              <td className="mono">other 其它</td>
              <td className="muted">其余 SPAN（聚合计数，不占行）</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

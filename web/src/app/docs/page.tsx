import { Link } from "../../components/NativeLink";
import { requireUser } from "../../server/session";

export const dynamic = "force-dynamic";

// ===================== Docs 侧边栏目录 =====================
const NAV_SECTIONS = [
  {
    label: "API 参考",
    items: [
      { href: "#api-endpoint", label: "端点与认证" },
      { href: "#api-ingestion", label: "批量注入" },
      { href: "#api-query", label: "查询与评估" },
      { href: "#api-endpoints", label: "其它端点" },
    ],
  },
  {
    label: "接入指南",
    items: [
      { href: "#agents-otlp", label: "OTLP 通道与认证" },
      { href: "#agents-zero", label: "零埋点框架接入" },
      { href: "#agents-probes", label: "Machora 原生探针" },
    ],
  },
  {
    label: "语义规范",
    items: [
      { href: "#semantics-machora", label: "Machora 语义规范" },
      { href: "#semantics-type", label: "Observation 类型判定" },
      { href: "#semantics-attr", label: "属性 → 专用字段映射" },
      { href: "#semantics-loongsuite", label: "LoongSuite span.kind" },
      { href: "#semantics-operation", label: "gen_ai.operation.name" },
      { href: "#semantics-metadata", label: "metadata 保留规则" },
      { href: "#semantics-trajectory", label: "轨迹视图角色分类" },
    ],
  },
];

function DocsNav() {
  return (
    <nav className="docs-nav" aria-label="文档目录">
      {NAV_SECTIONS.map((section) => (
        <div key={section.label} className="docs-nav-section">
          <div className="docs-nav-label">{section.label}</div>
          {section.items.map((item) => (
            <a key={item.href} href={item.href}>{item.label}</a>
          ))}
        </div>
      ))}
    </nav>
  );
}

export default async function DocsPage() {
  await requireUser();
  const port = process.env.PORT ?? "3100";
  const publicKey = process.env.MACHORA_INIT_PROJECT_PUBLIC_KEY ?? "pk-machora-dev-000000000000000000000";
  const secretKey = process.env.MACHORA_INIT_PROJECT_SECRET_KEY ?? "sk-machora-dev-000000000000000000000";
  const baseUrl = `http://localhost:${port}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Docs</h1>
          <div className="sub">推荐经 OTLP 通道接入各类 Agent / 框架（machora.* 原生语义或 OpenInference / gen_ai 兼容语义）；亦支持 REST API 注入 trace / observation / score</div>
        </div>
      </div>

      <div className="docs-layout">
        <DocsNav />

        <div className="docs-content">
          {/* ===================== 一、API 参考 ===================== */}
          <section className="docs-section" id="api">
            <div className="section-title">一、API 参考</div>
            <div className="docs-subtitle">
              所有公开端点使用 <span className="mono">Basic Auth</span> 鉴权（username / password 分别为
              public key / secret key）。本页示例中的变量取自已配置的环境变量。
            </div>

            {/* ---------- 端点与认证 ---------- */}
            <div id="api-endpoint" className="docs-section">
              <div className="section-title">1.1 端点与认证</div>
              <div className="card">
                <div className="label" style={{ marginBottom: 6 }}>OTLP 端点（推荐 · 零埋点接入）</div>
                <pre className="code">{`POST ${baseUrl}/api/public/otel/v1/traces    # trace / span（JSON / Protobuf）
POST ${baseUrl}/api/public/otel/v1/metrics   # metrics（JSON / Protobuf）`}</pre>
                <div className="muted" style={{ marginTop: 8 }}>
                  支持 OTLP JSON / Protobuf 双协议，多数 LLM 框架与探针（OpenLLMetry、OpenClaw、
                  LangChain、JiuwenSwarm 等）直接指向该端点即可自动上报完整链路，零业务埋点。
                  详细接入见「二、接入指南」。
                </div>
                <div className="label" style={{ margin: "12px 0 4px" }}>批量注入端点（REST API）</div>
                <pre className="code">{`POST ${baseUrl}/api/public/ingestion`}</pre>
                <div style={{ marginTop: 8 }}>
                  <div className="label" style={{ marginBottom: 4 }}>认证（Basic Auth，全部公开端点）</div>
                  <pre className="code">{`用户名: ${publicKey}
密码:   ${secretKey}`}</pre>
                  <div className="muted" style={{ marginTop: 6 }}>
                    本地调试可设 <span className="mono">MACHORA_AUTH_DISABLED=true</span> 免认证（仅限本地，见 2.0）。
                  </div>
                </div>
              </div>
            </div>

            {/* ---------- 批量注入 ---------- */}
            <div id="api-ingestion" className="docs-section">
              <div className="section-title">1.2 批量注入</div>
              <div className="card">
                <pre className="code">{`{
  "batch": [
    {
      "type": "trace-create" | "observation-create" | "score-create",
      "body": { ... }
    }
  ]
}`}</pre>
                <div className="muted" style={{ marginTop: 8 }}>
                  batch 内事件按顺序处理（trace 须先于其 observation 创建，否则外键失败）。
                </div>
              </div>

              <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
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
                      <td className="muted">type 与 span.kind 一致（ENTRY/AGENT/STEP/LLM/TOOL/EMBEDDING/CHAIN/RETRIEVER/RERANKER/EVENT/SPAN）</td>
                    </tr>
                    <tr>
                      <td><span className="badge amber">score-create</span></td>
                      <td className="mono">id, traceId, name, value, dataType, source</td>
                      <td className="muted">dataType ∈ NUMERIC / BOOLEAN / CATEGORICAL</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="section-title" style={{ marginTop: "1.25rem" }}>完整示例</div>
              <div className="card">
                <pre className="code">{`curl -X POST ${baseUrl}/api/public/ingestion \\
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
          "type": "LLM",
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
  }'`}</pre>
              </div>

              <div className="section-title" style={{ marginTop: "1.25rem" }}>响应</div>
              <div className="card">
                <pre className="code">{`// 成功
{ "success": true, "received": 3 }

// 部分失败（仍返回 200，逐条记录错误）
{
  "success": true,
  "received": 3,
  "errors": [{ "index": 1, "error": "Foreign key constraint violated" }]
}`}</pre>
              </div>
            </div>

            {/* ---------- 查询与评估 ---------- */}
            <div id="api-query" className="docs-section">
              <div className="section-title">1.3 查询与评估</div>
              <div className="card">
                <div className="muted" style={{ marginBottom: 8 }}>
                  查询 API 对齐 Langfuse 公开 API：Basic Auth 认证，列表返回{" "}
                  <span className="mono">{"{ data, meta: { limit, nextCursor, hasMore, totalCount } }"}</span>{" "}
                  信封；支持时间窗（from/to）、游标分页（limit/cursor）与字段选择（select=name,tags）。示例：
                </div>
                <pre className="code">{`# 查询近 7 天 Trace（只取部分字段）
curl -u "${publicKey}:${secretKey}" \\
  "${baseUrl}/api/public/traces?from=${new Date(Date.now() - 7 * 864e5).toISOString()}&select=id,name,tags"

# 提交 annotation 评分
curl -u "${publicKey}:${secretKey}" \\
  -X POST ${baseUrl}/api/public/scores \\
  -H "Content-Type: application/json" \\
  -d '{"traceId":"<traceId>","name":"helpfulness","value":0.95,"dataType":"NUMERIC"}'

# 运行服务端评估（error 规则：trace 是否含 ERROR observation）
curl -u "${publicKey}:${secretKey}" \\
  -X POST ${baseUrl}/api/public/evaluations \\
  -H "Content-Type: application/json" \\
  -d '{"traceId":"<traceId>","evaluatorType":"error"}'`}</pre>
                <div className="muted" style={{ marginTop: 8 }}>
                  内置评估器：<span className="mono">error</span> / <span className="mono">latency</span> /{" "}
                  <span className="mono">cost</span> / <span className="mono">token</span> / <span className="mono">tag</span>
                  （阈值经 config 传入，如 {"{ thresholdMs, thresholdUsd, thresholdTokens, tag }"}）；
                  评估结果异步写回 <span className="mono">source=EVALUATION</span> 的 Score。
                </div>
              </div>
            </div>

            {/* ---------- 其它端点 ---------- */}
            <div id="api-endpoints" className="docs-section">
              <div className="section-title">1.4 其它端点一览</div>
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
            </div>
          </section>

          {/* ===================== 二、Agent / 框架接入指南 ===================== */}
          <section className="docs-section" id="agents">
            <div className="section-title">二、Agent / 框架接入指南</div>
            <div className="docs-subtitle">
              两条接入路径：框架自带 OTel 打点（OpenInference / gen_ai.* / langfuse 语义）走{" "}
              <b>零埋点 OTLP</b>；需要 <span className="mono">machora.*</span> 最高优先级语义时用
              仓库维护的<b>原生探针</b>（examples/ 与 sdk/python）。
            </div>

            {/* ---------- OTLP 通道与认证 ---------- */}
            <div id="agents-otlp" className="docs-section">
              <div className="section-title">2.0 OTLP 通道与认证</div>
              <div className="card">
                <div className="label" style={{ marginBottom: 6 }}>统一端点（JSON / Protobuf 双协议）</div>
                <pre className="code">{`POST ${baseUrl}/api/public/otel/v1/traces
Authorization: Basic <BASE64(pk:sk)>`}</pre>
                <div className="muted" style={{ marginTop: 8 }}>通用环境变量写法（Python / Node 均适用）：</div>
                <pre className="code">{`OTEL_EXPORTER_OTLP_ENDPOINT = "${baseUrl}/api/public/otel/v1/traces"
OTEL_EXPORTER_OTLP_HEADERS  = "Authorization=Basic <BASE64(pk:sk)>"
OTEL_SERVICE_NAME           = "my-agent"`}</pre>
                <div className="muted" style={{ marginTop: 8 }}>
                  本地调试设 <span className="mono">MACHORA_AUTH_DISABLED=true</span> 免认证
                  （数据写默认项目，<span className="text-danger">仅限本地</span>）。
                  <span className="text-danger">注意</span>：端点须为完整路径（部分 exporter 不自动拼接
                  /v1/traces）；进程结束前等待 BatchSpanProcessor flush。
                </div>
              </div>
            </div>

            {/* ---------- 零埋点框架接入 ---------- */}
            <div id="agents-zero" className="docs-section">
              <div className="section-title">2.1 零埋点框架接入（自带 OTel 打点）</div>
              <div className="card">
                <div className="muted" style={{ marginBottom: 8 }}>
                  框架/库自身发射 OTel span（OpenInference / gen_ai.* / langfuse 语义），
                  Machora 接入层归一化后落库，仅需配置端点与认证（同 2.0）。可运行示例见{" "}
                  <span className="mono">examples/</span>。
                </div>
                <div className="label" style={{ marginBottom: 4 }}>OpenLLMetry（traceloop-sdk · 100+ 集成一键打点）</div>
                <pre className="code">{`Traceloop.init(app_name="my-agent",
    api_endpoint="${baseUrl}/api/public/otel",           # 自动拼接 /v1/traces
    headers={"Authorization": "Basic <base64(pk:sk)>"},
    telemetry_enabled=False)`}</pre>
                <div className="label" style={{ margin: "12px 0 4px" }}>LangChain / LangGraph（examples/langchain-agent · gen_ai.*）</div>
                <pre className="code">{`$env:LANGSMITH_TRACING = "true"
$env:LANGSMITH_TRACING_MODE = "otel"
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "${baseUrl}/api/public/otel/v1/traces"
$env:OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic <base64(pk:sk)>"
python agent.py`}</pre>
                <div className="label" style={{ margin: "12px 0 4px" }}>LlamaIndex（examples/llamaindex-agent · OpenInference 语义）</div>
                <pre className="code">{`LlamaIndexInstrumentor().instrument(tracer_provider=provider)   # OTLPSpanExporter 同 2.0`}</pre>
                <div className="label" style={{ margin: "12px 0 4px" }}>LoongSuite（examples/loongsuite-agent · gen_ai.span.kind）</div>
                <pre className="code">{`export OTEL_EXPORTER_OTLP_ENDPOINT=${baseUrl}/api/public/otel/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <b64(pk:sk)>
python agent.py`}</pre>
                <div className="label" style={{ margin: "12px 0 4px" }}>JiuwenSwarm（九问 · 须配置文件，走 langfuse 兼容键）</div>
                <pre className="code">{`# ~/.jiuwenswarm/config/config.yaml
team_observability:
  enabled: true
  exporter: otlp_http
  endpoint: "${baseUrl}/api/public/otel/v1/traces"
  langfuse_public_key: "${publicKey}"
  langfuse_secret_key: "${secretKey}"`}</pre>
                <div className="label" style={{ margin: "12px 0 4px" }}>π-Agent（标准 OTel · openinference.span.kind 手写 span）</div>
                <pre className="code">{`with tracer.start_as_current_span("pi.main") as s:
    s.set_attribute("openinference.span.kind", "AGENT")
    s.set_attribute("agent.name", "PiScheduler")`}</pre>
              </div>
            </div>

            {/* ---------- Machora 原生探针 ---------- */}
            <div id="agents-probes" className="docs-section">
              <div className="section-title">2.2 Machora 原生探针（machora.* 最高优先级）</div>
              <div className="card" style={{ marginBottom: "0.75rem" }}>
                <div className="muted" style={{ marginBottom: 8 }}>
                  仓库维护的探针直接输出 <span className="mono">machora.*</span> 语义键，接入层
                  machora adapter（最高优先级）<b>直接落库</b> observation.type 与专用字段，无第三方
                  语义依赖；全部 fail-open（SDK 缺失或端点不可用时静默禁用）。
                </div>
                <div className="label" style={{ marginBottom: 4 }}>Python SDK（LangChain / LangGraph）</div>
                <pre className="code">{`pip install 'machora-sdk[otel]'

from machora.otel import MachoraOtelCallbackHandler, MachoraOtelGraphProbe

# LangChain：CallbackHandler（根 chain→ENTRY、agent 链→AGENT、子链→CHAIN、LLM/TOOL/RETRIEVER）
handler = MachoraOtelCallbackHandler()
CallbackManager.configure(handlers=[handler])

# LangGraph：图级探针（graph→ENTRY、agent 节点→AGENT、其余→STEP）
probe = MachoraOtelGraphProbe()
graph = probe.wrap(graph)
probe.invoke(graph, {"messages": [...]})`}</pre>
                <div className="muted" style={{ margin: "6px 0 4px" }}>
                  环境变量：<span className="mono">MACHORA_OTEL_ENDPOINT</span> /{" "}
                  <span className="mono">MACHORA_OTEL_HEADERS</span>（JSON 对象）/{" "}
                  <span className="mono">MACHORA_OTEL_SERVICE_NAME</span>。
                </div>
              </div>

              <div className="card" style={{ marginBottom: "0.75rem" }}>
                <div className="label" style={{ marginBottom: 4 }}>Hermes 探针（examples/hermes-agent/otel_machora）</div>
                <div className="muted" style={{ marginBottom: 8 }}>
                  面向 Hermes Agent 的 OTel 插件：session→<span className="badge entry">ENTRY</span>、
                  turn→<span className="badge step">STEP</span>、subagent→<span className="badge agent">AGENT</span>、
                  llm→<span className="badge llm">LLM</span>、tool→<span className="badge tool">TOOL</span>。
                </div>
                <pre className="code">{`pip install 'hermes-agent[otlp]'
hermes plugins enable observability/otel_machora

export HERMES_OTEL_MACHORA_ENDPOINT=${baseUrl}/api/public/otel/v1/traces
export HERMES_OTEL_MACHORA_HEADERS=Authorization=Basic <base64(pk:sk)>`}</pre>
              </div>

              <div className="card">
                <div className="label" style={{ marginBottom: 4 }}>OpenClaw 插件（examples/openclaw）</div>
                <div className="muted" style={{ marginBottom: 8 }}>
                  OpenClaw 原生插件：harness.run→<span className="badge entry">ENTRY</span>、
                  run→<span className="badge agent">AGENT</span>、model.call→<span className="badge llm">LLM</span>、
                  tool.execution→<span className="badge tool">TOOL</span>，span 带 session.id 关联。
                </div>
                <pre className="code">{`openclaw plugins install <repo>/examples/openclaw

# openclaw.json（captureContent 必须开启，否则无 input/output 内容）
{
  "diagnostics": { "otel": { "enabled": true, "traces": true, "captureContent": true } },
  "plugins": { "entries": {
    "machora-openinference": { "config": {
      "endpoint": "${baseUrl}/api/public/otel/v1/traces",
      "headers": { "Authorization": "Basic <BASE64(pk:sk)>" }
    } }
  } }
}`}</pre>
              </div>
            </div>


          </section>

          {/* ===================== 三、语义规范 ===================== */}
          <section className="docs-section" id="semantics">
            <div className="section-title">三、语义规范（Semantic Conventions）</div>
            <div className="docs-subtitle">
              所有来源经 <b>统一语义接入层</b>（<span className="mono">packages/shared/src/otel/semantics/</span>）
              归一化到统一模型后落库：Machora / Langfuse / OpenTelemetry GenAI / OpenInference /
              LoongSuite 各一套 adapter（注册表见 <span className="mono">adapters.ts</span>），
              按优先级合并；<span className="mono">processor.ts</span> 只消费归一化结果，不再感知具体键。
            </div>

            {/* ---------- Machora 语义规范 ---------- */}
            <div id="semantics-machora" className="docs-section">
              <div className="section-title">3.0 Machora 语义规范（推荐 · machora.*）</div>
              <div className="card">
                <div className="muted" style={{ marginBottom: 8 }}>
                  Machora 自有的推荐语义（<span className="mono">machora.*</span>），参考 LoongSuite
                  （ENTRY / STEP 等 Agent 角色）与 OpenInference（CHAIN / RETRIEVER 等）设计：
                  一套与具体框架无关、粒度统一的语义。接入时直接写这些键即可获得完整分类与字段提取，
                  无需依赖任何第三方语义约定。<b>observation.type 落库值与 span.kind 一一对应</b>
                  （无角色/UNKNOWN 落库为 SPAN），渲染层按 type 直接分类，不再从 metadata 反推；
                  显式 <span className="mono">machora.observation.type</span>（接受 span.kind 值，兼容旧三值）优先级最高。
                </div>
                <div className="label" style={{ marginBottom: 4 }}>span.kind 角色枚举（type 落库值与之一致）</div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">machora.span.kind</th>
                        <th scope="col">含义</th>
                        <th scope="col">observation.type（落库值）</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="mono">ENTRY</td>
                        <td className="muted">Agent 调用入口（还原最原始输入输出）</td>
                        <td><span className="badge entry">ENTRY</span></td>
                      </tr>
                      <tr>
                        <td className="mono">AGENT</td>
                        <td className="muted">Agent 本体</td>
                        <td><span className="badge agent">AGENT</span></td>
                      </tr>
                      <tr>
                        <td className="mono">STEP</td>
                        <td className="muted">ReAct 单轮循环</td>
                        <td><span className="badge step">STEP</span></td>
                      </tr>
                      <tr>
                        <td className="mono">LLM</td>
                        <td className="muted">模型调用</td>
                        <td><span className="badge llm">LLM</span></td>
                      </tr>
                      <tr>
                        <td className="mono">TOOL</td>
                        <td className="muted">工具调用（可挂 skillName）</td>
                        <td><span className="badge tool">TOOL</span></td>
                      </tr>
                      <tr>
                        <td className="mono">EMBEDDING</td>
                        <td className="muted">嵌入调用</td>
                        <td><span className="badge embedding">EMBEDDING</span></td>
                      </tr>
                      <tr>
                        <td className="mono">CHAIN</td>
                        <td className="muted">工作流 / 链条</td>
                        <td><span className="badge chain">CHAIN</span></td>
                      </tr>
                      <tr>
                        <td className="mono">RETRIEVER</td>
                        <td className="muted">RAG 检索</td>
                        <td><span className="badge retriever">RETRIEVER</span></td>
                      </tr>
                      <tr>
                        <td className="mono">RERANKER</td>
                        <td className="muted">重排</td>
                        <td><span className="badge reranker">RERANKER</span></td>
                      </tr>
                      <tr>
                        <td className="mono">EVENT</td>
                        <td className="muted">日志 / 事件</td>
                        <td><span className="badge event">EVENT</span></td>
                      </tr>
                      <tr>
                        <td className="mono">（无角色 / UNKNOWN）</td>
                        <td className="muted">通用节点</td>
                        <td><span className="badge span">SPAN</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="label" style={{ margin: "12px 0 4px" }}>关键属性</div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">属性</th>
                        <th scope="col">提取字段</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="mono">machora.model.name / token.input / token.output / token.total / cost.total</td>
                        <td className="mono">model · inputTokens · outputTokens · totalTokens · totalCost</td>
                      </tr>
                      <tr>
                        <td className="mono">machora.input / output（JSON 字符串或对象）</td>
                        <td className="mono">observation.input / output（JSON 自动解码）</td>
                      </tr>
                      <tr>
                        <td className="mono">machora.tool.name / tool.call.id</td>
                        <td className="mono">observation.name（工具节点名）· toolCallId</td>
                      </tr>
                      <tr>
                        <td className="mono">machora.agent.name / workflow.name / skill.name</td>
                        <td className="mono">agentName · workflowName · skillName</td>
                      </tr>
                      <tr>
                        <td className="mono">machora.user.id / session.id</td>
                        <td className="mono">trace.userId · trace.sessionId</td>
                      </tr>
                      <tr>
                        <td className="mono">machora.trace.name / tags / metadata / level</td>
                        <td className="mono">trace.name · tags · metadata · observation.level</td>
                      </tr>
                      <tr>
                        <td className="mono">machora.observation.type</td>
                        <td className="mono">显式覆盖 type（span.kind 值；langfuse.observation.type=GENERATION 映射为 LLM）</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div id="semantics-type" className="docs-section">
              <div className="section-title">3.1 Observation 类型判定（type 与 span.kind 一致）</div>
              <div className="card">
                <div className="muted" style={{ marginBottom: 8 }}>
                  observation.type 由语义接入层归一化的 <span className="mono">span.kind</span>{" "}
                  一一映射后<b>直接落库</b>：ENTRY / AGENT / STEP / LLM / TOOL / EMBEDDING / CHAIN /
                  RETRIEVER / RERANKER / EVENT 原样写入，无角色（UNKNOWN）→ <span className="badge span">SPAN</span>。
                  渲染层按 type 直接分类。判定流程（优先级从高到低）：
                </div>
                <ol className="muted" style={{ margin: 0, paddingLeft: 20 }}>
                  <li>
                    <span className="mono">machora.observation.type</span> 显式指定（Machora 原生，最高）→
                    接受 span.kind 值直接落库
                  </li>
                  <li>
                    <span className="mono">langfuse.observation.type</span> 显式指定（Langfuse 兼容）→
                    <span className="mono">GENERATION→LLM</span> / <span className="mono">EVENT</span> /{" "}
                    <span className="mono">SPAN</span>
                  </li>
                  <li>
                    各来源 <span className="mono">span.kind</span> 显式枚举（<span className="mono">machora.span.kind</span>{" "}
                    / <span className="mono">openinference.span.kind</span> / <span className="mono">gen_ai.span.kind</span>）
                    → 归一化后原样落库（LLM→LLM、TOOL→TOOL、…）
                  </li>
                  <li>
                    <span className="mono">gen_ai.operation.name</span> 推断：chat / completion / generate* →{" "}
                    <span className="badge llm">LLM</span>；embeddings →{" "}
                    <span className="badge embedding">EMBEDDING</span>；entry / invoke_agent →{" "}
                    <span className="badge entry">ENTRY</span> / <span className="badge agent">AGENT</span>；react_step / plan →{" "}
                    <span className="badge step">STEP</span>；invoke_workflow →{" "}
                    <span className="badge chain">CHAIN</span>；retrieval →{" "}
                    <span className="badge retriever">RETRIEVER</span>；rerank →{" "}
                    <span className="badge reranker">RERANKER</span>
                  </li>
                  <li>
                    <span className="mono">gen_ai.tool.name</span> / <span className="mono">gen_ai.tool.call.id</span>{" "}
                    存在 → <span className="badge tool">TOOL</span>
                  </li>
                  <li>兜底（无任何语义）→ <span className="badge span">SPAN</span></li>
                </ol>
              </div>
            </div>

            <div id="semantics-attr" className="docs-section">
              <div className="section-title">3.2 属性 → 专用字段映射</div>
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
                      <td className="mono">gen_ai.input.messages / gen_ai.tool.call.arguments / gen_ai.prompt / input.value</td>
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
            </div>

            <div id="semantics-loongsuite" className="docs-section">
              <div className="section-title">3.3 LoongSuite gen_ai.span.kind（Agent 行为角色 · type 落库值与之一致）</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">span.kind</th>
                      <th scope="col">含义</th>
                      <th scope="col">observation.type（落库值）</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="mono">ENTRY</td>
                      <td className="muted">Agent 调用入口，还原最原始的模型/用户输入输出</td>
                      <td><span className="badge entry">ENTRY</span></td>
                    </tr>
                    <tr>
                      <td className="mono">AGENT</td>
                      <td className="muted">Agent 本体</td>
                      <td><span className="badge agent">AGENT</span></td>
                    </tr>
                    <tr>
                      <td className="mono">STEP</td>
                      <td className="muted">ReAct 单轮循环（反思 → 工具调用 → 模型调用）</td>
                      <td><span className="badge step">STEP</span></td>
                    </tr>
                    <tr>
                      <td className="mono">LLM</td>
                      <td className="muted">模型调用</td>
                      <td><span className="badge llm">LLM</span></td>
                    </tr>
                    <tr>
                      <td className="mono">TOOL</td>
                      <td className="muted">工具调用（execute_tool，可挂 gen_ai.skill.*）</td>
                      <td><span className="badge tool">TOOL</span></td>
                    </tr>
                    <tr>
                      <td className="mono">EMBEDDING</td>
                      <td className="muted">嵌入调用</td>
                      <td><span className="badge embedding">EMBEDDING</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div id="semantics-operation" className="docs-section">
              <div className="section-title">3.4 gen_ai.operation.name（操作枚举）</div>
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
                      <td className="muted">模型生成 → <span className="badge llm">LLM</span> / 嵌入 → <span className="badge embedding">EMBEDDING</span></td>
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
            </div>

            <div id="semantics-metadata" className="docs-section">
              <div className="section-title">3.5 metadata 保留规则</div>
              <div className="card">
                <div className="muted">
                  被提取为专用字段的属性不再进 metadata；前缀{" "}
                  <span className="mono">gen_ai.prompt</span> / <span className="mono">gen_ai.completion</span>{" "}
                  / <span className="mono">llm.</span> / <span className="mono">openinference.</span> /{" "}
                  <span className="mono">embedding.</span> 会从 metadata 剔除（避免噪声）；其余原始属性与
                  resource 资源属性保留在 <span className="mono">observation.metadata</span>。
                  <b>例外</b>：<span className="mono">gen_ai.span.kind</span> /{" "}
                  <span className="mono">gen_ai.operation.name</span> / <span className="mono">gen_ai.tool.name</span>{" "}
                  / <span className="mono">gen_ai.tool.call.id</span>（及 <span className="mono">machora.span.kind</span>{" "}
                  等）虽已归一化到 <span className="mono">type</span> 落库，仍保留在 metadata，
                  供 SPAN 通用节点的轨迹角色反推与审计使用。
                </div>
              </div>
            </div>

            <div id="semantics-trajectory" className="docs-section">
              <div className="section-title">3.6 轨迹视图（推理轨迹）角色分类</div>
              <div className="muted mb-1">
                trace 详情页「轨迹」tab 把 observation 按行为角色重组为主链视图；分类实现见{" "}
                <span className="mono">packages/shared/src/otel/trajectory.ts</span>。
                <b>新数据 type 已与 span.kind 一致直接落库，按 type 直接映射</b>；仅 SPAN
                 （无角色通用节点）回退到 metadata.gen_ai.span.kind / operation / 专用列反推。
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
                      <td className="muted">type=ENTRY；或根 SPAN（无父）且无其它语义（旧数据）</td>
                    </tr>
                    <tr>
                      <td className="mono">agent</td>
                      <td className="muted">type=AGENT / 旧数据：span.kind=AGENT / operation=invoke_agent|create_agent|entry / agentName 列</td>
                    </tr>
                    <tr>
                      <td className="mono">workflow 工作流</td>
                      <td className="muted">type=CHAIN / 旧数据：operation=invoke_workflow|create_workflow / workflowName 列</td>
                    </tr>
                    <tr>
                      <td className="mono">think 思考</td>
                      <td className="muted">type=STEP / 旧数据：span.kind=STEP / operation=react_step|plan</td>
                    </tr>
                    <tr>
                      <td className="mono">llm 模型</td>
                      <td className="muted">type=LLM / SPAN 反推：span.kind=LLM / operation=chat|completion|generate*</td>
                    </tr>
                    <tr>
                      <td className="mono">tool 工具</td>
                      <td className="muted">type=TOOL / 旧数据：span.kind=TOOL / metadata 含 gen_ai.tool.name</td>
                    </tr>
                    <tr>
                      <td className="mono">retrieval 检索</td>
                      <td className="muted">type=RETRIEVER|RERANKER / 旧数据：operation=retrieval|rerank</td>
                    </tr>
                    <tr>
                      <td className="mono">memory 记忆</td>
                      <td className="muted">旧数据：operation=create/search/upsert/update/get/delete_memory、memory</td>
                    </tr>
                    <tr>
                      <td className="mono">skill 技能</td>
                      <td className="muted">旧数据：operation=invoke_skill|create_skill|skill / skillName 列</td>
                    </tr>
                    <tr>
                      <td className="mono">embedding 嵌入</td>
                      <td className="muted">type=EMBEDDING / 旧数据：span.kind=EMBEDDING / operation=embeddings / model 含 embed</td>
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
            </div>
          </section>

          <div className="muted" style={{ marginTop: "1rem" }}>
            更多可运行示例（LangChain / LlamaIndex / LoongSuite / Hermes / OpenClaw 探针完整脚本）见仓库{" "}
            <span className="mono">examples/</span> 目录；OTLP 捕获 &amp; 解码辅助工具见{" "}
            <span className="mono">scripts/capture-otel.mjs / decode-otel-fixture.mjs</span>。{" "}
            <Link href="/traces" prefetch={false}>查看 Traces →</Link>
          </div>
        </div>
      </div>
    </>
  );
}

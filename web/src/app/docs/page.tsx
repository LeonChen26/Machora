import { Link } from "../../components/NativeLink";
import { requireUser } from "../../server/session";

export const dynamic = "force-dynamic";

export default async function DocsPage() {
  await requireUser();
  const port = process.env.PORT ?? "3000";
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
              <td className="muted">type ∈ span / generation / event</td>
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
          "type": "generation",
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
          "source": "HUMAN",
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
    </>
  );
}

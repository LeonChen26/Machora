import { Link } from "../../components/NativeLink";

export const dynamic = "force-dynamic";

export default function DocsPage() {
  const port = process.env.PORT ?? "3000";
  const publicKey = process.env.MACHORA_INIT_PROJECT_PUBLIC_KEY ?? "pk-machora-dev-000000000000000000000";
  const secretKey = process.env.MACHORA_INIT_PROJECT_SECRET_KEY ?? "sk-machora-dev-000000000000000000000";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>接入文档</h1>
          <div className="sub">通过 REST API 注入 trace / observation / score</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
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
              <th>type</th>
              <th>关键字段</th>
              <th>说明</th>
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
              <th>方法</th>
              <th>路径</th>
              <th>说明</th>
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
          </tbody>
        </table>
      </div>

      <div className="muted" style={{ marginTop: "1rem" }}>
        <Link href="/traces" prefetch={false}>查看 Traces →</Link>
      </div>
    </>
  );
}

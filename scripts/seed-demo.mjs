// Machora 演示数据注入脚本
// 用法: node scripts/seed-demo.mjs [baseUrl]
// 生成近 7 天的 traces / observations / scores，通过 ingestion API 注入

const BASE = process.argv[2] ?? "http://localhost:3100";
const PUBLIC_KEY = "pk-machora-dev-000000000000000000000";
const SECRET_KEY = "sk-machora-dev-000000000000000000000";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
let seq = 0;
const nextId = (p) => `demo-${p}-${++seq}`;

function at(daysAgo, hour, minute = 0) {
  const d = new Date(now.getTime() - daysAgo * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const batch = [];

function pushTrace(daysAgo, hour, name, opts = {}) {
  const t = at(daysAgo, hour);
  const id = nextId("trace");
  batch.push({
    type: "trace-create",
    body: {
      id,
      name,
      timestamp: t.toISOString(),
      environment: opts.env ?? "production",
      userId: opts.userId ?? "user-1001",
      sessionId: opts.sessionId ?? `sess-${daysAgo}`,
      tags: opts.tags ?? [],
      input: opts.input,
      output: opts.output,
      metadata: opts.metadata ?? { channel: "api" },
    },
  });
  return id;
}

function pushGeneration(traceId, start, durationMs, opts = {}) {
  batch.push({
    type: "observation-create",
    body: {
      id: nextId("obs"),
      traceId,
      type: "LLM",
      name: opts.name ?? "llm-call",
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + durationMs).toISOString(),
      model: opts.model ?? "gpt-4o-mini",
      level: opts.level ?? "DEFAULT",
      usage: opts.usage,
      input: opts.input ?? {
        messages: [{ role: "user", content: "请介绍一下 Machora 的核心能力" }],
      },
      output: opts.output ?? {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Machora 是一个面向 LLM 应用的轻量可观测平台，支持 traces、observations 与 scores。",
            },
          },
        ],
      },
    },
  });
}

function pushSpan(traceId, start, durationMs, name) {
  batch.push({
    type: "observation-create",
    body: {
      id: nextId("obs"),
      traceId,
      type: "SPAN",
      name,
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + durationMs).toISOString(),
      metadata: { kind: "tool-call" },
    },
  });
}

function pushEvent(traceId, start, name, opts = {}) {
  batch.push({
    type: "observation-create",
    body: {
      id: nextId("obs"),
      traceId,
      type: "EVENT",
      name,
      startTime: start.toISOString(),
      metadata: opts.metadata,
    },
  });
}

function pushScore(traceId, name, value, opts = {}) {
  batch.push({
    type: "score-create",
    body: {
      id: nextId("score"),
      traceId,
      name,
      value,
      dataType: opts.dataType ?? "NUMERIC",
      source: opts.source ?? "API",
      comment: opts.comment,
    },
  });
}

// ---- 近 7 天数据 ----

// 7/26：1 条 trace + 1 次 generation
{
  const id = pushTrace(6, 10, "keyword-search", { userId: "user-1002", tags: ["search"] });
  pushGeneration(id, at(6, 10, 2), 480, {
    name: "embedding",
    usage: { prompt_tokens: 1250, completion_tokens: 0, total_tokens: 1250 },
  });
}

// 7/27：1 条 trace + 1 个 span
{
  const id = pushTrace(5, 14, "data-prep", { env: "staging", tags: ["batch"] });
  pushSpan(id, at(5, 14, 1), 2300, "load-and-transform");
}

// 7/28：2 条 trace，带 score
{
  const id = pushTrace(4, 9, "summarize-doc");
  pushGeneration(id, at(4, 9, 1), 1250, {
    model: "claude-3-5-sonnet",
    name: "summarize",
    usage: { input_tokens: 4800, output_tokens: 420, total_tokens: 5220 },
  });
  pushScore(id, "helpfulness", 0.95, { source: "ANNOTATION", comment: "摘要准确" });

  const id2 = pushTrace(4, 20, "rag-answer", { userId: "user-1003", tags: ["rag"] });
  pushGeneration(id2, at(4, 20, 3), 820, {
    model: "gpt-4o-mini",
    name: "retrieve-and-generate",
    usage: { prompt_tokens: 2600, completion_tokens: 180, total_tokens: 2780 },
  });
  pushScore(id2, "helpfulness", 0.8, { source: "ANNOTATION" });
}

// 7/29：1 条慢 generation（WARNING）
{
  const id = pushTrace(3, 15, "long-context-query");
  pushGeneration(id, at(3, 15, 2), 4200, {
    model: "claude-3-5-sonnet",
    level: "WARNING",
    name: "long-generation",
    usage: { input_tokens: 15000, output_tokens: 600, total_tokens: 15600 },
  });
  pushScore(id, "accuracy", 0.72, { comment: "长上下文下偶发偏差" });
}

// 7/30：span + event
{
  const id = pushTrace(2, 11, "multi-step-agent", { userId: "user-1004", tags: ["agent"] });
  pushSpan(id, at(2, 11, 1), 950, "tool:calculator");
  pushEvent(id, at(2, 11, 5), "retry-detected", { metadata: { attempts: 2 } });
}

// 7/31：2 条 trace
{
  const id = pushTrace(1, 8, "morning-briefing");
  pushGeneration(id, at(1, 8, 1), 640, {
    model: "deepseek-chat",
    usage: { prompt_tokens: 900, completion_tokens: 350, total_tokens: 1250 },
  });
  pushScore(id, "quality", 0.88, { source: "ANNOTATION" });

  const id2 = pushTrace(1, 22, "night-batch-summary", { env: "staging", tags: ["batch"] });
  pushGeneration(id2, at(1, 22, 1), 980, {
    model: "gpt-4o-mini",
    usage: { prompt_tokens: 3200, completion_tokens: 800, total_tokens: 4000 },
  });
}

// 8/1（今天）：1 条完整链路 + 2 个 score（含 BOOLEAN）
{
  const id = pushTrace(0, 9, "chat-assistant-demo", { userId: "user-1001", tags: ["chat"] });
  pushGeneration(id, at(0, 9, 2), 1300, {
    model: "gpt-4o-mini",
    usage: { prompt_tokens: 750, completion_tokens: 310, total_tokens: 1060 },
    input: { messages: [{ role: "user", content: "帮我写一段接入 Machora 的代码" }] },
    output: {
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "使用 Machora SDK 或直接 POST /api/public/ingestion 即可注入 trace 数据。",
          },
        },
      ],
    },
  });
  pushSpan(id, at(0, 9, 4), 210, "validate-api-key");
  pushScore(id, "helpfulness", 0.92, { source: "ANNOTATION", comment: "回答完整" });
  pushScore(id, "cached", 1, { dataType: "BOOLEAN", source: "API" });
}

console.log(`注入 ${batch.length} 条事件到 ${BASE}/api/public/ingestion ...`);
const res = await fetch(`${BASE}/api/public/ingestion`, {
  method: "POST",
  headers: {
    authorization:
      "Basic " + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64"),
    "content-type": "application/json",
  },
  body: JSON.stringify({ batch }),
});
const body = await res.json();
console.log(`HTTP ${res.status}`, JSON.stringify(body, null, 2));
if (body.errors?.length) {
  console.error("部分事件失败:", body.errors);
  process.exitCode = 1;
}

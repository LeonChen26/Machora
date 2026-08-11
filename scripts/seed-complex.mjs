// Machora 复杂 trace 注入脚本（嵌套调用树演示）
// 用法: node scripts/seed-complex.mjs [baseUrl]
// 注入 4 条复杂 trace：深度客服链 / 并行 RAG / 多轮对话 / 批量+错误重试
// 依赖 ingestion 的 parentObservationId 支持（嵌套调用树）

const BASE = process.argv[2] ?? "http://localhost:3100";
const PUBLIC_KEY = "pk-machora-dev-000000000000000000000";
const SECRET_KEY = "sk-machora-dev-000000000000000000000";

const batch = [];
const push = (e) => batch.push(e);

const USER = (c) => ({ messages: [{ role: "user", content: c }] });
const ASSIST = (c) => ({ choices: [{ message: { role: "assistant", content: c } }] });

// 相对 trace 时间戳的 Date 构造器
function rel(ts, ms) {
  return new Date(ts.getTime() + ms).toISOString();
}

// =====================================================================
// Trace 1: deep-agent-support —— 4 层深客服链：ERROR + 重试 + WARNING + 升级
// =====================================================================
{
  const traceId = "cx-deep-agent-1";
  const ts = new Date(Date.now() - 2 * 3600 * 1000);
  push({
    type: "trace-create",
    body: {
      id: traceId, name: "deep-agent-support", timestamp: ts.toISOString(),
      environment: "production", userId: "user-9001", sessionId: "sess-cx-1",
      agentName: "SupportAgent", tags: ["support", "refund"],
      input: USER("订单 12345 申请退款，但系统说查不到订单"),
      output: ASSIST("已升级人工客服处理退款事宜。"),
    },
  });
  const entry = "cx-o-11", intent = "cx-o-12", cls = "cx-o-13",
    refund = "cx-o-14", q1 = "cx-o-15", q2 = "cx-o-16",
    analyze = "cx-o-17", ev = "cx-o-18", esc = "cx-o-19",
    draft = "cx-o-20", notify = "cx-o-21";
  const O = (id2, opts) =>
    push({ type: "observation-create", body: { id: id2, traceId, ...opts } });

  O(entry, { type: "SPAN", name: "entry", startTime: rel(ts, 0), endTime: rel(ts, 3800), metadata: { kind: "agent-entry" } });
  O(intent, { type: "SPAN", name: "agent:intent-classify", startTime: rel(ts, 10), endTime: rel(ts, 450), parentObservationId: entry });
  O(cls, {
    type: "LLM", name: "llm:intent", startTime: rel(ts, 20), endTime: rel(ts, 400),
    parentObservationId: intent, model: "gpt-4o-mini",
    usage: { prompt_tokens: 620, completion_tokens: 230, total_tokens: 850 },
    input: USER("订单 12345 申请退款，但系统说查不到订单"),
    output: ASSIST("意图=退款；置信度 0.92"),
  });
  O(refund, { type: "SPAN", name: "agent:refund-handler", startTime: rel(ts, 500), endTime: rel(ts, 3100), parentObservationId: entry });
  O(q1, {
    type: "SPAN", name: "tool:query-order", startTime: rel(ts, 520), endTime: rel(ts, 800),
    parentObservationId: refund, level: "ERROR",
    input: { orderId: "12345" }, output: { error: "order_not_found" },
    metadata: { errorType: "OrderNotFound" },
  });
  O(q2, {
    type: "SPAN", name: "tool:retry-query-order", startTime: rel(ts, 900), endTime: rel(ts, 1500),
    parentObservationId: refund, level: "WARNING",
    input: { orderId: "12345", retry: true }, output: { order: { id: "12345", status: "delivered", amount: 299.0 } },
    metadata: { attempts: 2 },
  });
  O(analyze, {
    type: "LLM", name: "llm:refund-analyze", startTime: rel(ts, 1550), endTime: rel(ts, 2650),
    parentObservationId: refund, model: "claude-3-5-sonnet",
    usage: { prompt_tokens: 1900, completion_tokens: 500, total_tokens: 2400 },
    input: USER("订单已签收，用户申请退款，是否符合退货政策？"),
    output: ASSIST("已签收且超退货期，建议转人工客服处理。"),
  });
  O(ev, { type: "EVENT", name: "event:low-confidence", startTime: rel(ts, 1700), parentObservationId: analyze, level: "WARNING", metadata: { confidence: 0.41 } });
  O(esc, { type: "SPAN", name: "agent:escalate", startTime: rel(ts, 2700), endTime: rel(ts, 3600), parentObservationId: refund });
  O(draft, {
    type: "LLM", name: "llm:draft-escalation", startTime: rel(ts, 2720), endTime: rel(ts, 3170),
    parentObservationId: esc, model: "gpt-4o",
    usage: { prompt_tokens: 420, completion_tokens: 200, total_tokens: 620 },
    input: USER("生成人工客服工单内容"), output: ASSIST("工单：退款超期申请，需要人工复核。"),
  });
  O(notify, { type: "SPAN", name: "tool:notify-human", startTime: rel(ts, 3200), endTime: rel(ts, 3500), parentObservationId: esc, skillName: "notify" });

  push({ type: "score-create", body: { traceId, name: "helpfulness", value: 0.85, dataType: "NUMERIC", source: "ANNOTATION", comment: "处理完整" } });
  push({ type: "score-create", body: { traceId, name: "escalated", value: 1, dataType: "BOOLEAN", source: "API" } });
}

// =====================================================================
// Trace 2: rag-pipeline-parallel —— 并行 fan-out 检索 + rerank + 大成本 LLM
// =====================================================================
{
  const traceId = "cx-rag-parallel-1";
  const ts = new Date(Date.now() - 50 * 60 * 1000);
  push({
    type: "trace-create",
    body: {
      id: traceId, name: "rag-pipeline-parallel", timestamp: ts.toISOString(),
      environment: "production", userId: "user-9002", sessionId: "sess-cx-2",
      agentName: "RagAgent", tags: ["rag", "retrieval"],
      input: USER("对比 Q3 各产品线收入增长情况"),
      output: ASSIST("Q3 云业务增长 22%，企业服务增长 15%……"),
    },
  });
  const entry = "cx-o-31", retr = "cx-o-32", emb = "cx-o-33",
    va = "cx-o-34", vb = "cx-o-35", kw = "cx-o-36",
    rk = "cx-o-37", ans = "cx-o-38";
  const O = (id2, opts) => push({ type: "observation-create", body: { id: id2, traceId, ...opts } });

  O(entry, { type: "SPAN", name: "entry", startTime: rel(ts, 0), endTime: rel(ts, 2400) });
  O(retr, { type: "SPAN", name: "agent:retrieve", startTime: rel(ts, 20), endTime: rel(ts, 1400), parentObservationId: entry });
  O(emb, {
    type: "EMBEDDING", name: "embed:query", startTime: rel(ts, 30), endTime: rel(ts, 150),
    parentObservationId: retr, model: "text-embedding-3-small",
    usage: { prompt_tokens: 256, completion_tokens: 0, total_tokens: 256 },
    input: USER("Q3 产品线收入增长"), output: { embedding: { dim: 1536, truncated: true } },
  });
  // 三个并行检索（时间重叠）
  O(va, { type: "SPAN", name: "vector:search-tenant-a", startTime: rel(ts, 180), endTime: rel(ts, 680), parentObservationId: retr, metadata: { topK: 5 } });
  O(vb, { type: "SPAN", name: "vector:search-tenant-b", startTime: rel(ts, 180), endTime: rel(ts, 800), parentObservationId: retr, metadata: { topK: 5 } });
  O(kw, { type: "SPAN", name: "keyword:search", startTime: rel(ts, 180), endTime: rel(ts, 530), parentObservationId: retr });
  O(rk, { type: "SPAN", name: "rerank", startTime: rel(ts, 900), endTime: rel(ts, 1280), parentObservationId: retr, metadata: { candidates: 15, keep: 4 } });
  O(ans, {
    type: "LLM", name: "llm:answer", startTime: rel(ts, 1450), endTime: rel(ts, 2300),
    parentObservationId: entry, model: "gpt-4o",
    usage: { prompt_tokens: 4800, completion_tokens: 800, total_tokens: 5600 },
    input: USER("基于检索结果回答：Q3 各产品线收入增长"), output: ASSIST("云业务 22%、企业服务 15%、广告 8%。"),
  });

  push({ type: "score-create", body: { traceId, name: "faithfulness", value: 0.92, dataType: "NUMERIC", source: "ANNOTATION" } });
  push({ type: "score-create", body: { traceId, name: "latency_ok", value: 1, dataType: "BOOLEAN", source: "API" } });
}

// =====================================================================
// Trace 3: multi-turn-chat —— 多轮对话（对话视图展示）+ tool 调用
// =====================================================================
{
  const traceId = "cx-chat-multi-1";
  const ts = new Date(Date.now() - 8 * 60 * 1000);
  push({
    type: "trace-create",
    body: {
      id: traceId, name: "multi-turn-chat", timestamp: ts.toISOString(),
      environment: "production", userId: "user-9003", sessionId: "sess-cx-3",
      agentName: "ChatAgent", tags: ["chat", "web"],
      input: USER("帮我查一下最近科技新闻"),
    },
  });
  const entry = "cx-o-51", chat = "cx-o-52", t1 = "cx-o-53",
    web = "cx-o-54", t2 = "cx-o-55", t3 = "cx-o-56";
  const O = (id2, opts) => push({ type: "observation-create", body: { id: id2, traceId, ...opts } });

  O(entry, { type: "SPAN", name: "entry", startTime: rel(ts, 0), endTime: rel(ts, 9000) });
  O(chat, { type: "SPAN", name: "agent:chat", startTime: rel(ts, 10), endTime: rel(ts, 8900), parentObservationId: entry });
  O(t1, {
    type: "LLM", name: "llm:turn-1", startTime: rel(ts, 20), endTime: rel(ts, 800),
    parentObservationId: chat, model: "deepseek-chat",
    usage: { prompt_tokens: 450, completion_tokens: 250, total_tokens: 700 },
    input: { messages: [{ role: "user", content: "帮我查一下最近科技新闻" }] },
    output: { choices: [{ message: { role: "assistant", content: "好的，我先搜索一下近期科技新闻。" } }] },
  });
  O(web, { type: "SPAN", name: "tool:search-web", startTime: rel(ts, 30), endTime: rel(ts, 300), parentObservationId: t1, skillName: "web-search", metadata: { query: "科技新闻 本周" } });
  O(t2, {
    type: "LLM", name: "llm:turn-2", startTime: rel(ts, 1000), endTime: rel(ts, 3600),
    parentObservationId: chat, model: "deepseek-chat",
    usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 },
    input: { messages: [
      { role: "user", content: "帮我查一下最近科技新闻" },
      { role: "assistant", content: "好的，我先搜索一下近期科技新闻。" },
      { role: "user", content: "搜索到：AI 芯片出货量创新高。请展开讲讲" },
    ] },
    output: { choices: [{ message: { role: "assistant", content: "本周 AI 芯片领域有三件大事：1) 英伟达 H 系列产能爬坡…" } }] },
  });
  O(t3, {
    type: "LLM", name: "llm:turn-3", startTime: rel(ts, 3700), endTime: rel(ts, 8800),
    parentObservationId: chat, model: "deepseek-chat",
    usage: { prompt_tokens: 700, completion_tokens: 250, total_tokens: 950 },
    input: { messages: [{ role: "user", content: "总结成三段给我" }] },
    output: { choices: [{ message: { role: "assistant", content: "总结：1) AI 芯片… 2) 大模型融资… 3) 边缘计算…" } }] },
  });

  push({ type: "score-create", body: { traceId, name: "helpfulness", value: 0.9, dataType: "NUMERIC", source: "ANNOTATION", comment: "多轮回答准确" } });
}

// =====================================================================
// Trace 4: batch-summarization —— 批量任务：ERROR + 重试 + 并行 + merge
// =====================================================================
{
  const traceId = "cx-batch-sum-1";
  const ts = new Date(Date.now() - 25 * 60 * 1000);
  push({
    type: "trace-create",
    body: {
      id: traceId, name: "batch-summarization", timestamp: ts.toISOString(),
      environment: "staging", userId: "user-9004", sessionId: "sess-cx-4",
      agentName: "BatchAgent", tags: ["batch", "summary"], metadata: { job: "nightly-docs" },
    },
  });
  const entry = "cx-o-71", batch2 = "cx-o-72", d1 = "cx-o-73", s1 = "cx-o-74",
    d2 = "cx-o-75", s2 = "cx-o-76", s2b = "cx-o-77",
    d3 = "cx-o-78", s3 = "cx-o-79", mg = "cx-o-80", mgl = "cx-o-81";
  const O = (id2, opts) => push({ type: "observation-create", body: { id: id2, traceId, ...opts } });

  O(entry, { type: "SPAN", name: "entry", startTime: rel(ts, 0), endTime: rel(ts, 5000) });
  O(batch2, { type: "SPAN", name: "agent:batch", startTime: rel(ts, 10), endTime: rel(ts, 4900), parentObservationId: entry });
  O(d1, { type: "SPAN", name: "chunk:doc-1", startTime: rel(ts, 20), endTime: rel(ts, 900), parentObservationId: batch2 });
  O(s1, {
    type: "LLM", name: "llm:sum-1", startTime: rel(ts, 30), endTime: rel(ts, 880),
    parentObservationId: d1, model: "gpt-4o-mini",
    usage: { prompt_tokens: 1400, completion_tokens: 400, total_tokens: 1800 },
    input: USER("摘要文档1"), output: ASSIST("文档1摘要：…"),
  });
  O(d2, { type: "SPAN", name: "chunk:doc-2", startTime: rel(ts, 1000), endTime: rel(ts, 3000), parentObservationId: batch2 });
  O(s2, {
    type: "LLM", name: "llm:sum-2", startTime: rel(ts, 1010), endTime: rel(ts, 1600),
    parentObservationId: d2, model: "gpt-4o-mini", level: "ERROR",
    usage: { prompt_tokens: 40000, completion_tokens: 0, total_tokens: 40000 },
    input: USER("摘要文档2"), output: { error: { type: "context_length_exceeded", message: "超过 32k 上下文" } },
    metadata: { errorType: "ContextLengthExceeded" },
  });
  O(s2b, {
    type: "LLM", name: "llm:sum-2-retry", startTime: rel(ts, 1700), endTime: rel(ts, 2900),
    parentObservationId: d2, model: "gpt-4o",
    usage: { prompt_tokens: 2100, completion_tokens: 500, total_tokens: 2600 },
    input: USER("分块重试摘要文档2"), output: ASSIST("文档2摘要（重试成功）：…"),
    metadata: { attempts: 2 },
  });
  O(d3, { type: "SPAN", name: "chunk:doc-3", startTime: rel(ts, 3100), endTime: rel(ts, 3800), parentObservationId: batch2 });
  O(s3, {
    type: "LLM", name: "llm:sum-3", startTime: rel(ts, 3110), endTime: rel(ts, 3700),
    parentObservationId: d3, model: "gpt-4o-mini",
    usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
    input: USER("摘要文档3"), output: ASSIST("文档3摘要：…"),
  });
  O(mg, { type: "SPAN", name: "merge", startTime: rel(ts, 3900), endTime: rel(ts, 4800), parentObservationId: batch2 });
  O(mgl, {
    type: "LLM", name: "llm:merge", startTime: rel(ts, 3910), endTime: rel(ts, 4700),
    parentObservationId: mg, model: "claude-3-5-sonnet",
    usage: { prompt_tokens: 2400, completion_tokens: 800, total_tokens: 3200 },
    input: USER("合并三份摘要为最终报告"), output: ASSIST("最终报告：…"),
  });

  push({ type: "score-create", body: { traceId, name: "quality", value: 0.78, dataType: "NUMERIC", source: "ANNOTATION" } });
}

console.log(`注入 ${batch.length} 条事件到 ${BASE}/api/public/ingestion ...`);
const res = await fetch(`${BASE}/api/public/ingestion`, {
  method: "POST",
  headers: {
    authorization: "Basic " + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64"),
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

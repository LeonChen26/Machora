// 极简 stdio MCP server（测试用）：提供 echo / add / get_time 三个工具
// MCP stdio transport = newline-delimited JSON-RPC over stdin/stdout
import readline from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "回显输入文本",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "两个数字相加",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "第一个数" },
        b: { type: "number", description: "第二个数" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "get_time",
    description: "返回当前本地时间（ISO 字符串）",
    inputSchema: { type: "object", properties: {} },
  },
];

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handleToolsCall(params) {
  const { name, arguments: args } = params ?? {};
  switch (name) {
    case "echo": {
      return { content: [{ type: "text", text: String(args?.text ?? "") }] };
    }
    case "add": {
      const a = Number(args?.a ?? 0);
      const b = Number(args?.b ?? 0);
      return { content: [{ type: "text", text: String(a + b) }] };
    }
    case "get_time": {
      return { content: [{ type: "text", text: new Date().toISOString() }] };
    }
    default:
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
  }
}

rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const id = req.id;

  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "machora-demo-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (req.method === "notifications/initialized") {
    return;
  }
  if (req.method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (req.method === "tools/call") {
    const result = handleToolsCall(req.params);
    send({ jsonrpc: "2.0", id, result });
    return;
  }
  // 未知方法：返回错误
  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    });
  }
});

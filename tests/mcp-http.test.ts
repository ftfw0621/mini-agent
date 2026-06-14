import http from "node:http"; // stand up a real MCP-over-HTTP server for the test
import { connectMcpServers, parseSseData } from "../src/mcp.js"; // unit under test
import { CONFIG } from "../src/config.js"; // inject the server URL (the test seam)
import { tools, dispatch } from "../src/tools.js"; // verify registration + execution
import { check, checkContains, finish } from "./helpers.js"; // assertions

// ---- parseSseData: pull JSON-RPC payloads out of an SSE body ----------------------------
check("single data frame", JSON.stringify(parseSseData("data: {\"a\":1}\n\n")) === JSON.stringify(['{"a":1}']));
{
  const body = "event: message\ndata: {\"id\":1}\n\nevent: message\ndata: {\"id\":2}\n\n";
  const got = parseSseData(body);
  check("two frames parsed", got.length === 2 && got[0] === '{"id":1}' && got[1] === '{"id":2}');
}
check("ignores comments and blank frames", parseSseData(": keep-alive\n\ndata: {}\n\n").length === 1);

// ---- a real HTTP MCP server, answered over SSE, with a session id -----------------------
const SESSION = "sess-xyz";
const sse = (res: http.ServerResponse, obj: unknown, extraHeaders: Record<string, string> = {}) => {
  res.writeHead(200, { "content-type": "text/event-stream", ...extraHeaders });
  res.end(`event: message\ndata: ${JSON.stringify(obj)}\n\n`); // one framed JSON-RPC message
};

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msg = body ? JSON.parse(body) : {};
    if (msg.id === undefined) return void res.writeHead(202).end(); // a notification — no response
    if (msg.method === "initialize") {
      return sse(res, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }, { "mcp-session-id": SESSION });
    }
    if (msg.method === "tools/list") {
      return sse(res, {
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: [{ name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }] },
      });
    }
    if (msg.method === "tools/call") {
      // Prove the client echoes the session id it was handed on initialize.
      if (req.headers["mcp-session-id"] !== SESSION) {
        return sse(res, { jsonrpc: "2.0", id: msg.id, error: { message: "missing or wrong session id" } });
      }
      const { a = 0, b = 0 } = msg.params.arguments;
      return sse(res, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(a + b) }] } });
    }
    sse(res, { jsonrpc: "2.0", id: msg.id, error: { message: `unknown method ${msg.method}` } });
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
CONFIG.mcpServers = { calc: { url: `http://127.0.0.1:${port}/mcp` } }; // HTTP server, not a subprocess

const disconnect = await connectMcpServers();

// ---- discovery + registration over HTTP -------------------------------------------------
check("http mcp tool is registered", "mcp__calc__add" in tools);
checkContains("description marks the origin", tools["mcp__calc__add"]?.definition.function.description ?? "", "[MCP:calc]");

// ---- end-to-end call: proves transport + session-id echo + SSE parse all work -----------
const result = await dispatch("mcp__calc__add", JSON.stringify({ a: 17, b: 25 }));
checkContains("http mcp tool runs over SSE (17+25=42)", result, "42");

disconnect(); // best-effort DELETE the session
CONFIG.mcpServers = {}; // reset for any suite that follows
await new Promise<void>((resolve) => server.close(() => resolve()));
finish();

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

// Tools/list_changed support: the server declares listChanged, keeps a GET event
// stream open, and can announce new tools on it — or inline in a POST's SSE reply.
let toolSet = ["add"]; // what tools/list returns right now
let stream: http.ServerResponse | null = null; // the client's standalone GET stream
let streamSession: string | undefined; // the session id the GET carried
const schema = { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] };
const listChanged = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`;

const server = http.createServer((req, res) => {
  if (req.method === "GET") { // the server→client channel: hold it open
    streamSession = req.headers["mcp-session-id"] as string | undefined;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": open\n\n");
    stream = res;
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const msg = body ? JSON.parse(body) : {};
    if (msg.id === undefined) return void res.writeHead(202).end(); // a notification — no response
    if (msg.method === "initialize") {
      return sse(res, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: true } } } }, { "mcp-session-id": SESSION });
    }
    if (msg.method === "tools/list") {
      return sse(res, {
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: toolSet.map((name) => ({ name, description: `${name} two numbers.`, inputSchema: schema })) },
      });
    }
    if (msg.method === "tools/call") {
      // Prove the client echoes the session id it was handed on initialize.
      if (req.headers["mcp-session-id"] !== SESSION) {
        return sse(res, { jsonrpc: "2.0", id: msg.id, error: { message: "missing or wrong session id" } });
      }
      const { a = 0, b = 0 } = msg.params.arguments;
      if (msg.params.name === "sub") {
        // The reply stream carries a notification BEFORE the result — Streamable HTTP allows it.
        toolSet = ["add", "mul", "sub", "div"];
        res.writeHead(200, { "content-type": "text/event-stream" });
        return void res.end(listChanged + `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(a - b) }] } })}\n\n`);
      }
      const value = msg.params.name === "mul" ? a * b : a + b;
      return sse(res, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(value) }] } });
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

// ---- tools/list_changed over the standalone GET stream -----------------------------------
const waitFor = async (cond: () => boolean) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); return cond(); };
check("client opens the event stream when the server declares listChanged", await waitFor(() => stream !== null));
check("the event stream carries the session id", streamSession === SESSION);
toolSet = ["add", "mul"];
stream!.write(listChanged); // the server speaks between requests
check("list_changed on the GET stream registers the new tool", await waitFor(() => "mcp__calc__mul" in tools));
checkContains("the new tool works over http", await dispatch("mcp__calc__mul", JSON.stringify({ a: 6, b: 7 })), "42");

// ---- ...and inline in a POST's SSE reply ---------------------------------------------------
toolSet = ["add", "mul", "sub"];
stream!.write(listChanged);
await waitFor(() => "mcp__calc__sub" in tools);
checkContains("a reply that carries a notification still returns its result", await dispatch("mcp__calc__sub", JSON.stringify({ a: 9, b: 4 })), "5");
check("the inline notification is delivered too", await waitFor(() => "mcp__calc__div" in tools));

disconnect(); // best-effort DELETE the session
CONFIG.mcpServers = {}; // reset for any suite that follows
(stream as http.ServerResponse | null)?.end(); // assigned in the request handler — TS can't see that
server.closeAllConnections();
await new Promise<void>((resolve) => server.close(() => resolve()));
finish();

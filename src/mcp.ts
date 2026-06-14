import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"; // stdio servers are subprocesses
import chalk from "chalk"; // status lines
import { CONFIG, type McpServerDef } from "./config.js"; // configured servers
import { registerExternalTool, type Tool } from "./tools.js"; // expose discovered tools
import { emit } from "./telemetry.js"; // observability

// MCP (Model Context Protocol) lets the agent borrow tools from external
// servers — a filesystem server, a GitHub server, a database server, anything.
// The wire protocol is JSON-RPC 2.0. We do the initialize handshake, ask for the
// server's tools, and register each one so it flows through the SAME dispatch and
// the SAME permission gate as a built-in. There is one execution path, period.
//
// Since Day 24 there are TWO ways to reach a server: spawn it and talk over
// stdio (local), or POST to a URL (remote, "Streamable HTTP"). The protocol is
// identical; only the pipe differs. That difference lives behind a Transport
// interface, so McpClient — handshake, ids, tool flattening — never has to care.
//
// Discovered tools are named mcp__<server>__<tool> so they never collide with
// built-ins and the user can see (and gate) exactly where each came from.

const INIT_TIMEOUT_MS = 15_000; // a server that doesn't initialize in 15s is skipped
const CALL_TIMEOUT_MS = 60_000; // a single tool call may take this long

interface JsonRpcResponse {
  id: number; // matches the request
  result?: { tools?: McpToolSpec[]; content?: McpContent[]; isError?: boolean }; // success payload
  error?: { message: string }; // failure
}
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: object;
}
interface McpToolSpec {
  name: string; // the server's tool name
  description?: string; // its manual
  inputSchema?: { type: string; properties?: Record<string, unknown>; required?: string[] }; // its parameters
}
interface McpContent {
  type: string; // "text" | "image" | ...
  text?: string; // present for text content
}

// The wire under JSON-RPC. A request expects a matching response; a notification
// is fire-and-forget (the handshake's "initialized" needs one). close() releases
// whatever the transport holds (a subprocess, a session).
interface Transport {
  request(payload: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse>;
  notify(method: string, params: object): void;
  close(): void;
}

// ---- stdio transport: one JSON object per line, to a subprocess --------------
class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, (r: JsonRpcResponse) => void>(); // id → resolver (responses arrive async on one stream)
  private buffer = ""; // partial stdout, reassembled into whole lines

  constructor(def: McpServerDef) {
    this.child = spawn(def.command as string, def.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"], // we own stdin/stdout; stderr is the server's log
      env: { ...process.env, ...def.env }, // pass through + extras
    });
    // Reassemble newline-delimited JSON from the stdout stream.
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim(); // one complete message
        this.buffer = this.buffer.slice(nl + 1); // keep the remainder
        if (line) this.onMessage(line);
      }
    });
    this.child.stderr.on("data", () => {}); // the server's stderr is its own logging — never our stdout
  }

  private onMessage(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore anything that isn't valid JSON-RPC
    }
    const resolver = this.pending.get(msg.id);
    if (resolver) {
      this.pending.delete(msg.id);
      resolver(msg);
    }
  }

  request(payload: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse> {
    const { id } = payload;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: JsonRpcResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(r);
      };
      const timer = setTimeout(() => finish({ id, error: { message: `MCP request '${payload.method}' timed out` } }), timeoutMs);
      this.pending.set(id, finish);
      this.child.stdin.write(JSON.stringify(payload) + "\n"); // one line, newline-terminated
    });
  }

  notify(method: string, params: object): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): void {
    this.child.kill(); // best-effort cleanup
  }
}

// Pull JSON-RPC messages out of a Server-Sent-Events body. SSE frames are
// separated by blank lines; the payload lives on one or more `data:` lines.
// Exported because parsing is the fiddly part worth testing on its own.
export function parseSseData(body: string): string[] {
  const out: string[] = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim()) // strip "data:" and surrounding space
      .join("\n");
    if (data) out.push(data);
  }
  return out;
}

// ---- HTTP transport: POST to a URL, read JSON or SSE back --------------------
class HttpTransport implements Transport {
  private url: string;
  private headers: Record<string, string>;
  private sessionId?: string; // assigned by the server on initialize, echoed on every later request

  constructor(def: McpServerDef) {
    this.url = def.url as string;
    this.headers = { ...def.headers };
  }

  // The response to a POST may come back as a single JSON object OR as an SSE
  // stream carrying it. Either way we want the JSON-RPC message matching our id.
  private async post(body: object, timeoutMs: number, isRequest: boolean): Promise<JsonRpcResponse | null> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream", // we accept either shape
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id"); // initialize hands us a session to keep
    if (sid) this.sessionId = sid;
    if (!isRequest) return null; // a notification expects no body (202 Accepted)

    const raw = await res.text();
    const payloads = res.headers.get("content-type")?.includes("text/event-stream") ? parseSseData(raw) : [raw];
    for (const p of payloads) {
      try {
        const msg = JSON.parse(p) as JsonRpcResponse;
        if (msg && (msg.result !== undefined || msg.error !== undefined)) return msg; // the response we came for
      } catch {
        /* skip non-JSON frames (SSE comments, keep-alives) */
      }
    }
    return null;
  }

  async request(payload: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse> {
    try {
      const msg = await this.post(payload, timeoutMs, true);
      return msg ?? { id: payload.id, error: { message: `MCP request '${payload.method}' returned no response` } };
    } catch (err) {
      return { id: payload.id, error: { message: `MCP HTTP request '${payload.method}' failed: ${(err as Error).message}` } };
    }
  }

  notify(method: string, params: object): void {
    // Fire-and-forget; errors on a notification are not worth surfacing.
    void this.post({ jsonrpc: "2.0", method, params }, INIT_TIMEOUT_MS, false).catch(() => {});
  }

  close(): void {
    // Best-effort: tell the server to drop the session. No await, no error care.
    if (this.sessionId) {
      void fetch(this.url, { method: "DELETE", headers: { "mcp-session-id": this.sessionId, ...this.headers } }).catch(() => {});
    }
  }
}

// Choose the pipe from the config: a url means HTTP, otherwise spawn over stdio.
function makeTransport(def: McpServerDef): Transport {
  return def.url ? new HttpTransport(def) : new StdioTransport(def);
}

// The protocol layer: handshake, request ids, tool flattening. It talks to a
// Transport and is blind to whether that's a subprocess or an HTTP endpoint.
class McpClient {
  private transport: Transport;
  private nextId = 1; // JSON-RPC request id counter

  constructor(def: McpServerDef) {
    this.transport = makeTransport(def);
  }

  private request(method: string, params: object, timeoutMs: number): Promise<JsonRpcResponse> {
    return this.transport.request({ jsonrpc: "2.0", id: this.nextId++, method, params }, timeoutMs);
  }

  // The MCP startup dance: initialize → initialized → list tools.
  async start(): Promise<McpToolSpec[]> {
    const init = await this.request(
      "initialize",
      { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mini-agent", version: "0" } },
      INIT_TIMEOUT_MS,
    );
    if (init.error) throw new Error(init.error.message); // server refused to initialize
    this.transport.notify("notifications/initialized", {}); // tell the server we're ready
    const list = await this.request("tools/list", {}, INIT_TIMEOUT_MS); // ask what it offers
    if (list.error) throw new Error(list.error.message);
    return list.result?.tools ?? [];
  }

  // Invoke one tool and flatten its content into plain text for the model.
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS);
    if (res.error) return `[error] MCP tool failed: ${res.error.message}`; // surface, don't throw
    const text = (res.result?.content ?? []).map((c) => c.text ?? `[${c.type} content]`).join("\n"); // flatten parts
    const body = text || "(no output)";
    return res.result?.isError ? `[error] ${body}` : body; // MCP can flag a logical error in a successful response
  }

  kill(): void {
    this.transport.close();
  }
}

// Connect to every configured MCP server, register their tools, and return a
// cleanup function. Failures are isolated: a server that won't start is logged
// and skipped — it never stops the agent or the other servers.
export async function connectMcpServers(): Promise<() => void> {
  const entries = Object.entries(CONFIG.mcpServers); // [name, def] pairs
  if (!entries.length) return () => {}; // the common case: nothing configured

  const clients: McpClient[] = []; // for cleanup
  for (const [serverName, def] of entries) {
    const client = new McpClient(def);
    try {
      const specs = await client.start(); // handshake + discover
      clients.push(client);
      for (const spec of specs) {
        const toolName = `mcp__${serverName}__${spec.name}`; // namespaced, collision-proof
        const tool: Tool = {
          definition: {
            type: "function",
            function: {
              name: toolName,
              description: `[MCP:${serverName}] ${spec.description ?? spec.name}`, // mark the origin in the manual
              parameters: spec.inputSchema ?? { type: "object", properties: {} }, // pass the server's schema straight through
            },
          },
          run: async (args) => client.callTool(spec.name, args), // dispatch routes here; the permission gate ran first
        };
        registerExternalTool(tool); // now indistinguishable from a built-in to the rest of the system
      }
      emit("agent_mcp_connected", { server: serverName, tools: specs.length, transport: def.url ? "http" : "stdio" });
      console.log(chalk.dim(`(mcp: ${serverName} — ${specs.length} tools${def.url ? " over http" : ""})`)); // visible at startup
    } catch (err) {
      client.kill(); // don't leak the process/session
      emit("agent_mcp_failed", { server: serverName });
      console.error(chalk.yellow(`  [mcp] ${serverName} failed to start (skipped): ${(err as Error).message}`)); // loud, but not fatal
    }
  }
  return () => clients.forEach((c) => c.kill()); // the caller calls this on exit
}

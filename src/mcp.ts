import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"; // MCP servers are subprocesses
import chalk from "chalk"; // status lines
import { CONFIG, type McpServerDef } from "./config.js"; // configured servers
import { registerExternalTool, type Tool } from "./tools.js"; // expose discovered tools
import { emit } from "./telemetry.js"; // observability

// MCP (Model Context Protocol) lets the agent borrow tools from external
// servers — a filesystem server, a GitHub server, a database server, anything.
// The wire protocol is JSON-RPC 2.0 over stdio: one JSON object per line, no
// embedded newlines. We spawn the server, do the initialize handshake, ask for
// its tools, and register each one so it flows through the SAME dispatch and the
// SAME permission gate as a built-in. There is one execution path, period.
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
interface McpToolSpec {
  name: string; // the server's tool name
  description?: string; // its manual
  inputSchema?: { type: string; properties?: Record<string, unknown>; required?: string[] }; // its parameters
}
interface McpContent {
  type: string; // "text" | "image" | ...
  text?: string; // present for text content
}

// One live connection to an MCP server.
class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1; // JSON-RPC request id counter
  private pending = new Map<number, (r: JsonRpcResponse) => void>(); // id → resolver
  private buffer = ""; // partial stdout, reassembled into whole lines

  constructor(def: McpServerDef) {
    this.child = spawn(def.command, def.args ?? [], {
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
    // The server's stderr is its own logging — never our stdout, never the model's.
    this.child.stderr.on("data", () => {});
  }

  // A response arrived: hand it to whoever is waiting on that id.
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

  // Send a request and wait for its response (or time out).
  request(method: string, params: object, timeoutMs: number): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: JsonRpcResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(r);
      };
      const timer = setTimeout(() => finish({ id, error: { message: `MCP request '${method}' timed out` } }), timeoutMs);
      this.pending.set(id, finish);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); // one line, newline-terminated
    });
  }

  // A notification has no id and expects no response (the handshake needs one).
  notify(method: string, params: object): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  // The MCP startup dance: initialize → initialized → list tools.
  async start(): Promise<McpToolSpec[]> {
    const init = await this.request(
      "initialize",
      { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mini-agent", version: "0" } },
      INIT_TIMEOUT_MS,
    );
    if (init.error) throw new Error(init.error.message); // server refused to initialize
    this.notify("notifications/initialized", {}); // tell the server we're ready
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
    this.child.kill(); // best-effort cleanup on exit
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
      emit("agent_mcp_connected", { server: serverName, tools: specs.length });
      console.log(chalk.dim(`(mcp: ${serverName} — ${specs.length} tools)`)); // visible at startup
    } catch (err) {
      client.kill(); // don't leak the process
      emit("agent_mcp_failed", { server: serverName });
      console.error(chalk.yellow(`  [mcp] ${serverName} failed to start (skipped): ${(err as Error).message}`)); // loud, but not fatal
    }
  }
  return () => clients.forEach((c) => c.kill()); // the caller calls this on exit
}

// A minimal MCP server for tests: speaks JSON-RPC 2.0 over stdio (one JSON
// object per line). It offers "add", plus "grow": calling grow adds a "mul"
// tool and announces it with notifications/tools/list_changed (and pings the
// client, which must answer). Not a real implementation —
// just enough of the protocol to exercise our client end to end without pulling
// in an external dependency.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
let grown = false; // has "grow" added the mul tool?
let pong = false; // did the client answer our ping?
const tool = (name, description) => ({ name, description, inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } });

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore malformed input
  }
  if (msg.id === "srv-ping" && !msg.method) {
    pong = msg.result !== undefined; // the client's answer to our ping
  } else if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mock", version: "1" } } });
  } else if (msg.method === "notifications/initialized") {
    // a notification — no response
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          tool("add", "Add two numbers and return the sum."),
          { name: "grow", description: "Add the mul tool.", inputSchema: { type: "object", properties: {} } },
          { name: "pong", description: "Did the client answer the ping?", inputSchema: { type: "object", properties: {} } },
          ...(grown ? [tool("mul", "Multiply two numbers.")] : []),
        ],
      },
    });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    const text = (t) => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(t) }] } });
    if (name === "add") {
      text((args.a ?? 0) + (args.b ?? 0));
    } else if (name === "mul" && grown) {
      text((args.a ?? 0) * (args.b ?? 0));
    } else if (name === "grow") {
      grown = true;
      text("grown");
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); // the server speaks first
      send({ jsonrpc: "2.0", id: "srv-ping", method: "ping" }); // a server→client request
    } else if (name === "pong") {
      text(pong);
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { message: `unknown tool ${name}` } });
    }
  }
});

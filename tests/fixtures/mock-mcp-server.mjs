// A minimal MCP server for tests: speaks JSON-RPC 2.0 over stdio (one JSON
// object per line). It offers a single "add" tool. Not a real implementation —
// just enough of the protocol to exercise our client end to end without pulling
// in an external dependency.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore malformed input
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1" } } });
  } else if (msg.method === "notifications/initialized") {
    // a notification — no response
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "add",
            description: "Add two numbers and return the sum.",
            inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
          },
        ],
      },
    });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "add") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String((args.a ?? 0) + (args.b ?? 0)) }] } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { message: `unknown tool ${name}` } });
    }
  }
});

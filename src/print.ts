import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { LoopResult } from "./loop.js";
import type { CostMeter } from "./cost.js";

export interface PrintResult {
  sessionId: string;
  model: string;
  effort: string;
  result: LoopResult;
  usage: ReturnType<CostMeter["snapshot"]>;
  durationMs?: number; // stream-json only: wall-clock of the whole run
  numTurns?: number; // stream-json only: assistant turns the model took
}

export function formatPrintResult(format: "text" | "json" | "stream-json", data: PrintResult): string {
  if (format === "text") return data.result.finalText ? `${data.result.finalText}\n` : "";
  if (format === "stream-json") return streamJsonResult(data);
  return JSON.stringify({ type: "result", is_error: data.result.reason !== "done", reason: data.result.reason,
    result: data.result.finalText ?? "", session_id: data.sessionId, model: data.model, effort: data.effort,
    usage: { input_tokens: data.usage.inputUncached + data.usage.inputCached, cached_input_tokens: data.usage.inputCached,
      output_tokens: data.usage.output, model_calls: data.usage.calls }, estimated_cost_usd: data.usage.cost }) + "\n";
}

// ---- stream-json: Claude Code's NDJSON event protocol -----------------------------
// `claude -p --output-format stream-json` prints one JSON object per line:
//   system/init  →  assistant / user (tool_result)  …  →  result
// Tools that parse Claude's stream (SDK wrappers, CI dashboards, log viewers)
// can read ours unchanged. Our history is OpenAI-shaped, so each message is
// translated at the boundary: tool_calls become tool_use blocks, role:"tool"
// becomes a user message carrying a tool_result, reasoning_content becomes a
// thinking block. Tool NAMES stay ours (run_bash, not Bash) — they are what the
// model actually called. Sub-agent turns are not streamed, so every event has
// parent_tool_use_id: null.

// Every line carries a fresh uuid and the session id, like Claude's.
const event = (sessionId: string, body: Record<string, unknown>): string =>
  JSON.stringify({ ...body, session_id: sessionId, uuid: randomUUID() }) + "\n";

// The first line: what this run is equipped with, before any model call.
export function streamJsonInit(data: { sessionId: string; model: string; tools: string[];
  mcpServers: { name: string; status: string }[]; permissionMode: string }): string {
  return event(data.sessionId, { type: "system", subtype: "init", cwd: process.cwd(), tools: data.tools,
    mcp_servers: data.mcpServers, model: data.model, permissionMode: data.permissionMode });
}

// Our tool results mark failure with a bracketed prefix, not a flag.
const TOOL_ERROR = /^\[(?:error|permission|hook|follow-up)\]/;

// One history message → zero or more events. Claude emits one assistant event
// per content block (sharing the message id), so consumers can render each
// block as it lands; we do the same.
export function streamJsonMessage(sessionId: string, model: string, message: OpenAI.ChatCompletionMessageParam): string {
  if (message.role === "tool") {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return event(sessionId, { type: "user", parent_tool_use_id: null, message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content, is_error: TOOL_ERROR.test(content) }] } });
  }
  if (message.role !== "assistant") return "";
  const blocks: Record<string, unknown>[] = [];
  const reasoning = (message as { reasoning_content?: string }).reasoning_content;
  if (reasoning) blocks.push({ type: "thinking", thinking: reasoning });
  if (typeof message.content === "string" && message.content) blocks.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    // The model can emit malformed arguments; the stream must never throw over it.
    let input: unknown;
    try { input = JSON.parse(call.function.arguments || "{}"); } catch { input = call.function.arguments; }
    blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  const id = `msg_${randomUUID()}`;
  const stopReason = message.tool_calls?.length ? "tool_use" : "end_turn";
  return blocks.map((block) => event(sessionId, { type: "assistant", parent_tool_use_id: null, message: {
    id, type: "message", role: "assistant", model, content: [block], stop_reason: stopReason, stop_sequence: null } })).join("");
}

// The last line. Usage follows Anthropic's split (uncached input vs cache
// reads), which differs from our `json` format's input_tokens (the total).
function streamJsonResult(data: PrintResult): string {
  const ok = data.result.reason === "done";
  return event(data.sessionId, { type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok,
    duration_ms: data.durationMs ?? 0, num_turns: data.numTurns ?? 0, result: data.result.finalText ?? "",
    total_cost_usd: data.usage.cost, usage: { input_tokens: data.usage.inputUncached, cache_creation_input_tokens: 0,
      cache_read_input_tokens: data.usage.inputCached, output_tokens: data.usage.output },
    permission_denials: [], reason: data.result.reason });
}

// stdout is a protocol in print mode, even when an MCP startup or hook helper
// logs directly. Reserve the original writer for the result and route all
// incidental output to stderr. Only the CLI entry point installs this guard.
export function reservePrintOutput(): { write: (text: string) => void; restore: () => void } {
  const original = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr);
  return { write: (text) => { original.call(process.stdout, text); }, restore: () => { process.stdout.write = original; } };
}

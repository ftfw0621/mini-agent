import type { LoopResult } from "./loop.js";
import type { CostMeter } from "./cost.js";

export interface PrintResult {
  sessionId: string;
  model: string;
  effort: string;
  result: LoopResult;
  usage: ReturnType<CostMeter["snapshot"]>;
}

export function formatPrintResult(format: "text" | "json", data: PrintResult): string {
  if (format === "text") return data.result.finalText ? `${data.result.finalText}\n` : "";
  return JSON.stringify({ type: "result", is_error: data.result.reason !== "done", reason: data.result.reason,
    result: data.result.finalText ?? "", session_id: data.sessionId, model: data.model, effort: data.effort,
    usage: { input_tokens: data.usage.inputUncached + data.usage.inputCached, cached_input_tokens: data.usage.inputCached,
      output_tokens: data.usage.output, model_calls: data.usage.calls }, estimated_cost_usd: data.usage.cost }) + "\n";
}

// stdout is a protocol in print mode, even when an MCP startup or hook helper
// logs directly. Reserve the original writer for the result and route all
// incidental output to stderr. Only the CLI entry point installs this guard.
export function reservePrintOutput(): { write: (text: string) => void; restore: () => void } {
  const original = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr);
  return { write: (text) => { original.call(process.stdout, text); }, restore: () => { process.stdout.write = original; } };
}

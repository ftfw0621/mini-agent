import type OpenAI from "openai";

export interface ReviewAction {
  tool: string;
  input: unknown;
  outcome: "returned" | "denied" | "failed" | "skipped";
  resultData?: unknown; // untrusted structured facts, NEVER new authorization
  resultDataOmitted?: true;
}
export interface ReviewHistory { actions: readonly ReviewAction[]; omittedActions: number }
const HISTORY_BYTES = 8000;
const RESULT_BYTES = 2000;

function resultEvidence(result: string): Pick<ReviewAction, "resultData" | "resultDataOmitted"> {
  if (!result) return {};
  if (Buffer.byteLength(result, "utf8") <= RESULT_BYTES) {
    try {
      const value: unknown = JSON.parse(result);
      if (value !== null && typeof value === "object") return { resultData: value };
    } catch { /* prose is not structured evidence */ }
  }
  return { resultDataOmitted: true };
}

function projectInput(tool: string, args: string): unknown {
  try {
    const value = JSON.parse(args);
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    if (tool === "read_file") return { path: value.path };
    if (tool === "search") return { pattern: value.pattern, path: value.path, file_glob: value.file_glob };
    if (tool === "run_bash" || tool === "run_bash_background") return { command: value.command };
    return value; // retain edits, writes and opaque inputs without guessing relevance
  } catch { return { malformedArguments: args }; }
}

// This projection deliberately cannot create user authorization. Only completed
// tool-call/result pairs contribute context; queued sibling actions, assistant
// prose and synthetic user-role notifications are excluded. Small structured
// results retain target/effect evidence; arbitrary prose and large results do not.
// User requests/project rules/current action are separately kept in full.
export function reviewHistory(messages: readonly OpenAI.ChatCompletionMessageParam[], inherited?: ReviewHistory): ReviewHistory {
  const results = new Map<string, string>();
  for (const message of messages) if (message.role === "tool") {
    results.set(message.tool_call_id, typeof message.content === "string" ? message.content : "");
  }
  const actions: ReviewAction[] = [...(inherited?.actions ?? [])];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      if (call.type !== "function" || !results.has(call.id)) continue;
      const result = results.get(call.id)!;
      actions.push({ tool: call.function.name, input: projectInput(call.function.name, call.function.arguments),
        outcome: /^\[follow-up\]/.test(result) ? "skipped" : /^\[(?:permission|hook)\]/.test(result) ? "denied" : /^\[error\]/.test(result) ? "failed" : "returned", ...resultEvidence(result) });
    }
  }
  let bytes = 0;
  let start = actions.length;
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(actions[start - 1]), "utf8");
    if (bytes + size > HISTORY_BYTES) break; // keep a contiguous suffix, not misleading gaps
    bytes += size;
    start--;
  }
  return { actions: actions.slice(start), omittedActions: (inherited?.omittedActions ?? 0) + start };
}

import { execFileSync } from "node:child_process";
import type OpenAI from "openai";

export interface ReviewAction {
  callId?: string; // provenance of the untrusted observation
  tool: string;
  input: unknown;
  outcome: "returned" | "denied" | "auto_denied" | "failed" | "skipped";
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
      actions.push({ callId: call.id, tool: call.function.name, input: projectInput(call.function.name, call.function.arguments),
        outcome: /^\[permission\] Auto-denied/.test(result) ? "auto_denied" : /^\[follow-up\]/.test(result) ? "skipped" : /^\[(?:permission|hook)\]/.test(result) ? "denied" : /^\[error\]/.test(result) ? "failed" : "returned", ...resultEvidence(result) });
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

// Only identity facts cross the new policy boundary. Small JSON is not trusted
// simply because it is small. Keep nesting for provenance, discard prose and
// instruction-shaped fields; these observations still cannot authorize actions.
export function ruleHistory(history: ReviewHistory): ReviewHistory {
  const project = (value: unknown, depth = 0): unknown => {
    if (depth > 6 || !value || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      const entries = value.slice(0, 30).map((v) => project(v, depth + 1)).filter((v) => v !== undefined);
      return entries.length ? entries : undefined;
    }
    const facts: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(id|user_id|channel_id|name|display_name|real_name|email|username)$/.test(key)
        && typeof item === "string" && item.length <= 200 && !/[\r\n]/.test(item)) facts[key] = item;
      else if (/^(results|users|members|data|profile)$/.test(key)) {
        const nested = project(item, depth + 1);
        if (nested !== undefined) facts[key] = nested;
      }
    }
    return Object.keys(facts).length ? facts : undefined;
  };
  return { ...history, actions: history.actions.map(({ resultData, ...action }) => {
    const facts = project(resultData);
    return { ...action, ...(facts === undefined ? {} : { resultData: facts }),
      ...(resultData !== undefined && JSON.stringify(facts) !== JSON.stringify(resultData) ? { resultDataOmitted: true as const } : {}) };
  }) };
}

// Read once at startup. Later tool edits to git config must not expand the set
// of established destinations. Do not send URL credentials/query tokens.
export function startupRemotes(cwd: string): { name: string; kind: "fetch" | "push"; url: string }[] {
  try {
    const output = execFileSync("git", ["config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"], { cwd, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
    return output.trim().split("\n").flatMap((line) => {
      const entry = /^remote\.(.+)\.(url|pushurl) (.+)$/.exec(line);
      if (!entry) return [];
      let value = entry[3];
      try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; value = url.toString(); }
      catch { value = value.replace(/^[^@/]+@/, ""); }
      return [{ name: entry[1], kind: entry[2] === "pushurl" ? "push" as const : "fetch" as const, url: value }];
    });
  } catch { return []; }
}

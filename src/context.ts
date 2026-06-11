import fs from "node:fs"; // re-reading files from disk during recovery
import OpenAI from "openai"; // API types + client type
import chalk from "chalk"; // status lines
import { recentFiles, forgetFilesExcept } from "./tools.js"; // session file state (what was read/edited, and when)

// ---- The context window ------------------------------------------------------
// 1,048,565 came from a real API error message, not from documentation.
// Trust what the API tells you over what you remember reading.
export const CONTEXT_WINDOW = Number(process.env.MINI_AGENT_CONTEXT_WINDOW || 1_048_565); // overridable for other models
// Compact well before the hard limit: estimation is approximate and the summary
// itself needs room. 80% is deliberately conservative.
export const COMPACT_AT = Number(process.env.MINI_AGENT_COMPACT_AT || Math.floor(CONTEXT_WINDOW * 0.8)); // overridable so tests can trigger compaction cheaply

// How many times one query may compact / fail to compact before we give up.
export const MAX_COMPACTIONS_PER_QUERY = 4; // a query that needs more is too big — stop, don't loop
export const MAX_COMPACT_FAILURES = 3; // the compaction circuit breaker

// ---- Token estimation ---------------------------------------------------------
// Estimation is a safety mechanism, not an optimization: overestimating costs
// one early compaction; underestimating costs a failed request. Always round up.
export function estimateTokens(text: string, dense = false): number {
  const bytes = Buffer.byteLength(text, "utf8"); // Chinese/emoji take multiple bytes — count bytes, not chars
  return Math.ceil(bytes / (dense ? 2 : 4)); // JSON-ish text packs ~2 bytes/token, prose/code ~4 — and we round UP
}

// Estimate the whole conversation, message by message.
export function estimateHistoryTokens(messages: OpenAI.ChatCompletionMessageParam[]): number {
  let total = 0; // running sum
  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""); // content can be structured — serialize it
    const isDense = m.role === "tool"; // tool results are JSON-ish → denser tokens
    total += estimateTokens(content, isDense) + 8; // +8 per message for role/formatting overhead
    if ("tool_calls" in m && m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls), true); // count the call arguments too
  }
  return total;
}

// ---- The summary prompt ---------------------------------------------------------
// Six numbered sections. Each exists because losing that piece of information
// causes a specific, real failure mode after compaction (e.g. losing section 4
// means the agent re-tries approaches that already failed).
const SUMMARY_PROMPT = `You are about to lose your conversation history. Summarize it so the work can continue seamlessly in a fresh context.
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Tool calls will be REJECTED and will waste your only turn.

Write exactly these 6 sections:
1. Primary request and intent — what the user originally asked for, as precisely as possible
2. Key technical context — languages, paths, commands, constraints that matter
3. Files read or edited — exact paths, and what was changed in each
4. Errors and fixes — every error hit so far and how it was (or was not) resolved
5. Current state — what has just been done, what is in progress
6. Next step — the single most likely next action

CRITICAL: TEXT ONLY. No tool calls.`;

// ---- Post-compaction file recovery ------------------------------------------------
const RECOVER_MAX_FILES = 5; // restore at most this many recently-used files
const RECOVER_FILE_CHARS = 4000; // per-file cap
const RECOVER_TOTAL_CHARS = 16000; // total cap across all recovered files

// Compaction may forget the conversation, but it must not forget which files
// were being worked on. Restore the most recent ones — re-read FROM DISK,
// never from memory: another process may have changed them since we last looked.
export function recoverFileState(): string | null {
  const candidates = recentFiles(RECOVER_MAX_FILES); // most recently touched first
  const blocks: string[] = []; // formatted file blocks for the model
  const recovered: string[] = []; // paths that actually made it in
  let total = 0; // chars used so far
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue; // the file may have been deleted — trust the disk
    const content = fs.readFileSync(p, "utf8").slice(0, RECOVER_FILE_CHARS); // fresh from disk, capped
    if (total + content.length > RECOVER_TOTAL_CHARS) break; // budget exhausted — stop here
    total += content.length; // account for it
    recovered.push(p); // this one made it in
    blocks.push(`--- ${p} (re-read from disk, may be truncated) ---\n${content}`); // format the block
  }
  forgetFilesExcept(recovered); // files NOT recovered must be re-read before any future edit
  if (!blocks.length) return null; // nothing worth recovering
  return `[Recovered file state after compaction — most recently used files, re-read fresh from disk:]\n\n${blocks.join("\n\n")}`;
}

// ---- Compaction itself -----------------------------------------------------------
// Replace the whole history with a structured summary + recovered file state.
// Throws on failure — the loop decides what a failure means.
export async function compactHistory(
  messages: OpenAI.ChatCompletionMessageParam[], // the history, mutated in place
  client: OpenAI, // the same client the loop uses
  model: string, // the same model summarizes its own conversation
  signal: AbortSignal, // Ctrl+C must abort compaction too
): Promise<void> {
  const before = estimateHistoryTokens(messages); // for the log line
  console.log(chalk.magenta(`📦 compacting context (~${before} tokens)...`)); // automatic behavior must be visible
  const res = await client.chat.completions.create(
    {
      model, // same model — no need for a fancier one to summarize
      messages: [...messages, { role: "user", content: SUMMARY_PROMPT }], // full history + the summary instruction
      // Deliberately NO `tools` parameter: with no tools declared, the API
      // cannot accept a tool call — that is the hard guarantee. The CRITICAL
      // lines in the prompt are the soft second layer of the same defense.
    },
    { signal }, // still abortable by Ctrl+C
  );
  const summary = res.choices[0].message.content ?? ""; // the structured summary text
  if (!summary.trim()) throw new Error("compaction returned an empty summary"); // empty summary = failed compaction
  // The constitution survives compaction: keep the leading system message and
  // drop everything else. Losing the system prompt would silently change the
  // agent's behavior mid-session.
  const system = messages[0]?.role === "system" ? [messages[0]] : []; // there is at most one, at index 0
  messages.length = 0; // drop the old history entirely
  messages.push(...system); // the constitution goes back first
  messages.push({ role: "user", content: `[Context was compacted. Summary of the conversation so far:]\n\n${summary}` }); // the summary becomes the new history
  const recoveredNote = recoverFileState(); // restore working-file contents from disk
  if (recoveredNote) messages.push({ role: "user", content: recoveredNote }); // attach as a second message
  console.log(chalk.magenta(`📦 compacted: ~${before} → ~${estimateHistoryTokens(messages)} tokens`)); // report the result
}

import { effortMessages } from "./effort.js";
import fs from "node:fs"; // re-reading files from disk during recovery
import OpenAI from "openai"; // API types + client type
import chalk from "chalk"; // status lines
import { compactingText } from "./ui.js"; // the progress bar
import type { LoopOutput } from "./output.js"; // where the bar is drawn
import { CONFIG } from "./config.js"; // the resolved context window (env > settings files > default)
import { recentFiles, forgetFilesExcept, toolDefinitions } from "./tools.js"; // session file state (what was read/edited, and when) + the tool manuals we send

// ---- The context window ------------------------------------------------------
// The default (1,048,565) came from a real API error message, not from docs.
// Trust what the API tells you over what you remember reading.
//
// The window belongs to a MODEL, not to the session: /model can switch to one
// with a smaller window mid-conversation. Resolution, most specific first:
//   env MINI_AGENT_CONTEXT_WINDOW  >  settings contextWindows[<model>]  >  settings contextWindow  >  default
export function contextWindowFor(model = CONFIG.model): number {
  return Number(process.env.MINI_AGENT_CONTEXT_WINDOW) || CONFIG.contextWindows[model] || CONFIG.contextWindow;
}

// When to compact, the Claude Code way: not at a fixed percentage, but at
// "window minus what we must keep free". Two reservations:
//   - room for the model's reply (the compaction call itself writes a summary)
//   - a safety buffer for what we can't count exactly (the tail estimate)
// On a ~1M window that's ~97% full; on a 128k window it's ~74%, because the
// same 33k is a bigger slice of a smaller window. The floor keeps a tiny window
// from getting a threshold at or below zero.
export const RESERVED_OUTPUT_TOKENS = 20_000; // Claude Code reserves min(max output, 20k)
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000; // Claude Code's AUTOCOMPACT_BUFFER_TOKENS
export function compactThreshold(model = CONFIG.model): number {
  const env = Number(process.env.MINI_AGENT_COMPACT_AT); // explicit override (tests use it to trigger compaction cheaply)
  if (env) return env;
  const window = contextWindowFor(model);
  return Math.max(Math.floor(window * 0.6), window - RESERVED_OUTPUT_TOKENS - AUTOCOMPACT_BUFFER_TOKENS);
}

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
    const isDense = m.role === "tool"; // tool results are JSON-ish → denser tokens
    // Base64 bytes are transport, not text tokens. Image tokenization differs
    // by model/resolution; reserve a budget per image, then use API usage for
    // actual accounting and reactive compaction for provider context limits.
    total += Array.isArray(m.content) ? m.content.reduce((sum, part) => sum + (part.type === "image_url" ? 4096 : estimateTokens(JSON.stringify(part), isDense)), 0) + 8
      : estimateTokens(m.content ?? "", isDense) + 8;
    if ("tool_calls" in m && m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls), true); // count the call arguments too
    if ("reasoning_content" in m && typeof m.reasoning_content === "string") total += estimateTokens(m.reasoning_content);
  }
  return total;
}

// ---- Measuring the context: real usage + an estimated tail ------------------------
// A pure estimate has to be pessimistic, so it forces compaction early. But
// every response already tells us the truth: usage.prompt_tokens is exactly
// what the last request cost — system prompt, tool manuals, history, all of it.
// So, like Claude Code: context = the last request's real prompt_tokens + an
// estimate of only the messages appended since (the reply, tool results, the
// next prompt). The estimated part is small, so the total is nearly exact.
//
// The anchor remembers the last message that request contained. If that
// message is no longer where it was — compaction or /clear rewrote the array —
// the anchor is stale and we fall back to estimating everything.
type Msg = OpenAI.ChatCompletionMessageParam;
const usageAnchors = new WeakMap<Msg[], { last: Msg; count: number; promptTokens: number }>();

export function recordContextUsage(messages: Msg[], sentCount: number, usage: { prompt_tokens?: number } | null | undefined): void {
  const promptTokens = Number(usage?.prompt_tokens ?? 0);
  if (!sentCount || !promptTokens) return; // nothing sent, or a provider that doesn't report input tokens
  usageAnchors.set(messages, { last: messages[sentCount - 1], count: sentCount, promptTokens });
}

// The tool manuals ride along on every request but aren't messages — a
// history-only estimate misses them (dozens of MCP tools can be tens of thousands of tokens).
export const estimateToolTokens = (): number => estimateTokens(JSON.stringify(toolDefinitions()), true);

export function contextTokens(messages: Msg[]): number {
  const a = usageAnchors.get(messages);
  if (a && messages.length >= a.count && messages[a.count - 1] === a.last) return a.promptTokens + estimateHistoryTokens(messages.slice(a.count));
  return estimateHistoryTokens(messages) + estimateToolTokens(); // no (valid) measurement yet — estimate it all
}

// For the status bar: how close we are to AUTO-COMPACTION (not to the hard
// limit). 100% means the next model call compacts first.
export function contextPercent(messages: Msg[], model = CONFIG.model): number {
  return Math.min(100, Math.round((contextTokens(messages) / compactThreshold(model)) * 100));
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

// ---- Compaction progress ----------------------------------------------------------
// A summary call takes tens of seconds, and a frozen screen reads as a hang. We
// cannot know the true progress (nobody knows the summary's length in advance),
// so we estimate it from two signals and never let it go backwards:
//   - time: before the first token (the model reading a huge prompt, or
//     thinking) the bar creeps toward 15%, so it visibly moves;
//   - output: streamed tokens against an expected summary size. The curve is
//     asymptotic and capped at 95% — only the finished summary says 100%.
export function expectedSummaryTokens(historyTokens: number): number {
  return Math.max(800, Math.min(4000, Math.round(historyTokens * 0.05))); // the 6-section summary grows with the history, within bounds
}
export function compactProgress(elapsedMs: number, outTokens: number, expected: number): number {
  const waiting = 15 * (1 - Math.exp(-elapsedMs / 10_000));
  const writing = 95 * (1 - Math.exp(-(outTokens / expected) * 1.6));
  return Math.min(95, Math.max(waiting, writing));
}

// ---- Compaction itself -----------------------------------------------------------
// Replace the whole history with a structured summary + recovered file state.
// Throws on failure — the loop decides what a failure means.
export async function compactHistory(
  messages: OpenAI.ChatCompletionMessageParam[], // the history, mutated in place
  client: OpenAI, // the same client the loop uses
  model: string, // the same model summarizes its own conversation
  signal: AbortSignal, // Ctrl+C must abort compaction too
  log: (line: string) => void = (s) => console.log(s), // where the result line goes — stdout by default; the Ink REPL routes it through its sink so it doesn't corrupt the live region
  output?: Pick<LoopOutput, "spinner">, // draws the progress bar; without one (quiet callers) a start line is logged instead
): Promise<void> {
  const before = contextTokens(messages); // for the log line — measured, not just estimated
  const spin = output?.spinner(compactingText(0));
  if (!spin) log(chalk.magenta(`📦 compacting context (~${before} tokens)...`)); // automatic behavior must be visible
  const expected = expectedSummaryTokens(before);
  const started = Date.now();
  let outChars = 0; // content + reasoning streamed so far (~4 chars a token)
  let shown = 0; // the bar only moves forward
  const paint = () => {
    shown = Math.max(shown, compactProgress(Date.now() - started, outChars / 4, expected));
    spin?.set(compactingText(shown));
  };
  const timer = spin ? setInterval(paint, 200) : null; // time alone moves the bar while no token arrives
  let summary = "";
  try {
    // Streamed only so the bar has something to measure; the result is the same text.
    const res = (await client.chat.completions.create(
      {
        model, // same model — no need for a fancier one to summarize
        messages: [...effortMessages(model, messages), { role: "user", content: SUMMARY_PROMPT }], // full history + the summary instruction
        stream: true,
        // Deliberately NO `tools` parameter: with no tools declared, the API
        // cannot accept a tool call — that is the hard guarantee. The CRITICAL
        // lines in the prompt are the soft second layer of the same defense.
      },
      { signal }, // still abortable by Ctrl+C
    )) as unknown as AsyncIterable<OpenAI.ChatCompletionChunk> | OpenAI.ChatCompletion;
    if ("choices" in res) summary = res.choices[0]?.message.content ?? ""; // a provider (or test double) that ignored stream: true
    else {
      for await (const chunk of res) {
        const delta = chunk.choices[0]?.delta as { content?: string | null; reasoning_content?: string | null } | undefined;
        summary += delta?.content ?? "";
        outChars += (delta?.content?.length ?? 0) + (delta?.reasoning_content?.length ?? 0); // thinking is work too
      }
    }
  } finally {
    if (timer) clearInterval(timer);
    spin?.stop();
  }
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
  log(chalk.magenta(`📦 compacted: ~${before} → ~${estimateHistoryTokens(messages)} tokens`)); // report the result
}

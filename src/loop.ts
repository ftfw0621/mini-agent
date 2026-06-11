import OpenAI from "openai"; // types + client for the chat completions API
import chalk from "chalk"; // terminal colors for status lines
import ora from "ora"; // the "thinking..." spinner while waiting for the first token
import { toolDefinitions, dispatch } from "./tools.js"; // the tool manuals + the executor
import { classifyError, ApiErrorKind } from "./errors.js"; // failure taxonomy
import { checkPermission } from "./permissions.js"; // the allow/ask/deny gate
import { estimateHistoryTokens, compactHistory, COMPACT_AT, MAX_COMPACTIONS_PER_QUERY, MAX_COMPACT_FAILURES } from "./context.js"; // context management

export const MAX_ROUNDS = 15; // model→tool round cap per query
export const MAX_RETRIES = 10; // total failed API calls per query, across all rounds
export const MAX_RATE_LIMIT_RETRIES = 3; // 429s get their own, much smaller budget
export const MAX_CONSECUTIVE_FAILURES = 3; // the circuit breaker
const BACKOFF_BASE_MS = 500; // first retry waits ~this long
const BACKOFF_CAP_MS = 15_000; // no single wait longer than this
const IDLE_TIMEOUT_MS = 90_000; // no stream events AT ALL for this long → the stream is dead, cut it
const STALL_WARN_MS = 30_000; // events arriving slowly → log only. Slow is not dead — cutting a live stream wastes every token already paid for

// A query has many ways to die. Name every one of them — each gets its own
// user-facing explanation and exit code, instead of a generic "error".
export enum TerminateReason {
  Done = "done", // the model produced a final answer
  RoundCap = "round_cap", // hit MAX_ROUNDS
  CircuitBreaker = "circuit_breaker", // N consecutive failures — stop burning money
  RetryBudgetExhausted = "retry_budget_exhausted", // too many failures overall
  RateLimitBudgetExhausted = "rate_limit_budget_exhausted", // the server keeps saying 429
  ContextTooLong = "context_too_long", // conversation no longer fits the window
  CompactionFailed = "compaction_failed", // automatic compaction kept failing — stop instead of looping
  FatalApiError = "fatal_api_error", // auth/bad request — retrying will never help
  UserInterrupt = "user_interrupt", // Ctrl+C
}

// What the loop hands back to the caller when it ends.
export interface LoopResult {
  reason: TerminateReason; // which ending happened
  finalText?: string; // present when reason === Done
  detail?: string; // raw error info for the curious
}

// Everything the loop needs from the outside world.
export interface LoopOptions {
  client: OpenAI; // the API client (configured by the entry point)
  model: string; // which model to call
  signal: AbortSignal; // aborts the in-flight API request on Ctrl+C
  isInterrupted: () => boolean; // polled between steps for a clean stop
  confirm: (question: string) => Promise<boolean>; // ask the human; resolves false in non-interactive sessions
}

// Exponential backoff with jitter: 500ms, 1s, 2s, ... ±25%, capped.
// Without jitter, every client that failed at the same second retries at the
// same second — a thundering herd against an already-struggling server.
function backoffMs(consecutiveFailures: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_CAP_MS); // grow exponentially, then cap
  return Math.round(base * (1 + Math.random() * 0.25)); // add 0–25% random jitter
}

// Sleep in small slices so Ctrl+C never has to wait out a long backoff.
async function interruptibleSleep(ms: number, isInterrupted: () => boolean): Promise<void> {
  const SLICE = 200; // check for interruption every 200ms
  for (let waited = 0; waited < ms && !isInterrupted(); waited += SLICE) {
    await new Promise((r) => setTimeout(r, Math.min(SLICE, ms - waited))); // sleep one slice (or the remainder)
  }
}

// A tool call assembled from streaming fragments.
interface AssembledCall {
  id: string; // the call id (arrives once)
  name: string; // the function name (arrives once)
  args: string; // the JSON arguments (arrive in many small fragments)
}

// One streaming model call: prints text as it arrives, assembles tool calls
// from their deltas, and guards the stream with a two-level watchdog.
async function streamModelCall(
  messages: OpenAI.ChatCompletionMessageParam[], // the full history to send
  opts: LoopOptions, // client/model/signal
): Promise<{ content: string; toolCalls: AssembledCall[] }> {
  const idleAbort = new AbortController(); // the watchdog's own kill switch
  const signal = AbortSignal.any([opts.signal, idleAbort.signal]); // either the user or the watchdog can abort
  const spinner = ora({ text: "thinking...", discardStdin: false }).start(); // discardStdin:false — ora would otherwise eat Ctrl+C
  let lastEvent = Date.now(); // when did we last hear ANYTHING from the stream?
  let stallWarned = false; // only warn once per quiet stretch

  // The two-level watchdog, checked once per second:
  // - idle (nothing at all for 90s) → cut the stream, let the retry layer handle it
  // - stall (slow but alive for 30s) → log it and keep waiting
  const watchdog = setInterval(() => {
    const quiet = Date.now() - lastEvent; // ms since the last event
    if (quiet > IDLE_TIMEOUT_MS) idleAbort.abort(); // dead — cut it
    else if (quiet > STALL_WARN_MS && !stallWarned) {
      stallWarned = true; // don't repeat the warning every second
      console.log(chalk.dim(`  [watchdog] stream quiet for ${Math.round(quiet / 1000)}s — still waiting (slow ≠ dead)`));
    }
  }, 1000);

  try {
    const stream = await opts.client.chat.completions.create(
      { model: opts.model, messages, tools: toolDefinitions, stream: true }, // stream: print tokens as they are born
      { signal }, // abortable by user AND watchdog
    );
    let content = ""; // accumulated answer text
    let printedPrefix = false; // have we printed the 🤖 prefix yet?
    const calls: AssembledCall[] = []; // tool calls under assembly, indexed by delta.index
    for await (const chunk of stream) {
      lastEvent = Date.now(); // feed the watchdog
      stallWarned = false; // the stream spoke — reset the stall warning
      const delta = chunk.choices[0]?.delta; // this chunk's increment
      if (!delta) continue; // keep-alive or usage chunk — nothing to do
      if (delta.content) {
        if (spinner.isSpinning) spinner.stop(); // first token: replace the spinner with real output
        if (!printedPrefix) {
          process.stdout.write("\n🤖 "); // prefix once, then stream raw
          printedPrefix = true;
        }
        process.stdout.write(delta.content); // print the token immediately — this IS the streaming UX
        content += delta.content; // and keep it for the history
      }
      for (const tc of delta.tool_calls ?? []) {
        if (spinner.isSpinning) spinner.stop(); // tool call starting — spinner served its purpose
        const slot = (calls[tc.index] ??= { id: "", name: "", args: "" }); // create the slot on first fragment
        if (tc.id) slot.id = tc.id; // id arrives once
        if (tc.function?.name) slot.name += tc.function.name; // name usually arrives whole; += is safe either way
        if (tc.function?.arguments) slot.args += tc.function.arguments; // arguments stream in fragments — concatenate
      }
    }
    if (printedPrefix) process.stdout.write("\n"); // end the streamed line cleanly
    return { content, toolCalls: calls.filter(Boolean) }; // sparse array → dense
  } finally {
    clearInterval(watchdog); // always stop the timer
    if (spinner.isSpinning) spinner.stop(); // and never leave a zombie spinner
  }
}

// Run one compaction attempt and keep score. Returns true on success.
// Every automatic behavior keeps a failure count — that is what lets the
// caller stop a hot failure loop instead of compacting forever.
async function tryCompact(
  messages: OpenAI.ChatCompletionMessageParam[], // history to compact (mutated in place)
  opts: LoopOptions, // for client/model/signal
  compaction: { count: number; failures: number }, // the shared score card
): Promise<boolean> {
  try {
    await compactHistory(messages, opts.client, opts.model, opts.signal); // do the actual work
    compaction.count++; // one more successful compaction this query
    compaction.failures = 0; // success resets the failure streak
    return true;
  } catch {
    compaction.failures++; // failed — count it against the breaker
    return false;
  }
}

// The agent main loop, as a state machine: every iteration either continues
// for a named reason or terminates for a named reason — nothing implicit.
export async function runLoop(
  messages: OpenAI.ChatCompletionMessageParam[], // conversation history (mutated in place)
  opts: LoopOptions, // injected dependencies, see above
): Promise<LoopResult> {
  // The loop's mutable state: budgets and counters, rewritten every iteration.
  const attempts = { total: 0, rateLimited: 0, consecutive: 0 };
  const compaction = { count: 0, failures: 0 }; // compaction score card for this query

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // One round = one successful model call + its tool results.
    // The inner loop retries the model call until it succeeds or a budget dies.
    while (true) {
      if (opts.isInterrupted()) return { reason: TerminateReason.UserInterrupt }; // user asked us to stop — obey before spending money

      // Proactive compaction: act BEFORE the API rejects us. Waiting for the
      // hard limit means the failure already happened.
      if (estimateHistoryTokens(messages) > COMPACT_AT) {
        if (compaction.count >= MAX_COMPACTIONS_PER_QUERY)
          return { reason: TerminateReason.CompactionFailed, detail: `already compacted ${compaction.count}x this query — the task is too big for one session` };
        const ok = await tryCompact(messages, opts, compaction); // shrink the history
        if (!ok && compaction.failures >= MAX_COMPACT_FAILURES)
          return { reason: TerminateReason.CompactionFailed, detail: `${compaction.failures} consecutive compaction failures` }; // the compaction circuit breaker
      }

      let out: { content: string; toolCalls: AssembledCall[] }; // the assembled reply for this round
      try {
        out = await streamModelCall(messages, opts); // streaming call with spinner + watchdog
      } catch (err) {
        // Interrupt first: an aborted request can surface as all kinds of
        // errors, and none of them deserve a retry line.
        if (opts.isInterrupted()) return { reason: TerminateReason.UserInterrupt };
        let e = classifyError(err); // turn the raw exception into a named kind
        if (e.kind === ApiErrorKind.Aborted) {
          // The user did NOT press Ctrl+C (checked above), so this abort came
          // from the idle watchdog — treat it as a retryable timeout.
          e = { kind: ApiErrorKind.Timeout, retryable: true, message: "stream went silent for 90s — cut by the idle watchdog" };
        }
        if (e.kind === ApiErrorKind.ContextTooLong) {
          // Reactive compaction: the API just told us we're too big — our
          // estimate was wrong. Compact and retry instead of giving up.
          if (compaction.count < MAX_COMPACTIONS_PER_QUERY && (await tryCompact(messages, opts, compaction)))
            continue; // history is smaller now — retry the same round
          return { reason: TerminateReason.ContextTooLong, detail: e.message }; // compaction could not save us
        }
        if (!e.retryable) return { reason: TerminateReason.FatalApiError, detail: `${e.kind}: ${e.message}` }; // bad key etc. — stop now

        attempts.total++; // every failure consumes the overall budget
        attempts.consecutive++; // ...and the breaker counter
        if (e.kind === ApiErrorKind.RateLimited) attempts.rateLimited++; // 429s also consume their own budget

        // Order matters: the breaker fires first (hot failure loop), then the
        // specific 429 budget, then the overall budget.
        if (attempts.consecutive >= MAX_CONSECUTIVE_FAILURES)
          return { reason: TerminateReason.CircuitBreaker, detail: `${e.kind}: ${e.message}` };
        if (attempts.rateLimited >= MAX_RATE_LIMIT_RETRIES)
          return { reason: TerminateReason.RateLimitBudgetExhausted, detail: e.message };
        if (attempts.total >= MAX_RETRIES)
          return { reason: TerminateReason.RetryBudgetExhausted, detail: `${e.kind}: ${e.message}` };

        const wait = backoffMs(attempts.consecutive); // how long to back off this time
        console.log(chalk.dim(`  [retry] ${e.kind} — attempt ${attempts.total}/${MAX_RETRIES}, waiting ${wait}ms`)); // retries must be visible, or the app just looks frozen
        await interruptibleSleep(wait, opts.isInterrupted); // wait, but stay responsive to Ctrl+C
        continue; // retry the same round
      }

      // An aborted stream does not always throw — sometimes it just ends
      // early and looks like success. Check the flag explicitly, and keep the
      // partial text in history (clearly marked) so the next turn makes sense.
      if (opts.isInterrupted()) {
        if (out.content) messages.push({ role: "assistant", content: out.content + "\n[interrupted by user]" }); // text only — partial tool calls must NOT go in (they would need paired results)
        return { reason: TerminateReason.UserInterrupt };
      }

      attempts.consecutive = 0; // success resets the breaker — but never the total budget

      // Rebuild the assistant message from the assembled stream and add it to
      // history — tool results must stay paired with their calls.
      messages.push({
        role: "assistant", // the model's turn
        content: out.content || null, // null when the turn was tool calls only
        ...(out.toolCalls.length
          ? { tool_calls: out.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } })) }
          : {}), // omit the field entirely when there were no calls
      });

      if (!out.toolCalls.length) {
        return { reason: TerminateReason.Done, finalText: out.content }; // no tool calls = final answer (already streamed to the screen)
      }

      // Execute every tool call, each behind the permission gate.
      for (const call of out.toolCalls) {
        console.log(chalk.cyan(`🔧 ${call.name}`) + chalk.dim(` ${call.args.slice(0, 120)}`)); // show what the model wants to do

        // The permission gate sits between the model's intent and execution.
        const v = checkPermission(call.name, call.args);
        let content: string; // what goes back to the model as the tool result
        if (v.decision === "deny") {
          console.log(chalk.red(`  ⛔ denied: ${v.reason}`)); // tell the user we blocked it
          content = `[permission] Denied: ${v.reason}. This is a hard rule — do not try to work around it; pick a different approach or ask the user.`; // teach the model the boundary
        } else if (v.decision === "ask") {
          const ok = await opts.confirm(`${call.name} (${v.reason}):\n   ${v.summary}`); // pause and ask the human
          if (!ok) console.log(chalk.yellow("  ✋ declined")); // make the refusal visible
          content = ok
            ? dispatch(call.name, call.args) // approved — actually run it
            : `[permission] The user declined this action. Ask them how to proceed, or choose a safer alternative.`; // declined — tell the model
        } else {
          content = dispatch(call.name, call.args); // allow — run without ceremony
        }
        messages.push({ role: "tool", tool_call_id: call.id, content }); // feed the result back, paired by id
      }
      break; // round complete, move to the next one
    }
  }
  return { reason: TerminateReason.RoundCap }; // ran out of rounds before a final answer
}

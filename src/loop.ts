import OpenAI from "openai"; // types + client for the chat completions API
import chalk from "chalk"; // terminal colors for status lines
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

      let res: OpenAI.ChatCompletion; // the model's reply for this round
      try {
        res = await opts.client.chat.completions.create(
          { model: opts.model, messages, tools: toolDefinitions }, // full history + tool manuals
          { signal: opts.signal }, // lets Ctrl+C abort the request mid-flight
        );
      } catch (err) {
        // Interrupt first: an aborted request can surface as all kinds of
        // errors, and none of them deserve a retry line.
        if (opts.isInterrupted()) return { reason: TerminateReason.UserInterrupt };
        const e = classifyError(err); // turn the raw exception into a named kind
        if (e.kind === ApiErrorKind.Aborted) return { reason: TerminateReason.UserInterrupt }; // belt and suspenders
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

      attempts.consecutive = 0; // success resets the breaker — but never the total budget

      const msg = res.choices[0].message; // the model's reply
      messages.push(msg); // into history, so tool results stay paired with their calls

      if (!msg.tool_calls?.length) {
        return { reason: TerminateReason.Done, finalText: msg.content ?? "" }; // no tool calls = final answer
      }

      // Execute every tool call, each behind the permission gate.
      for (const call of msg.tool_calls) {
        if (call.type !== "function") continue; // ignore non-function call types
        console.log(chalk.cyan(`🔧 ${call.function.name}`) + chalk.dim(` ${call.function.arguments.slice(0, 120)}`)); // show what the model wants to do

        // The permission gate sits between the model's intent and execution.
        const v = checkPermission(call.function.name, call.function.arguments);
        let content: string; // what goes back to the model as the tool result
        if (v.decision === "deny") {
          console.log(chalk.red(`  ⛔ denied: ${v.reason}`)); // tell the user we blocked it
          content = `[permission] Denied: ${v.reason}. This is a hard rule — do not try to work around it; pick a different approach or ask the user.`; // teach the model the boundary
        } else if (v.decision === "ask") {
          const ok = await opts.confirm(`${call.function.name} (${v.reason}):\n   ${v.summary}`); // pause and ask the human
          if (!ok) console.log(chalk.yellow("  ✋ declined")); // make the refusal visible
          content = ok
            ? dispatch(call.function.name, call.function.arguments) // approved — actually run it
            : `[permission] The user declined this action. Ask them how to proceed, or choose a safer alternative.`; // declined — tell the model
        } else {
          content = dispatch(call.function.name, call.function.arguments); // allow — run without ceremony
        }
        messages.push({ role: "tool", tool_call_id: call.id, content }); // feed the result back, paired by id
      }
      break; // round complete, move to the next one
    }
  }
  return { reason: TerminateReason.RoundCap }; // ran out of rounds before a final answer
}

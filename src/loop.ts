import OpenAI from "openai"; // types + client for the chat completions API
import chalk from "chalk"; // terminal colors for status lines
import { toolDefinitions, dispatch } from "./tools.js"; // the tool manuals + the executor
import { classifyError, ApiErrorKind } from "./errors.js"; // failure taxonomy

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

// The agent main loop, as a state machine: every iteration either continues
// for a named reason or terminates for a named reason — nothing implicit.
export async function runLoop(
  messages: OpenAI.ChatCompletionMessageParam[], // conversation history (mutated in place)
  opts: LoopOptions, // injected dependencies, see above
): Promise<LoopResult> {
  // The loop's mutable state: budgets and counters, rewritten every iteration.
  const attempts = { total: 0, rateLimited: 0, consecutive: 0 };

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // One round = one successful model call + its tool results.
    // The inner loop retries the model call until it succeeds or a budget dies.
    while (true) {
      if (opts.isInterrupted()) return { reason: TerminateReason.UserInterrupt }; // user asked us to stop — obey before spending money

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
        if (e.kind === ApiErrorKind.ContextTooLong)
          return { reason: TerminateReason.ContextTooLong, detail: e.message }; // retrying the same payload cannot help
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
      // Execute every tool call via the single dispatch entry point.
      for (const call of msg.tool_calls) {
        if (call.type !== "function") continue; // ignore non-function call types
        console.log(chalk.cyan(`🔧 ${call.function.name}`) + chalk.dim(` ${call.function.arguments.slice(0, 120)}`)); // show what is being called
        messages.push({
          role: "tool", // the tool-result message role
          tool_call_id: call.id, // paired with the call by id
          content: dispatch(call.function.name, call.function.arguments), // dispatch never throws
        });
      }
      break; // round complete, move to the next one
    }
  }
  return { reason: TerminateReason.RoundCap }; // ran out of rounds before a final answer
}

import OpenAI from "openai"; // types + client for the chat completions API
import chalk from "chalk"; // terminal colors for status lines
import ora from "ora"; // the "thinking..." spinner while waiting for the first token
import { toolDefinitions, dispatch, snapshotFileState, restoreFileState, isReadOnlyTool } from "./tools.js"; // the tool manuals + the executor + file-state isolation
import { classifyError, ApiErrorKind } from "./errors.js"; // failure taxonomy
import { checkPermission } from "./permissions.js"; // the allow/ask/deny gate
import { previewChange } from "./diff.js"; // show the diff before a write so approval is informed
import { estimateHistoryTokens, compactHistory, COMPACT_AT, MAX_COMPACTIONS_PER_QUERY, MAX_COMPACT_FAILURES } from "./context.js"; // context management
import { SUB_AGENT_PROMPT } from "./prompt.js"; // the sub-agent's own constitution
import { emit } from "./telemetry.js"; // local-only event log (no-op unless the CLI armed it)
import { runHooks } from "./hooks.js"; // user lifecycle hooks (PreToolUse / PostToolUse / Stop)
import type { Judge } from "./judge.js"; // optional LLM permission classifier
import { recordUsage } from "./cost.js"; // meter token usage from the stream

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
  quiet?: boolean; // suppress all narration (used by the eval harness)
  subAgent?: boolean; // this loop IS a sub-agent: no task tool, no text streaming, indented tool logs
  subAgentModel?: string; // model to run delegated sub-agents on; falls back to `model`
  judge?: Judge; // optional LLM classifier that auto-allows clearly-safe "ask" commands
}

// Which model should a delegated sub-agent run on? The configured sub-agent
// model if set and non-blank, otherwise the same model as the orchestrator.
// Pulled out as a pure function so the tiering rule is testable on its own.
export function subAgentModelFor(opts: { model: string; subAgentModel?: string }): string {
  return opts.subAgentModel?.trim() || opts.model;
}

// The task tool: the parent's handle on sub-agents. Defined here (not in
// tools.ts) because running it needs the loop itself — it IS a loop.
const taskTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "task",
    description: `Delegate one self-contained subtask to a sub-agent that works in a FRESH context.
The sub-agent has the same tools (except task) but knows NOTHING about this conversation — put every detail it needs into the description.
Use it for exploration that would flood your context: reading many files, broad searches, summarizing a directory.
The sub-agent's report is INPUT MATERIAL, not verified truth — re-check key claims yourself before acting on them.
On error: a failed sub-agent returns [sub-agent failed: reason] — retry with a clearer description, or do the work yourself.`,
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "The complete, self-contained task for the sub-agent" },
      },
      required: ["description"],
    },
  },
};

// Run one sub-agent: a fresh conversation, same tools minus task, same
// permission gate, and the parent's file read-state protected by a snapshot.
async function runSubAgent(description: string, opts: LoopOptions): Promise<string> {
  emit("agent_subagent_spawn"); // delegation is worth counting
  const subModel = subAgentModelFor(opts); // the tier this delegated work runs on
  // Show the delegation, and the model when it differs from the orchestrator's —
  // the tiering should be visible, not a silent surprise on the bill.
  if (!opts.quiet) {
    const tier = subModel !== opts.model ? chalk.dim(` [${subModel}]`) : ""; // only annotate a real switch
    console.log(chalk.blue(`  ⎿ sub-agent started:`) + tier + chalk.blue(` ${description.slice(0, 100)}`));
  }
  const snapshot = snapshotFileState(); // what the sub-agent reads, the parent has NOT seen
  try {
    const subMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: SUB_AGENT_PROMPT }, // its own, smaller constitution
      { role: "user", content: description }, // the task is its entire world
    ];
    const result = await runLoop(subMessages, { ...opts, subAgent: true, model: subModel }); // recurse as a sub-agent, on its own tier
    if (result.reason === TerminateReason.Done && result.finalText?.trim()) {
      // The framing matters: the parent must treat this as material to verify,
      // not as conclusions to copy — the most common multi-agent failure mode.
      return `Sub-agent report (INPUT MATERIAL — verify key claims before acting on them):\n${result.finalText}`;
    }
    return `[sub-agent failed: ${result.reason}]`; // any non-Done ending, compressed to one line
  } finally {
    restoreFileState(snapshot); // the parent's read-before-edit state, exactly as it was
    if (!opts.quiet) console.log(chalk.blue("  ⎿ sub-agent done")); // close the bracket
  }
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
  const spinner = opts.quiet
    ? null // the eval harness wants silence
    : ora({ text: opts.subAgent ? "sub-agent working..." : "thinking...", discardStdin: false }).start(); // discardStdin:false — ora would otherwise eat Ctrl+C
  let lastEvent = Date.now(); // when did we last hear ANYTHING from the stream?
  let stallWarned = false; // only warn once per quiet stretch

  // The two-level watchdog, checked once per second:
  // - idle (nothing at all for 90s) → cut the stream, let the retry layer handle it
  // - stall (slow but alive for 30s) → log it and keep waiting
  const watchdog = setInterval(() => {
    const quietMs = Date.now() - lastEvent; // ms since the last event
    if (quietMs > IDLE_TIMEOUT_MS) {
      emit("agent_watchdog_idle"); // record the cut — these should be rare
      idleAbort.abort(); // dead — cut it
    } else if (quietMs > STALL_WARN_MS && !stallWarned) {
      stallWarned = true; // don't repeat the warning every second
      emit("agent_watchdog_stall"); // record the slowness — pattern-spotting data
      console.log(chalk.dim(`  [watchdog] stream quiet for ${Math.round(quietMs / 1000)}s — still waiting (slow ≠ dead)`));
    }
  }, 1000);

  try {
    emit("agent_api_call"); // one event per attempt — retries show up as extra calls
    const stream = await opts.client.chat.completions.create(
      // Sub-agents do NOT get the task tool: one level of delegation only.
      // Nested spawning means orphan processes and debugging hell.
      // include_usage adds a final chunk carrying token counts — that is how we
      // meter cost without a second (counting) request.
      { model: opts.model, messages, tools: opts.subAgent ? toolDefinitions() : [...toolDefinitions(), taskTool], stream: true, stream_options: { include_usage: true } },
      { signal }, // abortable by user AND watchdog
    );
    let content = ""; // accumulated answer text
    let printedPrefix = false; // have we printed the 🤖 prefix yet?
    const calls: AssembledCall[] = []; // tool calls under assembly, indexed by delta.index
    for await (const chunk of stream) {
      lastEvent = Date.now(); // feed the watchdog
      stallWarned = false; // the stream spoke — reset the stall warning
      if (chunk.usage) recordUsage(chunk.usage as unknown as Record<string, unknown>); // the final usage chunk — meter it
      const delta = chunk.choices[0]?.delta; // this chunk's increment
      if (!delta) continue; // keep-alive or usage chunk — nothing to do
      if (delta.content) {
        if (spinner?.isSpinning) spinner.stop(); // first token: replace the spinner with real output
        if (!opts.quiet && !opts.subAgent) {
          // Only the top-level agent streams to the screen — a sub-agent's
          // inner monologue would be mistaken for the answer.
          if (!printedPrefix) {
            process.stdout.write("\n🤖 "); // prefix once, then stream raw
            printedPrefix = true;
          }
          process.stdout.write(delta.content); // print the token immediately — this IS the streaming UX
        }
        content += delta.content; // always keep it for the history
      }
      for (const tc of delta.tool_calls ?? []) {
        if (spinner?.isSpinning) spinner.stop(); // tool call starting — spinner served its purpose
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
    if (spinner?.isSpinning) spinner.stop(); // and never leave a zombie spinner
  }
}

// Run one tool call end to end: log it, run it through the permission gate,
// ask the human if needed, execute, and return the paired result. Read-only
// calls (allow/deny only, never "ask") are safe to run via this from inside a
// Promise.all batch; calls that can prompt must be awaited one at a time.
async function runOneCall(call: AssembledCall, opts: LoopOptions): Promise<{ id: string; content: string }> {
  const indent = opts.subAgent ? chalk.blue("  ⎿ ") : ""; // sub-agent activity is visually nested
  if (!opts.quiet) console.log(indent + chalk.cyan(`🔧 ${call.name}`) + chalk.dim(` ${call.args.slice(0, 120)}`)); // show what the model wants to do

  // The permission gate sits between the model's intent and execution.
  const v = checkPermission(call.name, call.args);
  emit("agent_tool_call", { tool: call.name }); // every attempt, allowed or not

  // For file-changing tools, show the diff BEFORE the gate decides. A filename
  // ("edit_file: cart.js") is not enough to approve safely; the actual +/- lines
  // are. Skipped for a hard deny (nothing will run) and in quiet sub-agent runs.
  if (!opts.quiet && v.decision !== "deny" && (call.name === "write_file" || call.name === "edit_file")) {
    const preview = previewChange(call.name, call.args);
    if (preview) console.log(preview.replace(/^/gm, indent)); // nest under the sub-agent marker if any
  }
  let content: string; // what goes back to the model as the tool result
  if (v.decision === "deny") {
    emit("agent_tool_denied", { tool: call.name }); // hard blocks, per tool
    if (!opts.quiet) console.log(chalk.red(`  ⛔ denied: ${v.reason}`)); // tell the user we blocked it
    content = `[permission] Denied: ${v.reason}. This is a hard rule — do not try to work around it; pick a different approach or ask the user.`; // teach the model the boundary
  } else if (v.decision === "ask") {
    // Optional LLM judge: for a run_bash command the rules couldn't classify,
    // ask the judge first. It can only DOWNGRADE ask→allow for the clearly
    // safe; anything else still goes to the human. The judge never sees a deny.
    let autoAllowed = false;
    if (opts.judge && call.name === "run_bash") {
      let cmd = "";
      try { cmd = (JSON.parse(call.args) as { command?: string }).command ?? ""; } catch { /* leave empty → judge will ask */ }
      if (cmd && (await opts.judge.classify(cmd)) === "allow") {
        autoAllowed = true;
        if (!opts.quiet) console.log(chalk.dim("  ⚖ judge: clearly safe, auto-allowed")); // visible — the user can see the judge worked
      }
    }
    const ok = autoAllowed || (await opts.confirm(`${call.name} (${v.reason}):\n   ${v.summary}`)); // judge-allowed, or pause and ask the human
    if (!ok) emit("agent_tool_declined", { tool: call.name }); // the human said no — that is signal
    if (!ok && !opts.quiet) console.log(chalk.yellow("  ✋ declined")); // make the refusal visible
    content = ok
      ? await runWithHooks(call, opts) // approved — run it (PreToolUse can still block)
      : `[permission] The user declined this action. Ask them how to proceed, or choose a safer alternative.`; // declined — tell the model
  } else {
    content = await runWithHooks(call, opts); // allow — run it (PreToolUse can still block)
  }
  return { id: call.id, content }; // paired by id for the API
}

// Run an approved tool call, surrounded by the user's lifecycle hooks.
// PreToolUse can block (exit 2) — its stderr is fed back to the model as the
// reason, exactly like a permission denial, so the model adapts instead of
// retrying. PostToolUse is observational; if it blocks, its message is appended
// to the tool result as extra context (e.g. "lint failed on the file you just
// wrote"). Sub-agents skip hooks: hooks are about the human's project policy,
// not internal delegation.
async function runWithHooks(call: AssembledCall, opts: LoopOptions): Promise<string> {
  if (opts.subAgent) return execute(call, opts); // sub-agents run hook-free

  const pre = await runHooks("PreToolUse", { tool: call.name, args: call.args }); // before
  if (pre.block) {
    emit("agent_hook_block", { event: "PreToolUse", tool: call.name }); // a hook said no
    if (!opts.quiet) console.log(chalk.red(`  ⛔ blocked by PreToolUse hook`)); // make it visible
    return `[hook] A PreToolUse hook blocked this call: ${pre.feedback}. Treat this as a hard boundary — adjust your approach.`;
  }

  const result = await execute(call, opts); // the actual work

  const post = await runHooks("PostToolUse", { tool: call.name, args: call.args, result }); // after
  if (post.block) {
    // PostToolUse cannot undo the action, but it can tell the model something
    // is wrong with the result — surface that as appended context.
    return `${result}\n\n[hook] PostToolUse: ${post.feedback}`;
  }
  return result;
}

// Execute one approved tool call. The task tool is special — it is not in the
// registry because running it needs the loop itself (it IS a loop).
async function execute(call: AssembledCall, opts: LoopOptions): Promise<string> {
  if (call.name !== "task") return dispatch(call.name, call.args, opts.signal); // ordinary tools go through the registry (signal lets Ctrl+C kill run_bash)
  if (opts.subAgent) return "[error] Sub-agents cannot spawn sub-agents. Do the work yourself."; // one level of delegation only
  let description = ""; // the sub-task text
  try {
    description = (JSON.parse(call.args) as { description?: string }).description ?? ""; // arguments arrive as JSON
  } catch {
    /* fall through to the error below */
  }
  if (!description) return "[error] task requires a non-empty description argument.";
  return runSubAgent(description, opts); // spawn the worker
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
    emit("agent_compaction_ok"); // worth counting — frequent compaction means tasks are too big
    return true;
  } catch {
    compaction.failures++; // failed — count it against the breaker
    emit("agent_compaction_failed"); // a failure streak here trips the breaker
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

        emit("agent_api_error", { kind: e.kind, attempt: attempts.total + 1 }); // classified, greppable
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
        // The model wants to stop. A Stop hook gets the last word: if it exits
        // 2, the agent is NOT done — its stderr becomes a new instruction and
        // the loop continues. This is how you build test-driven AI: a Stop hook
        // runs the tests, blocks while they fail, and the agent keeps fixing.
        // Sub-agents are exempt — Stop hooks are the human's project policy.
        if (!opts.subAgent) {
          const stop = await runHooks("Stop", { finalText: out.content }); // give hooks the last word
          if (stop.block) {
            emit("agent_hook_block", { event: "Stop" }); // the agent was sent back to work
            if (!opts.quiet) console.log(chalk.yellow(`\n↩ Stop hook: not done yet — ${stop.feedback.slice(0, 120)}`)); // show why
            messages.push({ role: "user", content: `[Stop hook] You are not finished: ${stop.feedback}` }); // inject the instruction
            break; // exit the inner while → advance the round counter (so a stubborn Stop hook is still bounded by MAX_ROUNDS)
          }
        }
        return { reason: TerminateReason.Done, finalText: out.content }; // no tool calls = final answer (already streamed to the screen)
      }

      // Execute the tool calls. Read-only calls (read_file/search) in a
      // contiguous run are executed CONCURRENTLY — they cannot conflict and
      // never need an interactive prompt. Anything that writes or executes runs
      // ALONE and in order: writes can depend on each other, and we can only ask
      // the human one question at a time. This greedy batching mirrors how
      // Claude Code parallelizes safe reads while serializing risky work.
      let i = 0; // index into out.toolCalls
      while (i < out.toolCalls.length) {
        const batch: AssembledCall[] = []; // a run of safe, parallelizable calls
        while (i < out.toolCalls.length && isReadOnlyTool(out.toolCalls[i].name)) batch.push(out.toolCalls[i++]);
        if (batch.length) {
          // Run the whole read-only batch at once, preserving result order.
          const results = await Promise.all(batch.map((c) => runOneCall(c, opts)));
          for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
          continue; // back to the top — the next call is non-read-only
        }
        // A single non-read-only call: gate, maybe ask, execute — all serial.
        const r = await runOneCall(out.toolCalls[i++], opts);
        messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
      break; // round complete, move to the next one
    }
  }
  return { reason: TerminateReason.RoundCap }; // ran out of rounds before a final answer
}

import OpenAI from "openai"; // types + client for the chat completions API
import chalk from "chalk"; // terminal colors for status lines
import ora from "ora"; // the "thinking..." spinner while waiting for the first token
import { toolDefinitions, dispatch, snapshotFileState, restoreFileState, isReadOnlyTool } from "./tools.js"; // the tool manuals + the executor + file-state isolation
import { classifyError, ApiErrorKind } from "./errors.js"; // failure taxonomy
import { checkPermission } from "./permissions.js"; // the allow/ask/deny gate
import { previewChange } from "./diff.js"; // show the diff before a write so approval is informed
import { estimateHistoryTokens, compactHistory, COMPACT_AT, MAX_COMPACTIONS_PER_QUERY, MAX_COMPACT_FAILURES } from "./context.js"; // context management
import { SUB_AGENT_PROMPT, TEAMMATE_PROMPT } from "./prompt.js"; // the sub-agent + teammate constitutions
import { LEAD, MAX_TEAMMATES, sendMessage, sendProtocol, readInbox, inboxCount, registerTeammate, finishTeammate, teammateExists, teammateCount, createRequest, resolveResponse, setTeammateState, anyTeammateBusy, runningTeammates, markShutdown, shutdownRequestId, resetTeam } from "./team.js"; // agent teams (Day 38) + team protocols (Day 39): mailboxes, registry, request/response contracts
import { emit } from "./telemetry.js"; // local-only event log (no-op unless the CLI armed it)
import { runHooks } from "./hooks.js"; // user lifecycle hooks (PreToolUse / PostToolUse / Stop)
import type { Judge } from "./judge.js"; // optional LLM permission classifier
import { recordUsage } from "./cost.js"; // meter token usage from the stream
import { mark, thinkingWord, spinnerText } from "./ui.js"; // centralized terminal styling (markers, spinner)
import { printToolSummary } from "./tui.js"; // collapsible tool output
import { MarkdownStream } from "./markdown.js"; // render the streamed answer as terminal markdown
import { todoNag, getTodos, renderTodos } from "./todos.js"; // the agent's plan: show it on screen + nag when it goes stale
import { pendingNotifications } from "./background.js"; // background tasks (Day 37): surface finished jobs as a turn

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
  confirm: (question: string, toolName?: string) => Promise<boolean>; // ask the human; resolves false in non-interactive sessions. toolName lets "don't ask again" target the right tool
  quiet?: boolean; // suppress all narration (used by the eval harness)
  subAgent?: boolean; // this loop IS a sub-agent: no task tool, no text streaming, indented tool logs
  teammate?: { name: string }; // this loop IS a teammate on a team (Day 38): has send_message + an inbox, reads its mailbox each round, runs bounded; implies subAgent behavior
  maxRounds?: number; // hard cap on rounds for this loop (teammates are bounded so a team can't run away); unset = the usual unbounded-with-safeguards loop
  subAgentModel?: string; // model to run delegated sub-agents on; falls back to `model`
  judge?: Judge; // optional LLM classifier that auto-allows clearly-safe "ask" commands
  askUser?: (questions: { question: string; options: string[] }[]) => Promise<{ question: string; answer: string }[] | null>; // present a multi-question form (Day 30); null if cancelled/non-interactive
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

// The ask_user tool: the model's handle on the user. When it needs the human to
// choose between options, it calls this instead of asking in prose — and gets
// back clean, structured selections rather than a free-text paragraph to parse.
const askUserTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "ask_user",
    description: `Ask the user one or more multiple-choice questions and get back their selections. Use this WHENEVER you need the user to make a decision between options (which approach, which file, yes/no/which) — it is easier for them to pick than to type, and the answers come back unambiguous.
Provide each question with 2–4 concrete options. Do NOT use it for open-ended input that has no clear options; ask in prose for that.
If the user cancels, you'll be told — then proceed with your best judgment or ask again.`,
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "The questions to ask, each with a list of options",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The question text" },
              options: { type: "array", items: { type: "string" }, description: "2–4 concrete choices" },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
};

// The spawn_teammate tool (Day 38): the Lead's handle on a PERSISTENT worker.
// Unlike `task` (one-shot, returns once), a teammate runs concurrently and keeps
// talking — it messages the lead as it works and is reachable via send_message.
// Defined here (not tools.ts) because running it needs the loop itself.
const spawnTeammateTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "spawn_teammate",
    description: `Spawn a PERSISTENT teammate that works in parallel with you and the rest of the team. Use this for a large task with distinct streams of work that need to coordinate as they go (e.g. one teammate on the API, one on the database) — not for a quick lookup (use task) or a single linear job (do it yourself).
The teammate runs concurrently in a fresh context with read/write/search/bash tools. It can message you and other teammates at any time, and you'll receive its result when it finishes. You can run a few at once.
Give it a short unique name and a one-line role, and a complete self-contained task (it knows nothing about this conversation). After spawning, keep coordinating: you'll get its messages in your inbox; reply with send_message.`,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short, unique name for the teammate (e.g. 'api', 'db', 'tests')" },
        role: { type: "string", description: "One line describing its specialty/responsibility" },
        task: { type: "string", description: "The complete, self-contained task for the teammate to carry out" },
      },
      required: ["name", "role", "task"],
    },
  },
};

// The send_message tool (Day 38): drop a message in another agent's mailbox.
// Available to the Lead AND to teammates — it is how a team coordinates.
const sendMessageTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "send_message",
    description: `Send a message to another agent on the team (a teammate by name, or "lead"). The message lands in their inbox and they see it on their next round. Use it to share findings, hand off work, ask a specific question, or report progress to the lead. Returns once delivered; it does NOT wait for a reply — keep working, and their response will arrive in your inbox.`,
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: 'Recipient agent name, or "lead" for the coordinator' },
        content: { type: "string", description: "The message text" },
      },
      required: ["to", "content"],
    },
  },
};

// The team protocol tools (Day 39). Both sides of each contract are a tool:
// the lead asks for shutdown / reviews a plan; a teammate submits a plan. Each
// carries a request_id so the answer can be correlated to the ask.
const requestShutdownTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "request_shutdown",
    description: `Ask a teammate to shut down GRACEFULLY. It finishes what it's mid-way through, confirms, and exits cleanly — far better than abandoning it (which can leave a half-written file). Use it when a teammate's part is done, or when you're wrapping up the whole task. You'll get a shutdown confirmation back. (When you finish, any teammates still up are shut down for you automatically.)`,
    parameters: {
      type: "object",
      properties: {
        teammate: { type: "string", description: "Name of the teammate to shut down" },
        reason: { type: "string", description: "Optional short reason, shown to the teammate" },
      },
      required: ["teammate"],
    },
  },
};
const requestPlanTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "request_plan",
    description: `Tell a teammate to submit a PLAN (via submit_plan) and wait for your approval BEFORE it carries out a risky or far-reaching change (e.g. an auth refactor, a schema migration). Use this when you want to pre-authorize high-stakes work instead of reviewing the damage after. The teammate will send you a plan_approval_request; approve or reject it with review_plan.`,
    parameters: {
      type: "object",
      properties: {
        teammate: { type: "string", description: "Name of the teammate" },
        task: { type: "string", description: "The risky work it must plan before doing" },
      },
      required: ["teammate", "task"],
    },
  },
};
const reviewPlanTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "review_plan",
    description: `Approve or reject a plan a teammate submitted for approval. You'll have received a plan_approval_request with a request_id — pass that id and your decision. On approval the teammate proceeds; on rejection it revises and may submit again. Always include a brief reason on a rejection so it can fix the plan.`,
    parameters: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request_id from the plan_approval_request" },
        decision: { type: "string", enum: ["approve", "reject"], description: "approve | reject" },
        reason: { type: "string", description: "Short reason (required-in-spirit on a rejection)" },
      },
      required: ["request_id", "decision"],
    },
  },
};
const submitPlanTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "submit_plan",
    description: `Submit a PLAN to the lead and wait for approval BEFORE carrying out a risky or far-reaching change. Use it whenever you're about to do something high-stakes (refactor auth, migrate a schema, delete/rewrite many files) — propose first, act after. After you call this, STOP and wait: the lead's approval (or rejection) will arrive in your inbox. Do not start the work until it's approved.`,
    parameters: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The concise, ordered plan you intend to carry out" },
      },
      required: ["plan"],
    },
  },
};

// Which tool manuals does THIS agent get? One place so the three agent kinds
// stay clearly distinct:
//   - Lead / top-level: everything, plus task, ask_user, and the team tools
//     (spawn + message + the protocol tools it drives: shutdown / plan review).
//   - Teammate: a focused worker set + send_message + submit_plan; NO task, NO
//     spawn_teammate (nested spawning is forbidden), NO ask_user (can't reach
//     the human), and none of the planning/background extras.
//   - Plain sub-agent (task): all built-ins except todo_write (unchanged).
const TEAMMATE_TOOLS = new Set(["read_file", "write_file", "edit_file", "search", "run_bash"]); // the teammate's focused kit
function toolsFor(opts: LoopOptions): OpenAI.ChatCompletionTool[] {
  const builtins = toolDefinitions();
  if (opts.teammate) {
    const kit = builtins.filter((t) => t.type === "function" && TEAMMATE_TOOLS.has(t.function.name));
    return [...kit, sendMessageTool, submitPlanTool];
  }
  if (opts.subAgent) {
    // Sub-agents don't get todo_write: the plan is the top-level agent's, and a
    // sub-agent writing to the shared list would clobber it mid-task.
    return builtins.filter((t) => !(t.type === "function" && t.function.name === "todo_write"));
  }
  return [...builtins, taskTool, askUserTool, spawnTeammateTool, sendMessageTool, requestShutdownTool, requestPlanTool, reviewPlanTool]; // the Lead can do everything
}

// Run one sub-agent: a fresh conversation, same tools minus task, same
// permission gate, and the parent's file read-state protected by a snapshot.
async function runSubAgent(description: string, opts: LoopOptions): Promise<string> {
  emit("agent_subagent_spawn"); // delegation is worth counting
  const subModel = subAgentModelFor(opts); // the tier this delegated work runs on
  // Show the delegation, and the model when it differs from the orchestrator's —
  // the tiering should be visible, not a silent surprise on the bill.
  if (!opts.quiet) console.log(mark.subAgentStart(description.slice(0, 100), subModel !== opts.model ? subModel : "")); // annotate the tier only on a real switch
  await runHooks("SubagentStart", { description: description.slice(0, 200), model: subModel }); // lifecycle hook (observational)
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
    await runHooks("SubagentStop", { description: description.slice(0, 200) }); // lifecycle hook (observational)
    if (!opts.quiet) console.log(mark.subAgentDone); // close the bracket
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

let modelCallSeq = 0; // increments per model call — seeds the rotating spinner word

// One streaming model call: prints text as it arrives, assembles tool calls
// from their deltas, and guards the stream with a two-level watchdog.
async function streamModelCall(
  messages: OpenAI.ChatCompletionMessageParam[], // the full history to send
  opts: LoopOptions, // client/model/signal
): Promise<{ content: string; toolCalls: AssembledCall[] }> {
  const idleAbort = new AbortController(); // the watchdog's own kill switch
  const signal = AbortSignal.any([opts.signal, idleAbort.signal]); // either the user or the watchdog can abort
  const word = thinkingWord(modelCallSeq++); // a rotating "thinking" word for this call
  const startedAt = Date.now(); // for the spinner's live elapsed counter
  let streamedChars = 0; // bytes of content+reasoning streamed this call → a live token estimate
  const spinner = opts.quiet
    ? null // the eval harness wants silence
    : ora({ text: spinnerText(word, 0, !!opts.subAgent, opts.model), discardStdin: false }).start(); // discardStdin:false — ora would otherwise eat Ctrl+C
  let lastEvent = Date.now(); // when did we last hear ANYTHING from the stream?
  let stallWarned = false; // only warn once per quiet stretch

  // The two-level watchdog, checked once per second:
  // - idle (nothing at all for 90s) → cut the stream, let the retry layer handle it
  // - stall (slow but alive for 30s) → log it and keep waiting
  // It also ticks the spinner: elapsed seconds + a live token estimate (~chars/4).
  const watchdog = setInterval(() => {
    if (spinner?.isSpinning) spinner.text = spinnerText(word, Math.floor((Date.now() - startedAt) / 1000), !!opts.subAgent, opts.model, Math.round(streamedChars / 4));
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
      // The tool manual depends on the agent kind (Lead / teammate / sub-agent)
      // — see toolsFor(). This is also where nested spawning is prevented: a
      // teammate's manual simply omits spawn_teammate and task.
      { model: opts.model, messages, tools: toolsFor(opts), stream: true, stream_options: { include_usage: true } },
      { signal }, // abortable by user AND watchdog
    );
    let content = ""; // accumulated answer text
    let printedPrefix = false; // have we printed the answer prefix yet?
    let printedThinking = false; // have we started printing the reasoning trace yet?
    let md: MarkdownStream | null = null; // renders the streamed answer as markdown, block by block
    const calls: AssembledCall[] = []; // tool calls under assembly, indexed by delta.index
    for await (const chunk of stream) {
      lastEvent = Date.now(); // feed the watchdog
      stallWarned = false; // the stream spoke — reset the stall warning
      if (chunk.usage) recordUsage(chunk.usage as unknown as Record<string, unknown>); // the final usage chunk — meter it
      const delta = chunk.choices[0]?.delta; // this chunk's increment
      if (!delta) continue; // keep-alive or usage chunk — nothing to do

      // Reasoning models (e.g. deepseek-reasoner / R1) stream their thinking in a
      // separate `reasoning_content` field BEFORE the answer. Show it dimly so a
      // switch to a reasoning model is visibly different — but do NOT keep it:
      // the reasoning is not the answer and must not be replayed in later turns.
      const reasoning = (delta as { reasoning_content?: string }).reasoning_content;
      if (reasoning) {
        streamedChars += reasoning.length; // count reasoning toward the live token estimate
        if (spinner?.isSpinning) spinner.stop();
        if (!opts.quiet && !opts.subAgent) {
          if (!printedThinking) {
            process.stdout.write("\n" + chalk.dim("💭 thinking: ")); // label the trace once
            printedThinking = true;
          }
          process.stdout.write(chalk.dim(reasoning)); // stream the thinking, dimmed
        }
      }

      if (delta.content) {
        streamedChars += delta.content.length; // count the answer toward the live token estimate
        if (spinner?.isSpinning) spinner.stop(); // first token: replace the spinner with real output
        if (!opts.quiet && !opts.subAgent) {
          // Only the top-level agent streams to the screen — a sub-agent's
          // inner monologue would be mistaken for the answer.
          if (printedThinking && !printedPrefix) process.stdout.write("\n"); // end the thinking block before the answer
          if (!printedPrefix) {
            // Stream the answer through the markdown renderer: it buffers a block
            // (paragraph / heading / list / table) and prints it formatted the
            // moment that block completes — still live, but no raw `##`/`|---|`.
            // The ⏺ marker leads the first line; wrapped lines align under it.
            md = new MarkdownStream((s) => process.stdout.write(s), { firstPrefix: "\n" + mark.answer, indent: "  " });
            printedPrefix = true;
          }
          md!.push(delta.content); // hand the token to the renderer (it decides when to paint)
        }
        content += delta.content; // always keep it for the history (the answer only, never the reasoning)
      }
      for (const tc of delta.tool_calls ?? []) {
        if (spinner?.isSpinning) spinner.stop(); // tool call starting — spinner served its purpose
        const slot = (calls[tc.index] ??= { id: "", name: "", args: "" }); // create the slot on first fragment
        if (tc.id) slot.id = tc.id; // id arrives once
        if (tc.function?.name) slot.name += tc.function.name; // name usually arrives whole; += is safe either way
        if (tc.function?.arguments) slot.args += tc.function.arguments; // arguments stream in fragments — concatenate
      }
    }
    if (md) md.end(); // flush the final (un-terminated) block through the renderer
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
  const indent = opts.teammate ? chalk.magenta(`  ⎿ [${opts.teammate.name}] `) : opts.subAgent ? chalk.blue("  ⎿ ") : ""; // teammate activity is tagged by name; plain sub-agent is nested in blue
  if (!opts.quiet) {
    // Compact one-line summary — long args are hidden behind Tab.
    const summary = indent + mark.tool(call.name, call.args.length > 60 ? call.args.slice(0, 57) + "..." : call.args);
    const full = `tool: ${call.name}\nargs: ${call.args}`;
    printToolSummary(summary, full);
  }

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
    if (!opts.quiet) console.log(mark.denied(v.reason)); // tell the user we blocked it
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
        if (!opts.quiet) console.log(mark.judge); // visible — the user can see the judge worked
      }
    }
    const ok = autoAllowed || (await opts.confirm(`${call.name} (${v.reason}):\n   ${v.summary}`, call.name)); // judge-allowed, or pause and ask the human
    if (!ok) emit("agent_tool_declined", { tool: call.name }); // the human said no — that is signal
    if (!ok && !opts.quiet) console.log(mark.declined); // make the refusal visible
    content = ok
      ? await runWithHooks(call, opts) // approved — run it (PreToolUse can still block)
      : `[permission] The user declined this action. Ask them how to proceed, or choose a safer alternative.`; // declined — tell the model
  } else {
    content = await runWithHooks(call, opts); // allow — run it (PreToolUse can still block)
  }
  // todo_write's whole point is the VISIBLE plan: the model got a one-line tally,
  // the human gets the rendered checklist (quiet runs — eval/sub-agents — stay silent).
  if (call.name === "todo_write" && !opts.quiet && !content.startsWith("[error]")) {
    console.log(renderTodos(getTodos()));
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
    if (!opts.quiet) console.log(mark.hookBlock("PreToolUse")); // make it visible
    return `[hook] A PreToolUse hook blocked this call: ${pre.feedback}. Treat this as a hard boundary — adjust your approach.`;
  }
  // A PreToolUse hook may REWRITE the arguments (e.g. add a commit trailer). The
  // permission gate already ran on the original args; the rewrite only narrows or
  // annotates, never escalates past a deny. Validate it's parseable, then use it.
  if (pre.rewrite) {
    try {
      JSON.parse(pre.rewrite); // must be valid JSON args
      if (!opts.quiet) console.log(chalk.dim(`  ⎿ PreToolUse hook rewrote the arguments`));
      call = { ...call, args: pre.rewrite };
    } catch {
      /* malformed rewrite — ignore, run the original args */
    }
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
  // ask_user is special like task: running it needs the CLI's prompt, not the
  // tool registry. It presents a form and feeds the selections back to the model.
  if (call.name === "ask_user") return runAskUser(call, opts);
  // The team tools (Day 38/39) are loop-level like task: they need the loop and
  // the shared mailbox + protocol state, not the tool registry.
  if (call.name === "send_message") return runSendMessage(call, opts);
  if (call.name === "spawn_teammate") return runSpawnTeammate(call, opts);
  if (call.name === "request_shutdown") return runRequestShutdown(call, opts);
  if (call.name === "request_plan") return runRequestPlan(call, opts);
  if (call.name === "review_plan") return runReviewPlan(call, opts);
  if (call.name === "submit_plan") return runSubmitPlan(call, opts);

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

// The sender's mailbox name: a teammate sends as itself, everyone else as "lead".
const senderName = (opts: LoopOptions): string => opts.teammate?.name ?? LEAD;

// send_message: deliver one message to another agent's inbox. Available to the
// Lead and to teammates. Pure coordination — it never blocks on a reply.
async function runSendMessage(call: AssembledCall, opts: LoopOptions): Promise<string> {
  let to = "", content = "";
  try {
    const a = JSON.parse(call.args) as { to?: string; content?: string };
    to = (a.to ?? "").trim();
    content = a.content ?? "";
  } catch {
    /* fall through */
  }
  if (!to || !content.trim()) return "[error] send_message needs a non-empty 'to' and 'content'.";
  const from = senderName(opts);
  if (to === from) return "[error] You cannot message yourself.";
  // A teammate can only reach the lead or another teammate; the lead can reach
  // any teammate. We don't hard-check the recipient exists (it may be spawning) —
  // an undeliverable message just sits in a file no one reads, which is harmless.
  sendMessage(from, to, content);
  return `Message delivered to ${to}'s inbox.`;
}

// request_shutdown (lead → teammate): open a shutdown contract. We stamp the
// teammate with the request_id (it replies with that id and exits) AND send the
// request message so it shows up in the teammate's inbox and conversation.
async function runRequestShutdown(call: AssembledCall, opts: LoopOptions): Promise<string> {
  if (opts.teammate || opts.subAgent) return "[error] Only the lead can request a shutdown.";
  let teammate = "", reason = "";
  try {
    const a = JSON.parse(call.args) as { teammate?: string; reason?: string };
    teammate = (a.teammate ?? "").trim();
    reason = a.reason ?? "";
  } catch { /* fall through */ }
  if (!teammate) return "[error] request_shutdown needs a 'teammate' name.";
  if (!teammateExists(teammate)) return `[error] No teammate named "${teammate}".`;
  if (shutdownRequestId(teammate)) return `Shutdown already requested for "${teammate}" — waiting for it to confirm and exit.`;
  const requestId = createRequest("shutdown", LEAD, teammate, reason || "task complete");
  markShutdown(teammate, requestId);
  sendProtocol(LEAD, teammate, "shutdown_request", requestId, reason || "Your part is done — please wrap up and exit.");
  return `Requested shutdown of "${teammate}" (${requestId}). It will finish up, confirm, and exit; you'll get the confirmation in your inbox.`;
}

// request_plan (lead → teammate): ask the teammate to plan-before-acting. This
// is a directive message; the teammate answers it by calling submit_plan, which
// opens the actual plan_approval contract.
async function runRequestPlan(call: AssembledCall, opts: LoopOptions): Promise<string> {
  if (opts.teammate || opts.subAgent) return "[error] Only the lead can request a plan.";
  let teammate = "", task = "";
  try {
    const a = JSON.parse(call.args) as { teammate?: string; task?: string };
    teammate = (a.teammate ?? "").trim();
    task = a.task ?? "";
  } catch { /* fall through */ }
  if (!teammate || !task.trim()) return "[error] request_plan needs a 'teammate' and a 'task'.";
  if (!teammateExists(teammate)) return `[error] No teammate named "${teammate}".`;
  sendMessage(LEAD, teammate, `Before doing this, call submit_plan with your plan and WAIT for my approval — do not start until approved:\n${task}`);
  return `Asked "${teammate}" to submit a plan before doing: ${task.slice(0, 80)}. Approve/reject it with review_plan when it arrives.`;
}

// review_plan (lead): the answer half of the plan_approval contract. Correlate
// to the request via match_response (resolveResponse), then send the decision
// back to the teammate that submitted it.
async function runReviewPlan(call: AssembledCall, opts: LoopOptions): Promise<string> {
  if (opts.teammate || opts.subAgent) return "[error] Only the lead can review a plan.";
  let requestId = "", decision = "", reason = "";
  try {
    const a = JSON.parse(call.args) as { request_id?: string; decision?: string; reason?: string };
    requestId = (a.request_id ?? "").trim();
    decision = (a.decision ?? "").trim();
    reason = a.reason ?? "";
  } catch { /* fall through */ }
  if (!requestId || (decision !== "approve" && decision !== "reject")) return '[error] review_plan needs a request_id and decision "approve" or "reject".';
  const approved = decision === "approve";
  const res = resolveResponse(requestId, "plan_approval", approved); // match_response: validates kind + state
  if (!res.ok) return `[error] ${res.error}`;
  sendProtocol(LEAD, res.state!.from, "plan_approval_response", requestId, reason || (approved ? "approved" : "rejected"), approved ? "approved" : "rejected");
  return `Plan ${approved ? "approved" : "rejected"} (${requestId}); told ${res.state!.from}.`;
}

// submit_plan (teammate → lead): open a plan_approval contract and STOP. The
// teammate idles after this until the lead's decision lands in its inbox.
async function runSubmitPlan(call: AssembledCall, opts: LoopOptions): Promise<string> {
  if (!opts.teammate) return "[error] Only a teammate can submit a plan (the lead reviews them).";
  let plan = "";
  try { plan = (JSON.parse(call.args) as { plan?: string }).plan ?? ""; } catch { /* fall through */ }
  if (!plan.trim()) return "[error] submit_plan needs a non-empty 'plan'.";
  const requestId = createRequest("plan_approval", opts.teammate.name, LEAD, plan);
  sendProtocol(opts.teammate.name, LEAD, "plan_approval_request", requestId, plan);
  return `Plan submitted to the lead for approval (${requestId}). STOP here and wait — the lead's decision will arrive in your inbox. Do NOT start the work until it is approved.`;
}

// spawn_teammate: start a persistent worker that runs concurrently. Top-level
// only — a teammate calling this is the nested-spawn case (its manual omits the
// tool, but we guard anyway). Returns IMMEDIATELY; the teammate's loop runs in
// the background and reports back through the lead's inbox.
async function runSpawnTeammate(call: AssembledCall, opts: LoopOptions): Promise<string> {
  if (opts.subAgent || opts.teammate) return "[error] Only the lead can spawn teammates — teammates cannot spawn teammates. Do the work yourself or message the lead.";
  let name = "", role = "", task = "";
  try {
    const a = JSON.parse(call.args) as { name?: string; role?: string; task?: string };
    name = (a.name ?? "").trim();
    role = (a.role ?? "").trim();
    task = a.task ?? "";
  } catch {
    /* fall through */
  }
  if (!name || !role || !task.trim()) return "[error] spawn_teammate needs a non-empty name, role, and task.";
  if (name === LEAD) return `[error] "${LEAD}" is reserved for the coordinator — pick another name.`;
  if (teammateExists(name)) return `[error] A teammate named "${name}" already exists — pick a unique name or message the existing one.`;
  if (teammateCount() >= MAX_TEAMMATES) return `[error] The team is full (${MAX_TEAMMATES} teammates max). Wait for one to finish, or do the work yourself.`;

  // Kick off the teammate's loop WITHOUT awaiting it — that is what makes it
  // concurrent. It progresses whenever the event loop is free (e.g. while the
  // lead awaits its own API stream). We keep the promise so the lead and
  // shutdown know when it has ended.
  const done = runTeammate(name, role, task, opts);
  registerTeammate(name, role, done);
  if (!opts.quiet) console.log(mark.teammateStart(name, role));
  return `Teammate "${name}" (${role}) spawned and is now working in parallel. It will message you (as "lead") with progress and its final result. Reply with send_message; keep coordinating the rest of the team. Do not wait idly — continue your own work.`;
}

// Run one teammate to completion: a fresh conversation seeded with its task, a
// focused toolset, its own mailbox, and a hard round cap. On any ending it sends
// a `result` message back to the lead — so the lead always learns the outcome,
// success or failure. The teammate's file read-state is isolated by snapshot,
// exactly like a sub-agent (it reads things the lead's conversation never saw).
async function runTeammate(name: string, role: string, task: string, opts: LoopOptions): Promise<void> {
  emit("agent_teammate_spawn");
  await runHooks("SubagentStart", { description: `teammate ${name}: ${role}`.slice(0, 200), model: opts.model });
  const snapshot = snapshotFileState();
  const system = TEAMMATE_PROMPT.replace("{name}", name).replace("{role}", role);
  try {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: task }, // its first instruction; more arrive via the inbox
    ];
    // A teammate is a sub-agent (quiet streaming, no hooks, isolated) PLUS team
    // wiring: a name, its inbox, a non-interactive permission policy (it cannot
    // prompt the human, so writes auto-proceed but risky bash is declined — see
    // teammateConfirm; deny ALWAYS still wins), and a runaway backstop. Day 39:
    // it is no longer bounded by a low round cap — it idle-waits for work and
    // exits on the shutdown handshake (continueForTeam); maxRounds is only a
    // generous guard against an active loop that never stops calling tools.
    const result = await runLoop(messages, {
      ...opts,
      subAgent: true,
      teammate: { name },
      maxRounds: TEAMMATE_MAX_ROUNDS,
      confirm: teammateConfirm(name),
      askUser: undefined, // teammates have no line to the human
    });
    // How it ended decides what the lead hears. A shutdown handshake gets a
    // shutdown_response(approved) carrying the request_id; anything else is a
    // plain result. Either way the lead always learns the outcome.
    const summary = result.reason === TerminateReason.Done && result.finalText?.trim() ? result.finalText.trim() : `[ended: ${result.reason}]`;
    const sd = shutdownRequestId(name);
    if (sd) sendProtocol(name, LEAD, "shutdown_response", sd, summary || "shut down", "approved");
    else sendMessage(name, LEAD, summary, "result");
    finishTeammate(name, result.reason === TerminateReason.Done);
    if (!opts.quiet) console.log(mark.teammateDone(name, result.reason === TerminateReason.Done));
  } catch (err) {
    // A teammate must never take the whole process down. Report the failure to
    // the lead and mark it failed.
    sendMessage(name, LEAD, `[teammate crashed: ${(err as Error).message}]`, "result");
    finishTeammate(name, false);
  } finally {
    restoreFileState(snapshot);
    await runHooks("SubagentStop", { description: `teammate ${name}` });
  }
}

const TEAMMATE_MAX_ROUNDS = 30; // runaway backstop for an active teammate (not the lifecycle — idle-wait + shutdown handshake end it normally)
const TEAM_POLL_MS = 250; // how often an idle agent polls its inbox while waiting
const TEAMMATE_MAX_IDLE_MS = 60_000; // an abandoned teammate self-exits after this long with nothing to do (the lead normally shuts it down first)
const SHUTDOWN_GRACE_MS = 30_000; // how long the lead waits for teammates to exit cleanly when it disbands the team

// A teammate's permission policy. It cannot stop and ask the human, so: file
// writes/edits auto-proceed (that is the teammate's job, and they are reversible
// via /undo and reviewable via /diff), but anything else the gate rated "ask"
// (unrecognized or dangerous bash) is DECLINED rather than run unattended. Hard
// DENY rules (the no-fly zone) are enforced by the gate before confirm is ever
// called, so they always hold. Production Claude Code instead "bubbles" the
// request up to the lead and on to the human — omitted here, like the reference.
function teammateConfirm(name: string): (question: string, toolName?: string) => Promise<boolean> {
  return async (_question, toolName) => {
    const ok = toolName === "write_file" || toolName === "edit_file";
    if (!ok) console.log(chalk.yellow(`  ⎿ [${name}] declined ${toolName ?? "an action"} (teammates can't prompt you; do it yourself or allowlist it)`));
    return ok;
  };
}

// Present the ask_user form and turn the selections into a tool result. The
// model called this to get a decision; we give it clean question→answer pairs.
async function runAskUser(call: AssembledCall, opts: LoopOptions): Promise<string> {
  if (opts.subAgent) return "[error] Sub-agents cannot ask the user. Decide yourself, or report back to the parent."; // only the top-level agent talks to the human
  if (!opts.askUser) return "[error] No interactive prompt is available in this session — ask in plain text instead.";
  let questions: { question: string; options: string[] }[] = [];
  try {
    questions = (JSON.parse(call.args) as { questions?: typeof questions }).questions ?? [];
  } catch {
    /* fall through */
  }
  // Keep only well-formed questions (text + at least two options).
  questions = (questions ?? []).filter((q) => q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length >= 2);
  if (!questions.length) return "[error] ask_user needs at least one question with two or more options.";

  const answers = await opts.askUser(questions);
  if (!answers) return "The user dismissed the question form without answering. Proceed with your best judgment, or ask again if you truly need their input."; // cancelled / non-interactive
  return `The user answered:\n${answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}`; // organized, unambiguous
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
    if (!opts.subAgent) await runHooks("PreCompact", {}); // lifecycle hook (top-level only; hooks are the human's project policy)
    await compactHistory(messages, opts.client, opts.model, opts.signal); // do the actual work
    compaction.count++; // one more successful compaction this query
    compaction.failures = 0; // success resets the failure streak
    emit("agent_compaction_ok"); // worth counting — frequent compaction means tasks are too big
    if (!opts.subAgent) await runHooks("PostCompact", {}); // observational
    return true;
  } catch {
    compaction.failures++; // failed — count it against the breaker
    emit("agent_compaction_failed"); // a failure streak here trips the breaker
    return false;
  }
}

// Surface any FINISHED background tasks (Day 37) as a user turn, so the model
// sees the result of work it kicked off earlier. Mirrors the tutorial reference,
// adapted to the OpenAI wire protocol: tool results are their own role:"tool"
// messages, so a notification can't ride inside them — it follows as a user
// message instead (exactly how the todo nag and Stop hook already inject turns).
// Top-level only: a sub-agent has no separate turn loop to inject into, and the
// notification belongs to the agent that started the job. Returns true if it
// injected something. Each finished task notifies exactly once (background.ts).
function injectBackgroundNotifications(messages: OpenAI.ChatCompletionMessageParam[], opts: LoopOptions): boolean {
  if (opts.subAgent) return false; // notifications belong to the top-level conversation
  const note = pendingNotifications(); // "" unless a task finished since we last checked
  if (!note) return false;
  const count = (note.match(/<task_notification>/g) ?? []).length; // for the one-line on-screen mark
  messages.push({ role: "user", content: note }); // the model reacts to it on the next round
  if (!opts.quiet) console.log(mark.bgNote(count));
  return true;
}

// Consume this agent's mailbox into its conversation, ROUTING protocol messages
// (Day 39) as it goes — the reference's consume_lead_inbox + dispatch_message in
// one pass. The lead reads "lead"; a teammate reads its own name. The read is
// consumptive (team.ts), so each message is handled exactly once. Protocol
// messages update state (correlate responses via match_response, flag a shutdown)
// AND get a plain-language line so the model can react; plain chat is passed
// through. Returns whether anything was injected. (Plan-approval is a handshake,
// not a hard gate: the teammate is TOLD to wait and does — execution gating by
// permission mode is what production Claude Code adds; omitted here, per s16.)
function consumeInbox(messages: OpenAI.ChatCompletionMessageParam[], opts: LoopOptions): boolean {
  if (opts.subAgent && !opts.teammate) return false; // a plain sub-agent is not on the team
  const me = opts.teammate?.name ?? LEAD;
  const msgs = readInbox(me);
  if (!msgs.length) return false;
  const lines: string[] = [];
  for (const m of msgs) {
    switch (m.kind) {
      case "shutdown_request": // (teammate side) the lead asked us to shut down
        markShutdown(me, m.requestId ?? "");
        lines.push(`[lead] SHUTDOWN REQUESTED (${m.requestId}): ${m.content}. Finish any in-progress write, then you will exit cleanly.`);
        break;
      case "shutdown_response": // (lead side) a teammate confirmed it shut down
        if (m.requestId) resolveResponse(m.requestId, "shutdown", m.status === "approved");
        finishTeammate(m.from, true);
        lines.push(`[${m.from}] confirmed shutdown (${m.requestId}) and has exited.`);
        break;
      case "plan_approval_request": // (lead side) a teammate wants approval before risky work
        lines.push(`[${m.from}] PLAN APPROVAL REQUESTED (${m.requestId}). Review it, then call review_plan with this id. Plan:\n${m.content}`);
        break;
      case "plan_approval_response": { // (teammate side) the lead decided on our plan
        if (m.requestId) resolveResponse(m.requestId, "plan_approval", m.status === "approved");
        const ok = m.status === "approved";
        lines.push(`[lead] plan ${ok ? "APPROVED" : "REJECTED"} (${m.requestId})${m.content ? `: ${m.content}` : ""}. ${ok ? "Proceed with the plan now." : "Revise it and submit_plan again."}`);
        break;
      }
      default: // plain chat / a teammate's result
        lines.push(`[message from ${m.from}${m.type === "result" ? " · RESULT" : ""}] ${m.content}`);
    }
  }
  const header = opts.teammate ? "Messages from your team — read and act on them:" : "Team inbox — react to these (RESULT = that teammate finished a part):";
  messages.push({ role: "user", content: `${header}\n\n${lines.join("\n\n")}` });
  if (!opts.quiet) console.log(opts.teammate ? chalk.dim(`  ⎿ [${me}] received ${msgs.length} message(s)`) : mark.inbox(msgs.length));
  return true;
}

// At a stop-point (no tool calls), decide whether the TEAM keeps this agent's
// conversation alive (Day 38/39).
//   - A teammate now IDLE-LOOPS instead of exiting: it processes its inbox, and
//     if there's nothing to do it waits (yielding the event loop) for new work —
//     bounded, so an abandoned teammate self-exits instead of hanging forever. It
//     leaves only on the shutdown handshake (its request_id is set) or that
//     backstop. While waiting it marks itself "idle" so the lead can tell the
//     team is quiescent.
//   - The lead waits while any teammate is actively working, then drains its
//     inbox. When the team has gone quiet and nothing is waiting, it returns
//     false → the lead finishes (and disbands the team, see runLoop).
async function continueForTeam(messages: OpenAI.ChatCompletionMessageParam[], opts: LoopOptions): Promise<boolean> {
  if (opts.teammate) {
    const me = opts.teammate.name;
    let waited = 0;
    while (true) {
      const injected = consumeInbox(messages, opts); // route protocol + plain; may set the shutdown flag
      if (shutdownRequestId(me)) return false; // shutdown handshake → exit (runTeammate sends the response)
      if (injected) { setTeammateState(me, "active"); return true; } // real work arrived → run a round
      setTeammateState(me, "idle"); // nothing to do — wait for the lead/another teammate
      if (opts.isInterrupted() || waited >= TEAMMATE_MAX_IDLE_MS) return false; // abandoned → self-exit backstop
      await interruptibleSleep(TEAM_POLL_MS, opts.isInterrupted);
      waited += TEAM_POLL_MS;
    }
  }
  if (opts.subAgent) return false; // a plain sub-agent has no team
  // The lead: wait for the team to act rather than spinning or ending early.
  while (inboxCount(LEAD) === 0 && anyTeammateBusy() && !opts.isInterrupted()) {
    await interruptibleSleep(TEAM_POLL_MS, opts.isInterrupted); // yield to the teammates; they message us when they have something
  }
  return consumeInbox(messages, opts); // process whatever is waiting; false if the team is quiescent (→ the lead may finish)
}

// The lead finished its work but teammates may still be idling. Disband the team
// GRACEFULLY (Day 39): open a shutdown contract with each, let them confirm and
// exit (bounded by a grace window so a wedged teammate can't hang the prompt),
// then drain the lead's inbox of their confirmations and clear the team.
async function shutdownTeam(opts: LoopOptions): Promise<void> {
  const running = runningTeammates();
  if (!running.length) return;
  if (!opts.quiet) console.log(chalk.magenta(`  ⎿ disbanding team — shutting down ${running.length} teammate(s)`));
  for (const name of running) {
    const id = createRequest("shutdown", LEAD, name, "task complete");
    markShutdown(name, id);
    sendProtocol(LEAD, name, "shutdown_request", id, "The task is complete — wrap up and exit.");
  }
  // Yield the event loop so the teammates wake, confirm, and exit — but never
  // block the human forever on a stuck one.
  const start = Date.now();
  while (runningTeammates().length && Date.now() - start < SHUTDOWN_GRACE_MS && !opts.isInterrupted()) {
    await interruptibleSleep(TEAM_POLL_MS, opts.isInterrupted);
  }
  readInbox(LEAD); // drop the shutdown confirmations the lead won't read
  resetTeam(); // clear the registry + protocol state; the next task starts with a fresh team
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
  let lastText: string | null = null; // most recent assistant text — what we return if a round cap (teammates) stops us mid-flight

  for (let round = 1; ; round++) {
    // A bounded loop (teammates, Day 38) stops cleanly at its round cap with
    // whatever it last said, so a team can never run away. Unset maxRounds keeps
    // the usual unbounded-with-safeguards loop for the lead and the user's agent.
    if (opts.maxRounds && round > opts.maxRounds) {
      return { reason: TerminateReason.Done, finalText: lastText ?? `(reached the ${opts.maxRounds}-round limit)` };
    }
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
      if (out.content) lastText = out.content; // remember the latest answer text — the round-cap path returns it

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
            break; // exit the inner while → advance the round counter
          }
        }
        // A background task may have finished in the very round the model decided
        // to stop. Don't return with an unread result on the table: surface it and
        // run one more round so the model can react. Each task notifies once, so
        // this adds at most one round per finished task — never an infinite stop.
        if (injectBackgroundNotifications(messages, opts)) break; // exit the inner while → advance the round counter
        // Agent teams (Day 38/39): the lead waits for teammate messages and
        // reacts; a teammate idle-loops for new work and leaves only on the
        // shutdown handshake (or its idle backstop). If there's something to
        // process, run another round instead of stopping.
        if (await continueForTeam(messages, opts)) break; // exit the inner while → advance the round counter
        // The lead is really finishing: disband any teammates still idling so
        // they exit cleanly (Day 39) instead of being orphaned.
        if (!opts.subAgent && !opts.teammate) await shutdownTeam(opts);
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

      // Background tasks (Day 37): if a job the model started has finished, slip
      // its <task_notification> in here, right after this round's tool results —
      // the model sees the outcome on the next round without ever having blocked
      // on it. Tasks that are still running stay silent until they finish.
      injectBackgroundNotifications(messages, opts);

      // Agent teams (Day 38/39): drain any messages that arrived during this
      // round (results, hand-offs, protocol requests/responses) so the agent
      // reacts to them next round. A shutdown_request seen here just flags the
      // teammate; it acts on it at the next stop-point (continueForTeam).
      consumeInbox(messages, opts);

      // The nag: if there's an unfinished plan the model has stopped touching for
      // a few rounds, slip in a reminder so the list doesn't go stale and
      // meaningless. Top-level only — a sub-agent has no plan of its own.
      if (!opts.subAgent) {
        const nag = todoNag();
        if (nag) {
          messages.push({ role: "user", content: nag });
          if (!opts.quiet) console.log(chalk.dim("  ⎿ plan reminder injected"));
        }
      }
      break; // round complete, move to the next one
    }
  }
  // loop is unbounded — other safeguards (circuit breaker, retry budget, compaction guard) still apply
}

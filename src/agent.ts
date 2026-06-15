#!/usr/bin/env node
import OpenAI from "openai"; // the API client
import chalk from "chalk"; // terminal colors
import readline from "node:readline/promises"; // promise-based terminal input
import { createRequire } from "node:module"; // to read package.json for --version
import { CONFIG, requireApiKey, PROJECT_SETTINGS_PATH, GLOBAL_SETTINGS_PATH } from "./config.js"; // provider-agnostic settings (.env loaded there)
import { runLoop, TerminateReason, MAX_ROUNDS, MAX_RETRIES, type LoopResult } from "./loop.js"; // the state machine
import { buildSystemMessage } from "./prompt.js"; // the constitution + optional AGENT.md project memory
import { forgetFilesExcept, registerExternalTool } from "./tools.js"; // file-state reset + tool registration
import { compactHistory, estimateHistoryTokens, COMPACT_AT } from "./context.js"; // for the manual /compact command
import { newSessionId, saveSession, latestSession, listSessions, loadSession } from "./session.js"; // conversation persistence (project-local) + the /resume picker
import { initTelemetry, emit, statsReport } from "./telemetry.js"; // local-only event log + /stats
import { runHooks } from "./hooks.js"; // SessionStart lifecycle hook
import { connectMcpServers } from "./mcp.js"; // external tool servers (MCP)
import { Judge } from "./judge.js"; // optional LLM permission classifier
import { isPlanMode, setPlanMode } from "./permissions.js"; // plan mode: research-only until the user approves a plan
import { undoLast, clearUndo, sessionChanges } from "./undo.js"; // /undo + /diff: take back, or review, this session's writes
import { renderDiff } from "./diff.js"; // show what /undo put back / what /diff changed, reusing the Day 21 diff renderer
import path from "node:path"; // shorten paths for the /diff summary
import { expandMentions } from "./mentions.js"; // @file mentions: pull referenced files into context (secret files refused)
import { banner, framedPrompt, inputFrameTop, inputFrameBottom } from "./ui.js"; // the welcome box, framed prompt
import { promptSelect } from "./menu.js"; // arrow-key approval menu
import { rememberTool, readMemory, MEMORY_PATH } from "./memory.js"; // long-term project memory
import { initCostMeter, DEFAULT_PRICING } from "./cost.js"; // token & cost accounting for /cost

// package.json sits one level above both src/ (dev) and dist/ (built) — same path either way.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

// ---- CLI arguments --------------------------------------------------------------
// Tiny by design: a help text, a version, and a one-shot print mode. Anything
// fancier belongs in settings files, not flags.
const USAGE = `mini-agent ${pkg.version} — a Claude Code-style CLI agent (any OpenAI-compatible model)

Usage:
  mini-agent                 interactive session (REPL)
  mini-agent -r | --resume   continue the most recent session in this directory
  mini-agent -p "<task>"     one-shot: run a single task, print the result, exit
  mini-agent -v | --version  print the version
  mini-agent -h | --help     this text

Configuration (optional):
  ${GLOBAL_SETTINGS_PATH}   your defaults (model, baseURL, permissions, hooks)
  ${PROJECT_SETTINGS_PATH}   per-project rules — both layers apply, deny always wins
  MINI_AGENT_API_KEY / MINI_AGENT_BASE_URL / MINI_AGENT_MODEL override everything.

In a session, type /help for the in-session commands.`;

// What we tell the user for every way a query can end. No raw stack traces.
const EXIT_NOTES: Record<Exclude<TerminateReason, TerminateReason.Done>, string> = {
  [TerminateReason.RoundCap]: `Hit the ${MAX_ROUNDS}-round cap. The task may be too big for one go — try splitting it.`,
  [TerminateReason.CircuitBreaker]: "3 API failures in a row — stopping here instead of burning money.",
  [TerminateReason.RetryBudgetExhausted]: `${MAX_RETRIES} failed API calls in this query — giving up. Check your network and try again.`,
  [TerminateReason.RateLimitBudgetExhausted]: "The provider keeps rate-limiting us. Wait a minute, then try again.",
  [TerminateReason.ContextTooLong]: "The conversation no longer fits the model's context window, and compaction could not shrink it enough. Use /clear to start fresh.",
  [TerminateReason.CompactionFailed]: "Automatic compaction kept failing — stopping instead of looping. Use /clear to start fresh.",
  [TerminateReason.FatalApiError]: "Unrecoverable API error — retrying would not help. Check your API key and request.",
  [TerminateReason.UserInterrupt]: "Interrupted — back at the prompt.",
};

// The in-session command reference, shown by /help.
const SESSION_HELP = `commands:
  /help      this text
  /clear     wipe the conversation (and the file read-state) — fresh start
  /compact   compact the history into a summary right now (happens automatically near the limit)
  /model     show which model and endpoint this session is talking to
  /stats     event counts for this session (local telemetry — nothing leaves this machine)
  /memory    show the durable facts the agent remembers about this project
  /cost      tokens, cache hit rate and estimated spend this session (local)
  /plan      toggle plan mode — research-only; the agent presents a plan you approve before any change
  /undo      revert the most recent file write (write_file / edit_file) this session
  /diff      show every file changed this session, as a diff from where it started
  /resume    list recent sessions in this project and continue one of them
  exit       leave (Ctrl+C at the prompt does the same)`;

// Injected when the user turns plan mode on, so the model knows the rules of the
// mode it now lives in (the permission gate enforces them regardless).
const PLAN_MODE_NOTICE = `[plan mode ON] Investigate this request using only read-only tools — read_file, search, and safe read-only shell (ls, cat, git status). Do NOT write files, edit, or run mutating commands; the permission gate will block them. When you have a concrete, ordered plan, call the exit_plan_mode tool with that plan. The user reviews and approves it before you make any change.`;

async function main() {
  // ---- Flag handling, before anything touches the network -----------------------
  const argv = process.argv.slice(2); // everything after "mini-agent"
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(pkg.version); // just the number — script-friendly
    return;
  }
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE); // the full help text
    return;
  }
  // Print mode: -p / --print takes the task from the remaining arguments.
  const pIdx = argv.findIndex((a) => a === "-p" || a === "--print"); // where the flag sits
  const printTask = pIdx >= 0 ? argv.slice(pIdx + 1).join(" ").trim() : null; // everything after it is the task
  if (pIdx >= 0 && !printTask) {
    console.error('Usage: mini-agent -p "<task>"'); // -p without a task is a usage error
    process.exitCode = 2;
    return;
  }

  requireApiKey(); // fail fast with instructions, not a stack trace from inside the SDK

  // Build the API client once, for the whole session.
  const client = new OpenAI({
    baseURL: CONFIG.baseURL, // DeepSeek by default; any OpenAI-compatible endpoint via config
    apiKey: CONFIG.apiKey, // from .env or the shell
    maxRetries: 0, // we own the retry policy — never let the SDK retry underneath us
  });

  // The system message is built ONCE per session: stable prefix = cache hits
  // on every request. Nothing session-specific may sneak into it later.
  const systemMessage = buildSystemMessage();
  let messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: systemMessage }]; // the whole conversation lives here, across turns

  // ---- Session persistence ---------------------------------------------------------
  // Every conversation is snapshotted to .mini-agent/sessions/ after each turn;
  // -r / --resume picks up the most recent one. The system message is NOT
  // restored from disk — it is rebuilt fresh, because AGENT.md may have changed.
  let sessionId = newSessionId(); // this session's identity (and file name)
  if (argv.includes("-r") || argv.includes("--resume")) {
    const prev = latestSession(); // newest snapshot in this directory, if any
    if (prev) {
      messages.push(...prev.messages); // the old conversation joins the fresh constitution
      sessionId = prev.id; // keep appending to the same session file
      console.log(chalk.dim(`(resumed session ${prev.id} — ${prev.messages.length} messages; files must be re-read before editing)`));
    } else {
      console.log(chalk.dim("(no previous session here — starting fresh)")); // resume with nothing to resume is not an error
    }
  }
  initTelemetry(sessionId); // arm the local event log (no-op under MINI_AGENT_NO_TELEMETRY=1)
  emit("agent_session_start", { mode: printTask !== null ? "print" : "repl" }); // how this session was started

  // Connect to any configured MCP servers and register their tools. This must
  // finish before the first model call so the tools appear in the manual. A
  // server that fails to start is skipped, never fatal.
  const disconnectMcp = await connectMcpServers();
  process.on("exit", disconnectMcp); // best-effort cleanup of server subprocesses

  // The optional LLM permission judge, built once if a settings file enabled it.
  const judge = CONFIG.judge.enabled ? new Judge(client, CONFIG.judge.model || CONFIG.model) : undefined;
  if (judge) console.log(chalk.dim(`(permission judge on — model ${CONFIG.judge.model || CONFIG.model})`));

  // The remember tool: let the model save durable facts to long-term memory.
  // Registered like any tool, so it flows through the same permission gate.
  registerExternalTool(rememberTool);
  const memCount = readMemory().length;
  if (memCount) console.log(chalk.dim(`(long-term memory: ${memCount} facts loaded)`));

  // Token/cost meter for this session. Prices come from settings, falling back
  // to the defaults; the loop records usage into it from every stream.
  const costMeter = initCostMeter({
    inputPerM: CONFIG.pricing.inputPerM ?? DEFAULT_PRICING.inputPerM,
    cachedInputPerM: CONFIG.pricing.cachedInputPerM ?? DEFAULT_PRICING.cachedInputPerM,
    outputPerM: CONFIG.pricing.outputPerM ?? DEFAULT_PRICING.outputPerM,
  });

  // SessionStart hooks run once, here. Their stdout is injected as context the
  // model sees on its first turn — e.g. inject the current git branch, an
  // on-call rota, today's deploy freeze status. (exit 2 here is ignored: there
  // is no tool to block, only context to add.)
  const sessionStart = await runHooks("SessionStart", {});
  if (sessionStart.stdout) messages.push({ role: "user", content: `[SessionStart hook]\n${sessionStart.stdout}` });

  // Per-task interrupt state. `running` decides what Ctrl+C means right now.
  let running = false; // is a task currently executing?
  let interrupted = false; // has the current task been interrupted?
  let controller = new AbortController(); // aborts the in-flight API request

  // ---- One-shot print mode -------------------------------------------------------
  // The same loop, the same permission gate (fail closed without a TTY), no REPL.
  // Designed for scripts: the exit code distinguishes success from every failure.
  if (printTask !== null) {
    process.on("SIGINT", () => {
      if (interrupted) process.exit(130); // second press: force quit
      interrupted = true; // first press: wind down
      controller.abort(); // cancel the in-flight request
    });
    messages.push({ role: "user", content: printTask }); // the single task
    const result = await runLoop(messages, {
      client,
      model: CONFIG.model,
      signal: controller.signal,
      isInterrupted: () => interrupted,
      subAgentModel: CONFIG.subAgentModel, // delegated work may run on a different tier
      judge, // auto-allow clearly-safe commands even unattended (safer than blanket AUTO_APPROVE)
      // Print mode never prompts: unattended means nobody can say yes.
      // MINI_AGENT_AUTO_APPROVE=1 still works for scripted use; hard denies
      // were enforced in permissions.ts long before this runs.
      confirm: async (q) => {
        if (process.env.MINI_AGENT_AUTO_APPROVE === "1") return true; // explicit bypass
        console.error(chalk.dim(`[print mode] declined (no prompt available): ${q.split("\n")[0]}`)); // visible in stderr, not stdout
        return false; // fail closed
      },
    });
    saveSession(sessionId, CONFIG.model, messages); // print-mode runs are resumable too
    emit("agent_session_end"); // close the books
    if (result.reason !== TerminateReason.Done) {
      console.error(chalk.yellow(EXIT_NOTES[result.reason])); // human note on stderr
      if (result.detail) console.error(chalk.dim(result.detail.slice(0, 300))); // raw detail on stderr
      process.exitCode = result.reason === TerminateReason.UserInterrupt ? 130 : 1; // scripts can branch on this
    }
    return; // the answer itself already streamed to stdout
  }

  // ---- Interactive session (REPL) -------------------------------------------------
  // The welcome box: who am I, which model and host am I on, and the basics.
  console.log(banner(pkg.version, CONFIG.model, new URL(CONFIG.baseURL).host));

  // ONE readline interface for the whole session — the task prompt and the
  // permission prompts share it. Two interfaces on one stdin fight each other.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Input plumbing: a line QUEUE instead of rl.question(). With piped stdin
  // all lines arrive at once — question() would catch the first and lose the
  // rest. The queue catches every line; asking pops one (or waits for one).
  // Bonus: in a terminal, lines typed while a task runs queue up as the next
  // commands instead of vanishing.
  const pendingLines: string[] = []; // lines that arrived before anyone asked
  const lineWaiters: ((line: string) => void)[] = []; // askers waiting for a line
  let stdinDone = false; // has stdin ended?
  rl.on("line", (line) => {
    const waiter = lineWaiters.shift(); // is somebody waiting?
    if (waiter) waiter(line); // hand the line over directly
    else pendingLines.push(line); // nobody waiting — queue it
  });
  rl.on("close", () => {
    stdinDone = true; // no more input will ever come
    while (lineWaiters.length) lineWaiters.shift()!("exit"); // wake every waiter with a polite "exit"
  });
  // Get the next line of user input, showing a prompt if we have to wait.
  const readUserLine = (prompt: string): Promise<string> => {
    if (pendingLines.length) return Promise.resolve(pendingLines.shift()!); // typed-ahead (or piped) line — use it
    if (stdinDone) return Promise.resolve("exit"); // stdin is gone — leave politely
    rl.setPrompt(prompt); // show the prompt the redraw-safe way
    rl.prompt();
    return new Promise((resolve) => lineWaiters.push(resolve)); // wait for the next line
  };

  // Ctrl+C semantics, by state:
  // - at the prompt: exit the session (standard REPL behavior)
  // - while running: first press interrupts the task, second press force-quits
  const onSigint = () => {
    if (!running) {
      console.log(); // end the prompt line cleanly
      process.exit(0); // at the prompt, Ctrl+C = goodbye
    }
    if (interrupted) process.exit(130); // second press while running: force quit (130 = killed by SIGINT)
    interrupted = true; // first press: raise the flag...
    controller.abort(); // ...and cancel the in-flight API request
    console.log(chalk.yellow("\n(interrupt — finishing up, Ctrl+C again to force quit)")); // tell the user we heard them
  };
  process.on("SIGINT", onSigint); // covers non-TTY runs
  rl.on("SIGINT", onSigint); // covers TTY raw mode, where readline swallows the signal itself

  // Ask the human to approve a dangerous action — shares the session readline.
  // Fail closed: in a non-interactive session nobody can say yes, so the
  // answer is no. MINI_AGENT_AUTO_APPROVE=1 bypasses the QUESTION, but hard
  // denies were already enforced in permissions.ts before we get here.
  const confirm = async (question: string, toolName?: string): Promise<boolean> => {
    console.log(chalk.yellow(`\n⚠ approval needed — ${question}`)); // always show what is being asked
    if (process.env.MINI_AGENT_AUTO_APPROVE === "1") {
      console.log(chalk.dim("  auto-approved (MINI_AGENT_AUTO_APPROVE=1)")); // bypass mode — say so out loud
      return true; // approve without asking
    }
    if (!process.stdin.isTTY) {
      console.log(chalk.dim("  non-interactive session — denied by default (fail closed)")); // nobody can answer — refuse
      return false; // fail closed
    }
    // Selecting beats typing: ↑/↓ + Enter instead of "type y/N". The middle
    // option lets the user stop being asked about this tool for the session.
    const allowLabel = toolName ? `Yes, and don't ask again for ${toolName} this session` : "Yes, and don't ask again this session";
    const choice = await promptSelect(rl, ["Yes", allowLabel, "No — let me tell the agent what to do instead"]);
    const approved = choice === 0 || choice === 1;
    if (choice === 1 && toolName) {
      CONFIG.permissions.allow.push(`tool:${toolName}`); // remember the grant for the rest of the session
      console.log(chalk.dim(`  won't ask again for ${toolName} this session`));
    }
    console.log(approved ? chalk.green("  ✓ approved") : chalk.yellow("  ✗ declined"));
    return approved;
  };

  // Handle a /slash command. Returns true if the line was a command.
  const handleCommand = async (line: string): Promise<boolean> => {
    switch (line) {
      case "/help":
        console.log(chalk.dim(SESSION_HELP)); // the command reference
        return true;
      case "/clear":
        messages = [{ role: "system", content: systemMessage }]; // drop everything but the constitution
        forgetFilesExcept([]); // the file read-state belongs to the conversation — clear it too
        clearUndo(); // a fresh conversation should not undo the previous one's writes
        sessionId = newSessionId(); // a fresh conversation is a fresh session file
        console.log(chalk.dim("(history cleared)")); // confirm the reset
        return true;
      case "/stats":
        console.log(chalk.dim(statsReport())); // local counters, busiest first
        return true;
      case "/memory": {
        const facts = readMemory(); // the durable facts the agent carries across sessions
        console.log(chalk.dim(facts.length ? `long-term memory (${MEMORY_PATH}):\n${facts.map((f) => `  - ${f}`).join("\n")}` : "(no long-term memory yet — the agent saves facts with the remember tool)"));
        return true;
      }
      case "/cost":
        console.log(chalk.dim(costMeter.report())); // tokens, cache hit rate, estimated spend (local)
        return true;
      case "/undo": {
        // Revert the most recent write. This is a USER action on the filesystem,
        // not a turn for the model — the conversation is untouched. If the model
        // later edits a file it thinks it changed, edit_file's read-before-edit +
        // exact-match guards will catch the staleness and ask it to re-read.
        const undone = undoLast();
        if (!undone) {
          console.log(chalk.dim("(nothing to undo — no file writes recorded this session)"));
          return true;
        }
        console.log(chalk.dim(`↩ ${undone.summary}`));
        // Show the diff of what was put back (from the current state to the
        // restored one), reusing the Day 21 renderer.
        console.log(renderDiff(undone.after ?? "", undone.before ?? ""));
        return true;
      }
      case "/resume": {
        // List recent sessions in this project and switch to the chosen one.
        // Swapping mid-conversation is fine: we rebuild from the constitution +
        // the saved messages, and reset the per-conversation state (read-state,
        // undo history) so the resumed session behaves like a fresh start of it.
        const sessions = listSessions(10);
        if (!sessions.length) {
          console.log(chalk.dim("(no saved sessions in this project yet)"));
          return true;
        }
        console.log(chalk.dim("recent sessions in this project:"));
        sessions.forEach((s, i) => {
          const when = s.savedAt.slice(0, 16).replace("T", " "); // 2026-06-15 10:30
          console.log(chalk.dim(`  ${i + 1}. ${when} · ${s.messageCount} msg · ${s.title.slice(0, 60)}`));
        });
        const answer = (await readUserLine("  resume which? [number, or Enter to cancel] ")).trim();
        if (!answer) {
          console.log(chalk.dim("(cancelled)"));
          return true;
        }
        const idx = Number(answer) - 1;
        if (!Number.isInteger(idx) || idx < 0 || idx >= sessions.length) {
          console.log(chalk.dim("(not a valid choice — cancelled)"));
          return true;
        }
        const chosen = loadSession(sessions[idx].id);
        if (!chosen) {
          console.log(chalk.yellow("(could not load that session — it may be corrupt)"));
          return true;
        }
        messages = [{ role: "system", content: systemMessage }, ...chosen.messages]; // fresh constitution + saved turns
        sessionId = chosen.id; // keep appending to the resumed session's file
        forgetFilesExcept([]); // a resumed conversation must re-read files before editing them
        clearUndo(); // the previous session's writes are not ours to undo
        console.log(chalk.dim(`(resumed ${chosen.id} — ${chosen.messages.length} messages; files must be re-read before editing)`));
        return true;
      }
      case "/diff": {
        // A read-only review of the net effect of this session on the
        // filesystem — every file whose content differs from where it started,
        // shown as a diff from baseline → now. Reuses the Day 21 renderer.
        const changes = sessionChanges();
        if (!changes.length) {
          console.log(chalk.dim("(no file changes this session)"));
          return true;
        }
        const verb = { created: chalk.green("created"), modified: chalk.yellow("modified"), deleted: chalk.red("deleted") };
        console.log(chalk.dim(`${changes.length} file${changes.length === 1 ? "" : "s"} changed this session:`));
        for (const c of changes) {
          const short = path.relative(process.cwd(), c.path) || c.path;
          console.log(`\n${verb[c.status]} ${short}`);
          console.log(renderDiff(c.baseline, c.current));
        }
        return true;
      }
      case "/plan":
        // A toggle. Turning it on injects the rules of the mode as a user turn so
        // the model adopts them; the gate (permissions.ts) enforces them either way.
        if (isPlanMode()) {
          setPlanMode(false);
          console.log(chalk.dim("(plan mode OFF — writing and executing tools enabled again)"));
        } else {
          setPlanMode(true);
          messages.push({ role: "user", content: PLAN_MODE_NOTICE });
          console.log(chalk.dim("(plan mode ON — read-only research; the agent will present a plan for you to approve)"));
        }
        return true;
      case "/model":
        console.log(
          chalk.dim(
            `model: ${CONFIG.model}\n` +
              (CONFIG.subAgentModel ? `sub-agent model: ${CONFIG.subAgentModel} (delegated task work)\n` : "") +
              `endpoint: ${CONFIG.baseURL}\ncontext window: ${CONFIG.contextWindow} tokens (compaction at ~${COMPACT_AT})`,
          ),
        ); // where this session points
        return true;
      case "/compact": {
        if (messages.length <= 1) {
          console.log(chalk.dim("(nothing to compact yet)")); // only the system message so far
          return true;
        }
        try {
          await compactHistory(messages, client, CONFIG.model, new AbortController().signal); // same machinery as automatic compaction
        } catch (err) {
          console.log(chalk.yellow(`compaction failed: ${(err as Error).message}`)); // report, don't crash
        }
        return true;
      }
      default:
        if (line.startsWith("/")) {
          console.log(chalk.dim(`unknown command: ${line} — try /help`)); // typo guard
          return true; // still consumed — don't send typos to the model
        }
        return false; // a normal task line
    }
  };

  // The session loop: ask → run → render → ask again. This is what makes it
  // a conversation instead of a one-shot command.
  while (true) {
    // The input frame: a top rule, the framed "❯" prompt (yellow "⏸ plan ❯" in
    // plan mode), then a bottom rule once you submit — so the input area reads as
    // "type here". Only in a TTY; piped input gets no decoration.
    const tty = !!process.stdin.isTTY;
    if (tty) console.log("\n" + inputFrameTop());
    const raw = await readUserLine(framedPrompt(isPlanMode())); // next input, or "exit" on EOF
    if (tty) console.log(inputFrameBottom());
    const line = raw.trim();
    if (!line) continue; // empty line — just re-prompt
    if (line === "exit" || line === "quit") break; // explicit goodbye
    if (await handleCommand(line)) continue; // slash commands never reach the model

    // @file mentions: if the line references files (@src/loop.ts), attach their
    // content to the message so the model sees them directly. Secret files are
    // refused here, exactly as read_file would refuse them.
    const { augmented, mentions } = expandMentions(line);
    const attached = mentions.filter((m) => m.status === "ok").map((m) => m.raw);
    const refused = mentions.filter((m) => m.status === "denied").map((m) => m.raw);
    if (attached.length) console.log(chalk.dim(`(attached ${attached.length} file${attached.length === 1 ? "" : "s"}: ${attached.join(", ")})`));
    if (refused.length) console.log(chalk.yellow(`(refused secret file${refused.length === 1 ? "" : "s"}: ${refused.join(", ")})`));

    messages.push({ role: "user", content: augmented }); // the new turn (with any attached files) joins the shared history
    running = true; // Ctrl+C now means "interrupt the task"
    interrupted = false; // fresh interrupt state for this task
    controller = new AbortController(); // fresh abort signal for this task

    const result: LoopResult = await runLoop(messages, {
      client, // the configured API client
      model: CONFIG.model, // whatever the user configured — must support function calling
      signal: controller.signal, // for aborting requests
      isInterrupted: () => interrupted, // for stopping between steps
      confirm, // for permission prompts
      subAgentModel: CONFIG.subAgentModel, // delegated work may run on a different tier
      judge, // optional LLM classifier for the "ask" middle ground
    });
    running = false; // back at the prompt — Ctrl+C means "exit" again
    saveSession(sessionId, CONFIG.model, messages); // snapshot after every turn — crash-safe by construction

    // Done already streamed its answer to the screen; everything else gets a
    // one-line human explanation. The session continues either way — except a
    // fatal API error, which no amount of chatting will fix.
    if (result.reason !== TerminateReason.Done) {
      console.log(chalk.yellow(`\n⚠️ ${EXIT_NOTES[result.reason]}`)); // the human explanation
      if (result.detail) console.log(chalk.dim(`   ${result.detail.slice(0, 300)}`)); // raw detail for the curious
      if (result.reason === TerminateReason.FatalApiError) break; // a bad key won't fix itself mid-session
    }
  }

  emit("agent_session_end"); // close the books
  rl.close(); // release stdin
  console.log(chalk.dim("bye.")); // a clean goodbye
}

main(); // kick everything off

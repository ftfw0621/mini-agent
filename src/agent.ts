#!/usr/bin/env node
import OpenAI from "openai"; // the API client
import chalk from "chalk"; // terminal colors
import readline from "node:readline/promises"; // promise-based terminal input
import { createRequire } from "node:module"; // to read package.json for --version
import { CONFIG, requireApiKey, PROJECT_SETTINGS_PATH, GLOBAL_SETTINGS_PATH } from "./config.js"; // provider-agnostic settings (.env loaded there)
import { runLoop, TerminateReason, MAX_ROUNDS, MAX_RETRIES, type LoopResult } from "./loop.js"; // the state machine
import { buildSystemMessage } from "./prompt.js"; // the constitution + optional AGENT.md project memory
import { forgetFilesExcept } from "./tools.js"; // to reset file state on /clear
import { compactHistory, estimateHistoryTokens, COMPACT_AT } from "./context.js"; // for the manual /compact command
import { newSessionId, saveSession, latestSession } from "./session.js"; // conversation persistence (project-local)
import { initTelemetry, emit, statsReport } from "./telemetry.js"; // local-only event log + /stats
import { runHooks } from "./hooks.js"; // SessionStart lifecycle hook
import { connectMcpServers } from "./mcp.js"; // external tool servers (MCP)

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
  exit       leave (Ctrl+C at the prompt does the same)`;

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
  // The banner: who am I, which model and host am I on, and how to get help.
  console.log(
    chalk.bold(`mini-agent ${pkg.version}`) +
      chalk.dim(` — ${CONFIG.model} @ ${new URL(CONFIG.baseURL).host} | /help for commands · Ctrl+C interrupts a running task`),
  );

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
  const confirm = async (question: string): Promise<boolean> => {
    console.log(chalk.yellow(`\n⚠️ approval needed — ${question}`)); // always show what is being asked
    if (process.env.MINI_AGENT_AUTO_APPROVE === "1") {
      console.log(chalk.dim("  auto-approved (MINI_AGENT_AUTO_APPROVE=1)")); // bypass mode — say so out loud
      return true; // approve without asking
    }
    if (!process.stdin.isTTY) {
      console.log(chalk.dim("  non-interactive session — denied by default (fail closed)")); // nobody can answer — refuse
      return false; // fail closed
    }
    const answer = await readUserLine("  Allow? [y/N] "); // wait for the human (shares the line queue)
    return /^y(es)?$/i.test(answer.trim()); // anything but y/yes means no
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
        sessionId = newSessionId(); // a fresh conversation is a fresh session file
        console.log(chalk.dim("(history cleared)")); // confirm the reset
        return true;
      case "/stats":
        console.log(chalk.dim(statsReport())); // local counters, busiest first
        return true;
      case "/model":
        console.log(chalk.dim(`model: ${CONFIG.model}\nendpoint: ${CONFIG.baseURL}\ncontext window: ${CONFIG.contextWindow} tokens (compaction at ~${COMPACT_AT})`)); // where this session points
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
    const line = (await readUserLine(chalk.green("\n> "))).trim(); // next input, or "exit" on EOF
    if (!line) continue; // empty line — just re-prompt
    if (line === "exit" || line === "quit") break; // explicit goodbye
    if (await handleCommand(line)) continue; // slash commands never reach the model

    messages.push({ role: "user", content: line }); // the new turn joins the shared history
    running = true; // Ctrl+C now means "interrupt the task"
    interrupted = false; // fresh interrupt state for this task
    controller = new AbortController(); // fresh abort signal for this task

    const result: LoopResult = await runLoop(messages, {
      client, // the configured API client
      model: CONFIG.model, // whatever the user configured — must support function calling
      signal: controller.signal, // for aborting requests
      isInterrupted: () => interrupted, // for stopping between steps
      confirm, // for permission prompts
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

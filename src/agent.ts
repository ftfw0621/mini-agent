import OpenAI from "openai"; // the API client
import chalk from "chalk"; // terminal colors
import readline from "node:readline/promises"; // promise-based terminal input
import { runLoop, TerminateReason, MAX_ROUNDS, MAX_RETRIES, type LoopResult } from "./loop.js"; // the state machine
import { buildSystemMessage } from "./prompt.js"; // the constitution + optional AGENT.md project memory
import { forgetFilesExcept } from "./tools.js"; // to reset file state on /clear

// Build the API client once, for the whole session.
const client = new OpenAI({
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", // overridable for testing (point it at a dead port to simulate outages)
  apiKey: process.env.DEEPSEEK_API_KEY, // comes from .env via --env-file
  maxRetries: 0, // we own the retry policy — never let the SDK retry underneath us
});

// What we tell the user for every way a query can end. No raw stack traces.
const EXIT_NOTES: Record<Exclude<TerminateReason, TerminateReason.Done>, string> = {
  [TerminateReason.RoundCap]: `Hit the ${MAX_ROUNDS}-round cap. The task may be too big for one go — try splitting it.`,
  [TerminateReason.CircuitBreaker]: "3 API failures in a row — stopping here instead of burning money.",
  [TerminateReason.RetryBudgetExhausted]: `${MAX_RETRIES} failed API calls in this query — giving up. Check your network and try again.`,
  [TerminateReason.RateLimitBudgetExhausted]: "DeepSeek keeps rate-limiting us. Wait a minute, then try again.",
  [TerminateReason.ContextTooLong]: "The conversation no longer fits the model's context window, and compaction could not shrink it enough. Use /clear to start fresh.",
  [TerminateReason.CompactionFailed]: "Automatic compaction kept failing — stopping instead of looping. Use /clear to start fresh.",
  [TerminateReason.FatalApiError]: "Unrecoverable API error — retrying would not help. Check your API key and request.",
  [TerminateReason.UserInterrupt]: "Interrupted — back at the prompt.",
};

async function main() {
  // The banner: who am I, and the three things worth knowing.
  console.log(chalk.bold("mini-agent") + chalk.dim(` — deepseek-chat | "exit" to quit · "/clear" to reset · Ctrl+C interrupts a running task`));

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

  // The system message is built ONCE per session: stable prefix = cache hits
  // on every request. Nothing session-specific may sneak into it later.
  const systemMessage = buildSystemMessage();
  let messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: systemMessage }]; // the whole conversation lives here, across turns

  // Per-task interrupt state. `running` decides what Ctrl+C means right now.
  let running = false; // is a task currently executing?
  let interrupted = false; // has the current task been interrupted?
  let controller = new AbortController(); // aborts the in-flight API request

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

  // The session loop: ask → run → render → ask again. This is what makes it
  // a conversation instead of a one-shot command.
  while (true) {
    const line = (await readUserLine(chalk.green("\n> "))).trim(); // next input, or "exit" on EOF
    if (!line) continue; // empty line — just re-prompt
    if (line === "exit" || line === "quit") break; // explicit goodbye
    if (line === "/clear") {
      messages = [{ role: "system", content: systemMessage }]; // drop everything but the constitution
      forgetFilesExcept([]); // the file read-state belongs to the conversation — clear it too
      console.log(chalk.dim("(history cleared)")); // confirm the reset
      continue;
    }

    messages.push({ role: "user", content: line }); // the new turn joins the shared history
    running = true; // Ctrl+C now means "interrupt the task"
    interrupted = false; // fresh interrupt state for this task
    controller = new AbortController(); // fresh abort signal for this task

    const result: LoopResult = await runLoop(messages, {
      client, // the configured API client
      model: "deepseek-chat", // function calling works reliably on this model (not deepseek-reasoner)
      signal: controller.signal, // for aborting requests
      isInterrupted: () => interrupted, // for stopping between steps
      confirm, // for permission prompts
    });
    running = false; // back at the prompt — Ctrl+C means "exit" again

    // Done already streamed its answer to the screen; everything else gets a
    // one-line human explanation. The session continues either way — except a
    // fatal API error, which no amount of chatting will fix.
    if (result.reason !== TerminateReason.Done) {
      console.log(chalk.yellow(`\n⚠️ ${EXIT_NOTES[result.reason]}`)); // the human explanation
      if (result.detail) console.log(chalk.dim(`   ${result.detail.slice(0, 300)}`)); // raw detail for the curious
      if (result.reason === TerminateReason.FatalApiError) break; // a bad key won't fix itself mid-session
    }
  }

  rl.close(); // release stdin
  console.log(chalk.dim("bye.")); // a clean goodbye
}

main(); // kick everything off

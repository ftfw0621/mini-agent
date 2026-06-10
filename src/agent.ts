import OpenAI from "openai"; // the API client
import chalk from "chalk"; // terminal colors
import readline from "node:readline/promises"; // promise-based terminal input
import { runLoop, TerminateReason, MAX_ROUNDS, MAX_RETRIES, type LoopResult } from "./loop.js"; // the state machine

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
  [TerminateReason.ContextTooLong]: "The conversation no longer fits the model's context window, and compaction could not shrink it enough. Start a fresh session.",
  [TerminateReason.CompactionFailed]: "Automatic compaction kept failing — stopping instead of looping. Start a fresh session.",
  [TerminateReason.FatalApiError]: "Unrecoverable API error — retrying would not help. Check your API key and request.",
  [TerminateReason.UserInterrupt]: "Interrupted — stopped cleanly.",
};

// Ask the human to approve a dangerous action.
// Fail closed: in a non-interactive session (piped stdin, CI) nobody can say
// yes, so the answer is no. MINI_AGENT_AUTO_APPROVE=1 is our bypass mode for
// scripted use — but hard denies still win over it (checked in permissions.ts
// before we ever get here).
async function confirm(question: string): Promise<boolean> {
  console.log(chalk.yellow(`\n⚠️ approval needed — ${question}`)); // always show what is being asked
  if (process.env.MINI_AGENT_AUTO_APPROVE === "1") {
    console.log(chalk.dim("  auto-approved (MINI_AGENT_AUTO_APPROVE=1)")); // bypass mode — say so out loud
    return true; // approve without asking
  }
  if (!process.stdin.isTTY) {
    console.log(chalk.dim("  non-interactive session — denied by default (fail closed)")); // nobody can answer — refuse
    return false; // fail closed
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); // open a prompt
  const answer = await rl.question("  Allow? [y/N] "); // wait for the human
  rl.close(); // release stdin again
  return /^y(es)?$/i.test(answer.trim()); // anything but y/yes means no
}

async function main() {
  // Step 1: get the task from the user.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); // wire up terminal I/O
  const task = await rl.question("What should the AI do?\n> "); // block until the user answers
  rl.close(); // free stdin (confirm() opens its own interface when needed)

  // Step 2: wire up Ctrl+C handling.
  // First Ctrl+C: abort the in-flight request and wind down politely.
  // Second Ctrl+C: the user really means it — force quit.
  const controller = new AbortController(); // its signal is passed into every API request
  let interrupted = false; // polled by the loop between steps
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130); // second press: exit immediately (130 = killed by SIGINT)
    interrupted = true; // first press: raise the flag...
    controller.abort(); // ...and cancel the in-flight API request
    console.log(chalk.yellow("\n(interrupt received — winding down, Ctrl+C again to force quit)")); // tell the user we heard them
  });

  // Step 3: run the loop until it terminates for some named reason.
  const result: LoopResult = await runLoop([{ role: "user", content: task }], {
    client, // the configured API client
    model: "deepseek-chat", // function calling works reliably on this model (not deepseek-reasoner)
    signal: controller.signal, // for aborting requests
    isInterrupted: () => interrupted, // for stopping between steps
    confirm, // for permission prompts
  });

  // Step 4: render the ending.
  if (result.reason === TerminateReason.Done) {
    console.log(`\n🤖 ${result.finalText}`); // the happy path: print the model's answer
    return;
  }
  console.log(chalk.yellow(`\n⚠️ ${EXIT_NOTES[result.reason]}`)); // every other ending gets its one-line human explanation
  if (result.detail) console.log(chalk.dim(`   ${result.detail.slice(0, 300)}`)); // raw error detail, trimmed, for the curious
  process.exitCode = result.reason === TerminateReason.UserInterrupt ? 130 : 1; // scripts can tell interrupt from failure
}

main(); // kick everything off

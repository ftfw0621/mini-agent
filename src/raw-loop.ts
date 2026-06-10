import OpenAI from "openai"; // the official OpenAI SDK — DeepSeek is compatible with it
import { execSync } from "node:child_process"; // runs a shell command and waits for it to finish
import readline from "node:readline/promises"; // promise-based terminal input (for the question prompt)

// Create the API client. DeepSeek speaks the OpenAI wire protocol,
// so the only DeepSeek-specific thing here is the base URL.
const client = new OpenAI({
  baseURL: "https://api.deepseek.com", // point the SDK at DeepSeek instead of OpenAI
  apiKey: process.env.DEEPSEEK_API_KEY, // never hardcode keys — read from the environment
});

// Our first (and only) tool. This is NOT code the model runs — it is a
// machine-readable manual telling the model that a tool called "run_bash"
// exists and what arguments it takes.
const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: "function", // the only tool type the chat API supports
    function: {
      name: "run_bash", // the name the model will call us by
      description: "Run a bash command on the user's machine and return its output.", // when/why to use it
      parameters: {
        type: "object", // arguments always arrive as one JSON object
        properties: {
          command: { type: "string", description: "The bash command to run" }, // the single argument
        },
        required: ["command"], // the model must always provide it
      },
    },
  },
];

// The real implementation of the tool — plain TypeScript, invoked by US
// after the model asks for it. The model never executes anything itself.
function runBash(command: string): string {
  console.log(`\n🔧 running: ${command}`); // show the user what is about to run
  try {
    const out = execSync(command, { encoding: "utf8", timeout: 30_000 }); // run it, 30s time limit
    return out || "(command succeeded, no output)"; // the API rejects empty strings — always return something
  } catch (err) {
    return `Command failed: ${(err as Error).message}`; // don't crash — feed the error back to the model
  }
}

async function main() {
  // Ask the user for a task, once, via stdin.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); // wire up terminal I/O
  const task = await rl.question("What should the AI do?\n> "); // block until the user answers
  rl.close(); // release stdin so the process can exit cleanly later

  // The conversation history. This array IS the model's entire memory —
  // it re-reads the whole thing on every call and remembers nothing else.
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: task }];

  // The essence of an agent is this loop: model → tool → model → … → final state.
  // The hard cap is a safety net: never loop (and never burn money) forever.
  for (let round = 1; round <= 10; round++) {
    // One API call: send the full history plus the tool manual.
    const res = await client.chat.completions.create({ model: "deepseek-chat", messages, tools });
    const msg = res.choices[0].message; // the model's reply for this round
    messages.push(msg); // the reply must go into history, or tool results would be orphaned

    // No tool calls = the model considers the task done. That is the final state.
    if (!msg.tool_calls?.length) {
      console.log(`\n🤖 ${msg.content}`); // print the model's final answer
      return; // normal exit
    }

    // Otherwise: execute every tool call and feed each result back.
    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue; // ignore non-function call types
      const args = JSON.parse(call.function.arguments) as { command: string }; // arguments arrive as a JSON string
      messages.push({
        role: "tool", // a special message role: "here is what your tool returned"
        tool_call_id: call.id, // must match the call — the API enforces this pairing
        content: runBash(args.command).slice(0, 4000), // crude cap so huge outputs don't blow up the context
      });
    }
  }
  console.log("\n⚠️ Hit the 10-round cap, stopping."); // loop guard: stop at the cap, tell the user why
}

main(); // kick everything off

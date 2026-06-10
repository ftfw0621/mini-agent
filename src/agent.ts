import OpenAI from "openai"; // the API client
import readline from "node:readline/promises"; // promise-based terminal input
import { toolDefinitions, dispatch } from "./tools.js"; // the tool manuals + the executor

// Build the API client once, for the whole session.
const client = new OpenAI({
  baseURL: "https://api.deepseek.com", // DeepSeek's OpenAI-compatible endpoint
  apiKey: process.env.DEEPSEEK_API_KEY, // comes from .env via --env-file
});

const MAX_ROUNDS = 15; // more tools, slightly higher cap — but there must be one

async function main() {
  // Get the task from the user.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); // wire up terminal I/O
  const task = await rl.question("What should the AI do?\n> "); // block until the user answers
  rl.close(); // release stdin

  // The conversation history — the model's entire memory.
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: task }];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // One API call: full history + the manuals of all five tools.
    const res = await client.chat.completions.create({
      model: "deepseek-chat", // function calling works reliably on this model
      messages, // everything so far
      tools: toolDefinitions, // the five manuals from tools.ts
    });
    const msg = res.choices[0].message; // the model's reply
    messages.push(msg); // into history, so tool results stay paired with their calls

    // No tool calls = the model considers the task done. That is the final state.
    if (!msg.tool_calls?.length) {
      console.log(`\n🤖 ${msg.content}`); // print the final answer
      return; // normal exit
    }
    // Execute every tool call via the single dispatch entry point.
    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue; // ignore non-function call types
      console.log(`\n🔧 ${call.function.name} ${call.function.arguments.slice(0, 120)}`); // show what is being called
      messages.push({
        role: "tool", // the tool-result message role
        tool_call_id: call.id, // paired with the call by id
        content: dispatch(call.function.name, call.function.arguments), // dispatch never throws
      });
    }
  }
  console.log(`\n⚠️ Hit the ${MAX_ROUNDS}-round cap, stopping.`); // loop guard: stop at the cap
}

main(); // kick everything off

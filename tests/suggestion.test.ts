import type OpenAI from "openai"; // message shapes
import { check, finish } from "./helpers.js"; // assertions
import { cleanSuggestion, generatePromptSuggestion } from "../src/suggestion.js"; // unit under test

// ---- what counts as a usable guess -------------------------------------------
check("plain next step is kept", cleanSuggestion("run the tests") === "run the tests");
check("quotes are stripped", cleanSuggestion('"commit and push"') === "commit and push" && cleanSuggestion("「提交一下」") === "提交一下");
check("NONE means no guess", cleanSuggestion("NONE") === null && cleanSuggestion("none.") === null);
check("empty is no guess", cleanSuggestion("   ") === null);
check("multi-line answers are rejected", cleanSuggestion("run the tests\nthen commit") === null);
check("long text is rejected", cleanSuggestion("x".repeat(121)) === null);
check("the assistant's own voice is rejected", cleanSuggestion("I'll run the tests now") === null && cleanSuggestion("Let me check") === null && cleanSuggestion("好的，我来提交") === null);
check("Chinese next steps are kept", cleanSuggestion("推送吧") === "推送吧");

// ---- the request reuses the main call's prefix -----------------------------------
const history: OpenAI.ChatCompletionMessageParam[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "fix the bug" },
  { role: "assistant", content: "Fixed it." },
];
const tools: OpenAI.ChatCompletionTool[] = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }];
let sent: Record<string, unknown> = {};
const client = { chat: { completions: { create: async (params: Record<string, unknown>) => { sent = params; return { choices: [{ message: { content: "run the tests" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }; } } } };
const guess = await generatePromptSuggestion(client as never, "deepseek-flash", history, tools);
check("returns the cleaned guess", guess === "run the tests");
const msgs = sent.messages as OpenAI.ChatCompletionMessageParam[];
check("history is sent unchanged, as the prefix", JSON.stringify(msgs.slice(0, 3).map((m) => [m.role, m.content])) === JSON.stringify(history.map((m) => [m.role, m.content])));
check("one instruction is appended at the end", msgs.length === 4 && msgs[3].role === "user" && String(msgs[3].content).includes("Predict the user's NEXT message"));
check("the same tools are resent (cache) but can't be called", sent.tools === tools && sent.tool_choice === "none");
check("DeepSeek thinking is off for a one-line guess", JSON.stringify(sent.thinking) === JSON.stringify({ type: "disabled" }));
check("output is capped", sent.max_tokens === 60 && sent.stream === false);
check("the history array itself is not modified", history.length === 3);
await generatePromptSuggestion(client as never, "deepseek-flash", history, []);
check("no tools → no tool_choice", !("tools" in sent) && !("tool_choice" in sent));
const failing = { chat: { completions: { create: async () => { throw new Error("boom"); } } } };
check("a failed call is simply no guess", (await generatePromptSuggestion(failing as never, "m", history)) === null);

finish();

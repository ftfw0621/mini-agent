import { CONFIG } from "../src/config.js";
import { effortMenu, effortParameters, effortProfile, selectedEffort, setEffort } from "../src/effort.js";
import { runLoop } from "../src/loop.js";
import type OpenAI from "openai";
import { check, finish } from "./helpers.js";

const original = { baseURL: CONFIG.baseURL, profiles: CONFIG.effortProfiles, hooks: CONFIG.hooks };
try {
  CONFIG.baseURL = "https://api.deepseek.com"; CONFIG.effortProfiles = {}; CONFIG.hooks = {};
  check("DeepSeek lists actual levels instead of aliases", effortMenu("deepseek-flash").values.join(",") === "default,none,low,high,max");
  setEffort("deepseek-flash", "max");
  check("DeepSeek enables thinking with selected depth", JSON.stringify(effortParameters("deepseek-flash")) === '{"thinking":{"type":"enabled"},"reasoning_effort":"max"}');
  check("unsupported effort leaves the selection intact", setEffort("deepseek-flash", "medium").startsWith("Unsupported") && selectedEffort("deepseek-flash") === "max");
  check("a different model does not inherit the selection", selectedEffort("deepseek-v4-pro") === "default");
  setEffort("deepseek-flash", "none");
  check("thinking off uses provider-specific field", JSON.stringify(effortParameters("deepseek-flash")) === '{"thinking":{"type":"disabled"}}');
  setEffort("deepseek-flash", "default");
  check("default omits overrides", JSON.stringify(effortParameters("deepseek-flash")) === "{}");
  CONFIG.baseURL = "https://gateway.example.test/v1";
  check("unknown gateway does not guess capabilities", effortMenu("deepseek-flash").values.length === 0);
  CONFIG.effortProfiles = { "custom-model": { levels: ["low", "high"], parameter: "reasoning_effort" } };
  setEffort("custom-model", "high");
  check("custom profile adapts the same command to another vendor", effortParameters("custom-model").reasoning_effort === "high");
  CONFIG.baseURL = "https://api.openai.com/v1";
  check("OpenAI model families have distinct supported levels", !effortProfile("gpt-5.1")?.levels.includes("xhigh") && effortProfile("gpt-5.2-2025-12-11")?.levels.includes("xhigh") === true);
  check("unknown models do not get fabricated options", effortMenu("unknown-model").values.length === 0);
  setEffort("gpt-5.2", "xhigh");
  check("OpenAI uses reasoning_effort without DeepSeek fields", JSON.stringify(effortParameters("gpt-5.2")) === '{"reasoning_effort":"xhigh"}');

  CONFIG.baseURL = "https://api.deepseek.com";
  setEffort("deepseek-flash", "max");
  const requests: Record<string, unknown>[] = [];
  let round = 0;
  const client = { chat: { completions: { create: async (request: Record<string, unknown>) => {
    requests.push(structuredClone(request)); const first = round++ === 0;
    return (async function* () {
      yield { choices: [{ delta: { reasoning_content: first ? "check the user's choice" : "finish" } }] };
      yield { choices: [{ delta: first ? { tool_calls: [{ index: 0, id: "q", function: { name: "ask_user", arguments: '{"questions":[{"question":"Continue?","options":["Yes","No"]}]}' } }] } : { content: "Done" } }] };
    })();
  } } } };
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: "Help me" }];
  const opts = { client: client as never, model: "deepseek-flash", quiet: true, signal: new AbortController().signal, isInterrupted: () => false, confirm: async () => false, askUser: async () => null };
  await runLoop(messages, opts);
  check("selected effort reaches real loop API calls", requests.length === 2 && requests.every((r) => r.reasoning_effort === "max"));
  check("DeepSeek tool continuation retains reasoning in its own field", JSON.stringify(requests[1].messages).includes('"reasoning_content":"check the user'));
  check("reasoning never becomes the visible answer", !messages.filter((m) => m.role === "assistant").some((m) => String(m.content).includes("check the user")));
  CONFIG.baseURL = "https://api.openai.com/v1";
  await runLoop(messages, { ...opts, model: "gpt-5.2" });
  check("model switch removes provider-specific reasoning from outgoing messages", !JSON.stringify(requests.at(-1)?.messages).includes("reasoning_content"));
  check("model switch resolves its own saved effort", requests.at(-1)?.reasoning_effort === "xhigh");
} finally {
  CONFIG.baseURL = original.baseURL; CONFIG.effortProfiles = original.profiles; CONFIG.hooks = original.hooks;
}
finish();

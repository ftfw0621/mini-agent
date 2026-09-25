import type OpenAI from "openai"; // the client is injected, like title.ts
import { effortMessages, effortProfile } from "./effort.js"; // same message shape as the main loop sends
import { recordUsage } from "./cost.js"; // the suggestion call shows up in /cost like any other

// ---- Next-prompt suggestion (Claude Code's prompt suggestion) -------------------
// When a turn ends, guess what you'll type next and show it as a dim placeholder
// in the empty input box: Tab turns it into real text, Enter sends it. It's
// most useful at the obvious moments — "run the tests", "commit it", "yes, do
// the same for the other file" — so the guess must be short and concrete, or
// nothing at all.
//
// Cost: the request is the SAME history plus the SAME tools as the main call
// that just finished, with one instruction appended. That shared prefix is
// what the provider's prompt cache keys on (DeepSeek caches automatically),
// so almost all of the input is billed at the cached rate. tool_choice "none"
// keeps the tools in the prompt (cache) without letting the model call one.

const SUGGESTION_TIMEOUT_MS = 15_000;
const MAX_CHARS = 120;

const SUGGESTION_PROMPT = `[Next-prompt suggestion — this message is from the app, not the user]
Predict the user's NEXT message in this conversation: what they would most likely type now, given what just happened.
- Write it AS THE USER, addressed to the assistant (e.g. "run the tests", "commit and push", "也改一下另一个文件").
- Short and concrete: at most 12 words, or 30 characters for Chinese/Japanese. Same language the user writes in.
- Only a natural next step the user would actually want. No questions about preferences, no thanks, no pleasantries.
- If there is no clear next step, reply exactly: NONE
Reply with ONLY the message text — no quotes, no explanation.`;

// Keep only something that reads like a user's short next message. Anything
// else — an answer, a plan, the assistant's own voice — is worse than nothing.
export function cleanSuggestion(raw: string): string | null {
  let s = raw.trim().replace(/^["'“”「」`]+|["'“”「」`]+$/g, "").trim();
  if (!s || /^none\.?$/i.test(s) || s.includes("\n")) return null;
  if (s.length > MAX_CHARS) return null;
  if (/^(i'll|i will|i've|i have|let me|sure|okay,? i|here's|the user)\b/i.test(s)) return null; // the assistant talking, not the user
  if (/^(好的|我来|我会|我已经|用户)/.test(s)) return null;
  s = s.replace(/\s+/g, " ");
  return s;
}

export async function generatePromptSuggestion(
  client: OpenAI,
  model: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[] = [],
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await client.chat.completions.create(
      {
        model, // the conversation's model: its cache holds this prefix
        messages: [...effortMessages(model, messages), { role: "user", content: SUGGESTION_PROMPT }],
        ...(tools.length ? { tools, tool_choice: "none" as const } : {}),
        ...(effortProfile(model)?.parameter === "deepseek" ? { thinking: { type: "disabled" } } : {}), // a one-line guess needs no reasoning
        max_tokens: 60,
        stream: false,
      },
      { timeout: SUGGESTION_TIMEOUT_MS, signal },
    );
    recordUsage(res.usage as unknown as Record<string, unknown>);
    return cleanSuggestion(res.choices?.[0]?.message?.content ?? "");
  } catch {
    return null; // a failed guess is simply no guess
  }
}

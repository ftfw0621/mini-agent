import type OpenAI from "openai"; // the client is injected so title generation reuses the session's connection

// One cheap model call that turns the user's first prompt into a short,
// pickable session name — the same idea Claude Code uses (a Haiku-tier call
// producing a 3-7 word sentence-case title, stored as the session's aiTitle).
// It runs once, fire-and-forget, after the first real user message, so it never
// blocks the turn and a failure silently falls back to the raw first prompt.

const TITLE_SYSTEM = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of the user's request. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.
Return ONLY the title — no quotes, no leading/trailing punctuation, no explanation.

Good examples:
Fix login button on mobile
Add OAuth authentication
Debug failing CI tests
Refactor API client error handling

Bad (too vague): Code changes
Bad (too long): Investigate and fix the issue where the login button does not respond on mobile devices
Bad (wrong case): Fix Login Button On Mobile`;

// Strip the model's inevitable chatter: surrounding quotes, trailing periods,
// markdown fences, and any multi-line prose. Pure + lenient on purpose.
export function cleanSessionTitle(text: string): string {
  let t = text.replace(/^```[^\n]*\n?|\n?```$/g, ""); // drop a markdown fence if present
  t = t.split("\n")[0] ?? ""; // first line only
  t = t.replace(/^[\s"'“”‘’]+|[\s"'“”‘’.。]+$/g, "").trim(); // strip quotes + trailing punctuation
  return t.replace(/\s+/g, " ").trim();
}

// Generate a session title from the first user message. Returns null on any
// failure (bad model response, network error) — callers fall back to the prompt.
export async function generateSessionTitle(
  client: OpenAI,
  model: string,
  firstPrompt: string,
): Promise<string | null> {
  const trimmed = firstPrompt.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  let text = "";
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: TITLE_SYSTEM },
        { role: "user", content: trimmed },
      ],
      stream: false,
    });
    text = res.choices?.[0]?.message?.content ?? "";
  } catch {
    return null; // a failed title must never surface or break the session
  }
  const title = cleanSessionTitle(text);
  return title || null;
}

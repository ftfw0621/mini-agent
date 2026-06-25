import type OpenAI from "openai"; // types + the client passed in
import { recordUsage } from "../cost.js"; // meter token usage from the stream → live $ in the status bar

// Increment 1 of the Ink REPL: a MINIMAL streaming chat turn — no tools, no
// permission gate, no compaction. Just enough to drive the new layout (your
// message → a streamed reply) so we can confirm the input box behaves like
// Claude Code's. Later increments route the real agent loop (loop.ts) through
// this same (input, onToken) → final-text seam.
export function makeRunTurn(client: OpenAI, model: string, messages: OpenAI.ChatCompletionMessageParam[]) {
  return async (input: string, onToken: (t: string) => void): Promise<string> => {
    messages.push({ role: "user", content: input });
    let content = "";
    try {
      const stream = await client.chat.completions.create({ model, messages, stream: true, stream_options: { include_usage: true } });
      for await (const chunk of stream) {
        if (chunk.usage) recordUsage(chunk.usage as unknown as Record<string, unknown>); // final usage chunk → meter the cost
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          content += delta;
          onToken(delta);
        }
      }
    } catch (e) {
      content = `[error] ${(e as Error).message}`;
    }
    messages.push({ role: "assistant", content });
    return content;
  };
}

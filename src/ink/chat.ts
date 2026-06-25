import type OpenAI from "openai"; // types + the client passed in
import { runLoop, type LoopResult } from "../loop.js"; // the REAL agent loop — tools, permissions, retries, the lot
import { CONFIG } from "../config.js"; // model + sub-agent tier
import type { LoopOutput } from "../output.js"; // the Ink sink implements this

// What the App hands the loop for one turn: where output goes (the Ink sink) and
// how to ask the human. The loop already takes these as injected callbacks, so
// the Ink REPL just provides Ink-flavoured versions.
export interface TurnHooks {
  output: LoopOutput; // the Ink sink (src/ink/sink.ts)
  confirm: (question: string, toolName?: string) => Promise<boolean>; // permission prompt
  askUser?: (questions: { question: string; options: string[] }[]) => Promise<{ question: string; answer: string }[] | null>; // the ask_user form
  signal: AbortSignal; // aborts the in-flight request (Esc / Ctrl+C)
  isInterrupted: () => boolean; // polled between steps for a clean stop
}

// Drive one real turn through the loop. The loop mutates `messages` in place
// (appends the assistant reply + any tool messages), exactly as the readline
// REPL relies on — so we only push the user turn here and let the loop do the
// rest. All screen output flows through hooks.output (the Ink sink).
export function makeRunTurn(client: OpenAI, messages: OpenAI.ChatCompletionMessageParam[]) {
  return async (input: string, hooks: TurnHooks): Promise<LoopResult> => {
    messages.push({ role: "user", content: input });
    return runLoop(messages, {
      client,
      model: CONFIG.model,
      signal: hooks.signal,
      isInterrupted: hooks.isInterrupted,
      confirm: hooks.confirm,
      askUser: hooks.askUser,
      subAgentModel: CONFIG.subAgentModel,
      output: hooks.output,
    });
  };
}

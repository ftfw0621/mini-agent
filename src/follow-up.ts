import type OpenAI from "openai";
import { emit } from "./telemetry.js"; // queued vs delivered: tells "never arrived" from "arrived and ignored"

export interface FollowUpMessage {
  text: string; // original human text, separate from hooks/attachments
  displayText?: string; // optional compact UI text; never used as authorization
  content: OpenAI.ChatCompletionUserMessageParam["content"];
  queuedAt?: number; // stamped on enqueue; delivery telemetry reports the wait
}

// Frontends enqueue; only the lead loop consumes, at a complete tool boundary.
// No terminal, provider or permission policy lives in this queue.
export class FollowUpQueue {
  private messages: FollowUpMessage[] = [];
  constructor(private changed: () => void = () => {}) {}
  get size(): number { return this.messages.length; }
  get pending(): readonly FollowUpMessage[] { return this.messages; }
  enqueue(message: FollowUpMessage): void {
    this.messages.push({ ...message, queuedAt: message.queuedAt ?? Date.now() });
    emit("agent_follow_up", { phase: "queued" });
    this.changed();
  }
  drain(): FollowUpMessage[] {
    const messages = this.messages;
    this.messages = [];
    if (messages.length) this.changed();
    return messages;
  }
}

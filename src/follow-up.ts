import type OpenAI from "openai";

export interface FollowUpMessage {
  text: string; // original human text, separate from hooks/attachments
  displayText?: string; // optional compact UI text; never used as authorization
  content: OpenAI.ChatCompletionUserMessageParam["content"];
}

// Frontends enqueue; only the lead loop consumes, at a complete tool boundary.
// No terminal, provider or permission policy lives in this queue.
export class FollowUpQueue {
  private messages: FollowUpMessage[] = [];
  constructor(private changed: () => void = () => {}) {}
  get size(): number { return this.messages.length; }
  get pending(): readonly FollowUpMessage[] { return this.messages; }
  enqueue(message: FollowUpMessage): void {
    this.messages.push(message);
    this.changed();
  }
  drain(): FollowUpMessage[] {
    const messages = this.messages;
    this.messages = [];
    if (messages.length) this.changed();
    return messages;
  }
}

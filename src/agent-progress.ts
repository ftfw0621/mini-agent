// Per-worker display state. It observes execution, never controls permissions
// or task scheduling. The bounded transcript is a live inspection view.
export interface AgentView {
  id: string;
  name: string;
  description: string;
  model: string;
  status: "running" | "idle" | "done" | "failed";
  elapsedMs: number;
  tokens: number;
  estimated: boolean;
  toolCalls: number;
  activity: string;
  transcript: string;
}

export class AgentProgress {
  readonly startedAt = Date.now();
  private endedAt?: number;
  private tokens = 0;
  private estimated = false;
  liveTokens = 0;
  toolCalls = 0;
  activity = "Starting";
  transcript = "";
  private truncated = false;

  constructor(readonly model: string) {}

  append(text: string): void {
    this.transcript += text;
    if (this.transcript.length > 32_000) {
      this.transcript = this.transcript.slice(-32_000);
      this.truncated = true;
    }
  }

  finishModelCall(reportedTokens?: number): void {
    this.tokens += reportedTokens ?? this.liveTokens;
    if (reportedTokens === undefined && this.liveTokens > 0) this.estimated = true;
    this.liveTokens = 0;
  }

  finish(): void { this.endedAt ??= Date.now(); }

  view(id: string, name: string, description: string, status: AgentView["status"]): AgentView {
    return {
      id, name, description, status, model: this.model,
      elapsedMs: (this.endedAt ?? Date.now()) - this.startedAt,
      tokens: this.tokens + this.liveTokens,
      estimated: this.estimated || this.liveTokens > 0,
      toolCalls: this.toolCalls, activity: this.activity,
      transcript: (this.truncated ? "… (earlier activity omitted)\n" : "") + this.transcript,
    };
  }
}

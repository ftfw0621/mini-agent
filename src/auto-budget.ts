// One object per root task, shared by descendants and interrupt/resume. An
// exhausted budget is sticky: a late successful worker cannot reopen the gate.
// Claude Code's denial limits: 3 in a row or 20 per task. Rules-policy denials
// stop the task there; score-policy doubts returned to the agent instead turn
// back into human prompts (escalated) until an action executes again.
export class AutoReviewBudget {
  private consecutive = 0;
  private total = 0;
  private stopped = false;
  get exhausted(): boolean { return this.stopped; }
  get escalated(): boolean { return this.consecutive >= 3 || this.total >= 20; }
  deny(): void {
    this.block();
    this.stopped ||= this.escalated;
  }
  block(): void {
    this.total++;
    this.consecutive++;
  }
  executed(): void { if (!this.stopped) this.consecutive = 0; }
}

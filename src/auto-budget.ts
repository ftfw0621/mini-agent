// One object per root task, shared by descendants and interrupt/resume. An
// exhausted budget is sticky: a late successful worker cannot reopen the gate.
export class AutoReviewBudget {
  private consecutive = 0;
  private total = 0;
  private stopped = false;
  get exhausted(): boolean { return this.stopped; }
  deny(): void {
    this.total++;
    this.consecutive++;
    this.stopped ||= this.consecutive >= 3 || this.total >= 20;
  }
  executed(): void { if (!this.stopped) this.consecutive = 0; }
}

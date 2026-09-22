import { CONFIG } from "./config.js";
import { emit } from "./telemetry.js";
import { reviewDebugPath } from "./auto-debug.js";
import type OpenAI from "openai";
import type { ReviewHistory } from "./auto-context.js";
import { decideReview, type AutoVerdict, type ReviewAssessment, type ReviewProvider, type ReviewState } from "./auto-review.js";
import { jevReviewer, modelReviewer, parseJevAssessment, parseModelAssessment, ReviewProviderUnavailable } from "./auto-providers.js";
export type { AutoVerdict } from "./auto-review.js";

const TIMEOUT_MS = 30_000;
const MAX_STATE_BYTES = 24_000;

// Compatibility helpers use the exact same parsers and policy as live review.
export function interpretAutoOutput(value: unknown): AutoVerdict | null {
  const assessment = parseJevAssessment(value);
  if (!assessment) return null;
  const verdict = decideReview(assessment);
  return { ...verdict, reason: `Jev: ${verdict.reason}` };
}
export function interpretModelOutput(text: string): AutoVerdict | null {
  const assessment = parseModelAssessment(text);
  return assessment ? decideReview(assessment) : null;
}

interface AutoModeOptions {
  apiKey?: string; // dependency injection for offline tests; never persisted
  request?: typeof fetch;
  projectInstructions?: string; // full startup snapshot, never re-read after agent edits
}

export interface AutoReviewOptions {
  description?: string;
  history?: ReviewHistory;
  delegatedTask?: string; // parent-authored task context, never a user grant
  notify?: (message: string) => void;
}

// Each provider gets a fresh deadline. A Jev timeout must not hand an already
// aborted signal to the fallback; a USER cancellation must abort both paths.
async function withDeadline<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
  try {
    const result = await run(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export class AutoMode {
  enabled: boolean;
  private errors = 0;
  private requests: string[] = [];
  private apiKey: string;
  private jev?: ReviewProvider;
  private model?: ReviewProvider;
  private projectInstructions: string;
  private jevFailed = false; // sticky failover: do not retry an exhausted key on every tool

  constructor(
    client?: OpenAI,
    options: AutoModeOptions = {},
  ) {
    this.enabled = CONFIG.autoMode.enabled;
    this.apiKey = options.apiKey ?? (process.env.JEV_API_KEY?.trim() || process.env.TYPESAFE_API_KEY?.trim() || "");
    this.jev = this.apiKey ? jevReviewer(this.apiKey, () => CONFIG.autoMode.model, options.request ?? fetch) : undefined;
    this.model = client ? modelReviewer(client, () => CONFIG.judge.model || CONFIG.model) : undefined;
    this.projectInstructions = options.projectInstructions ?? "";
  }

  // Resolve the fallback model at call time: /model changes must take effect
  // when no explicit judge.model was configured. Its client/baseURL/key always
  // come from the same vendor as the main agent.
  private get useJev(): boolean { return !!this.apiKey && !this.jevFailed; }
  get backend(): string { return this.useJev ? `Jev (${CONFIG.autoMode.model})` : `model judge (${CONFIG.judge.model || CONFIG.model})`; }

  startupNotices(): string[] {
    return [
      this.status(),
      ...(reviewDebugPath() ? [`Review debug log: ${reviewDebugPath()} (local conversation/tool data; credentials redacted).`] : []),
      ...(!this.apiKey ? ["Tip: mini-agent supports Jev for permission review. Set JEV_API_KEY (or TYPESAFE_API_KEY) to use it automatically; otherwise /auto uses your current vendor (judge.model overrides the model)."] : []),
    ];
  }

  // Called ONLY at human input boundaries (text or submitted form answers),
  // before @files, hooks, skills or
  // summaries are appended. Never infer provenance from role:"user": that role
  // also carries model-written summaries and teammate notifications here.
  recordRequest(text: string): void {
    if (text.trim()) this.requests.push(text);
  }

  snapshot(): readonly string[] { return [...this.requests]; }
  clearRequests(): void { this.requests = []; }

  toggle(): string {
    this.enabled = !this.enabled;
    this.errors = 0;
    this.jevFailed = false;
    return this.status();
  }

  status(): string {
    return `(auto mode ${this.enabled ? "ON" : "OFF"} — ${this.backend}; ${this.enabled ? "uncertain or risky actions require approval" : "use /auto to enable"})`;
  }

  async classify(tool: string, argsJson: string, userRequests: readonly string[], signal: AbortSignal, options: AutoReviewOptions = {}): Promise<AutoVerdict> {
    const ask = (reason: string): AutoVerdict => ({ decision: "ask", reason });
    if (!this.jev && !this.model) return ask("Model judge unavailable; manual approval required");
    if (this.errors >= 3) return ask("Auto review disabled after 3 consecutive failures; manual approval required (toggle /auto off and on to retry)");
    if (signal.aborted) return ask("Auto review interrupted");
    if (!userRequests.length) return ask("Auto review needs a fresh user request; restored/synthetic messages are not authorization");
    let args: unknown;
    try { args = JSON.parse(argsJson); } catch { return ask("Invalid tool arguments"); }
    const state: ReviewState = {
      userRequests, projectInstructions: this.projectInstructions,
      workingDirectory: process.cwd(), deniedBySettings: CONFIG.permissions.deny,
      history: options.history ?? { actions: [], omittedActions: 0 }, delegatedTask: options.delegatedTask,
      action: { tool, args, description: options.description },
    };
    // Never silently truncate an action or earlier restrictions to get an allow.
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) return ask("Auto review context is too large; manual approval required");
    const started = Date.now();
    try {
      let assessment: ReviewAssessment | null = null;
      let backend = "model";
      if (this.useJev) {
        try {
          assessment = await withDeadline(signal, (reviewSignal) => this.jev!.review(state, reviewSignal));
          backend = "jev";
        } catch (error) {
          if (signal.aborted || !this.model) throw error;
          if (!this.jevFailed) {
            this.jevFailed = true;
            const reason = error instanceof ReviewProviderUnavailable ? error.message : "unavailable or timed out";
            options.notify?.(`Tip: Jev ${reason}; falling back to ${this.backend} for this session.`);
            emit("agent_auto_fallback", { reason, model: CONFIG.judge.model || CONFIG.model });
          }
        }
      }
      // A valid negative judgment is not a service failure: never shop it to
      // another model. Both adapters feed one decision function below.
      if (!assessment) assessment = await withDeadline(signal, (reviewSignal) => this.model!.review(state, reviewSignal));
      const verdict = decideReview(assessment);
      verdict.reason = `${backend === "jev" ? "Jev" : this.backend}: ${verdict.reason}`;
      if (signal.aborted) return ask("Auto review interrupted");
      this.errors = 0;
      emit("agent_auto_verdict", { tool, verdict: verdict.decision, backend,
        model: backend === "jev" ? CONFIG.autoMode.model : CONFIG.judge.model || CONFIG.model,
        authorization: typeof assessment.authorized === "number" ? assessment.authorized : String(assessment.authorized),
        risk: typeof assessment.risky === "number" ? assessment.risky : String(assessment.risky), durationMs: Date.now() - started });
      return verdict;
    } catch {
      if (!signal.aborted) this.errors++;
      emit("agent_auto_unavailable", { tool, disabled: Number(this.errors >= 3) });
      return ask(`${this.backend} unavailable, timed out or returned an invalid response; manual approval required`);
    }
  }
}

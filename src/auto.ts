import { randomUUID } from "node:crypto";
import { ruleHistory, startupRemotes } from "./auto-context.js";
import { decideRules, screenRules, RULE_ROUTING_VERSION, JEV_CLEAR_RULE_MAX, RULE_POLICY_VERSION, type RuleProvider } from "./auto-review.js";
import { CONFIG } from "./config.js";
import { emit } from "./telemetry.js";
import { beginReviewDebug, reviewDebugPath } from "./auto-debug.js";
import type OpenAI from "openai";
import type { ReviewHistory } from "./auto-context.js";
import { decideReview, needsAuthorizationReview, type AutoVerdict, type ReviewAssessment, type ReviewProvider, type ReviewState } from "./auto-review.js";
import { jevReviewer, modelReviewer, modelRuleReviewer, jevRuleReviewer, parseJevAssessment, parseModelAssessment, ReviewProviderUnavailable } from "./auto-providers.js";
export type { AutoVerdict } from "./auto-review.js";

const TIMEOUT_MS = 30_000;
const MAX_STATE_BYTES = 24_000;
// Sizes behind the two known cliffs, recorded on every verdict: stateBytes over
// MAX_STATE_BYTES forces a human prompt, and omittedActions > 0 disables the Jev
// fast pass. The parts say WHICH input grew (pasted requests vs. a big write).
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
function stateSize(state: ReviewState): Record<string, number> {
  return { stateBytes: bytes(state), requestBytes: bytes(state.userRequests), historyBytes: bytes(state.history.actions),
    actionBytes: bytes(state.action.args), omittedActions: state.history.omittedActions };
}

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
  policy?: "scores" | "rules";
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
  readonly policy: "scores" | "rules";
  private ruleModel?: RuleProvider;
  private ruleJev?: RuleProvider;
  private readonly workingDirectory = process.cwd();
  private readonly remotes = startupRemotes(this.workingDirectory);
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
    this.policy = options.policy ?? CONFIG.autoMode.policy;
    this.ruleModel = client ? modelRuleReviewer(client, () => CONFIG.judge.model || CONFIG.model) : undefined;
    this.apiKey = options.apiKey ?? (process.env.JEV_API_KEY?.trim() || process.env.TYPESAFE_API_KEY?.trim() || "");
    this.ruleJev = this.apiKey ? jevRuleReviewer(this.apiKey, () => CONFIG.autoMode.model, options.request ?? fetch) : undefined;
    this.jev = this.apiKey ? jevReviewer(this.apiKey, () => CONFIG.autoMode.model, options.request ?? fetch) : undefined;
    this.model = client ? modelReviewer(client, () => CONFIG.judge.model || CONFIG.model) : undefined;
    this.projectInstructions = options.projectInstructions ?? "";
  }

  // Resolve the fallback model at call time: /model changes must take effect
  // when no explicit judge.model was configured. Its client/baseURL/key always
  // come from the same vendor as the main agent.
  private get useJev(): boolean { return !!this.apiKey && !this.jevFailed; }
  get backend(): string { return this.policy === "rules" ? `${this.useJev ? "Jev screen → " : ""}rule reviewer (${CONFIG.judge.model || CONFIG.model})` : this.useJev ? `Jev (${CONFIG.autoMode.model})` : `model judge (${CONFIG.judge.model || CONFIG.model})`; }

  startupNotices(): string[] {
    if (this.policy === "rules") return [this.status(), this.useJev ? "Rules preview: Jev screens first; flagged or uncertain actions receive one model review." : "Tip: set JEV_API_KEY (or TYPESAFE_API_KEY) for Jev screening; currently using the model reviewer.", ...(reviewDebugPath() ? [`Review debug log: ${reviewDebugPath()}`] : [])];
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
    if (this.policy === "rules") return this.classifyRules(tool, argsJson, userRequests, signal, options);
    // One ID per review joins the debug log, this verdict event and the human's
    // later decision in loop.ts — the join that turns logs into labeled data.
    const reviewId = randomUUID();
    const started = Date.now();
    const measured: Record<string, number> = {};
    const finish = (verdict: AutoVerdict, fields: Record<string, string | number> = {}): AutoVerdict => {
      emit("agent_auto_verdict", { reviewId, policy: "scores", tool, verdict: verdict.decision, ...measured, ...fields, durationMs: Date.now() - started });
      return { ...verdict, reviewId };
    };
    const ask = (reason: string): AutoVerdict => finish({ decision: "ask", reason }, { outcome: "precondition" });
    if (!this.jev && !this.model) return ask("Model judge unavailable; manual approval required");
    if (this.errors >= 3) return ask("Auto review disabled after 3 consecutive failures; manual approval required (toggle /auto off and on to retry)");
    if (signal.aborted) return ask("Auto review interrupted");
    if (!userRequests.length) return ask("Auto review needs a fresh user request; restored/synthetic messages are not authorization");
    let args: unknown;
    try { args = JSON.parse(argsJson); } catch { return ask("Invalid tool arguments"); }
    const state: ReviewState = {
      reviewId, userRequests, projectInstructions: this.projectInstructions,
      workingDirectory: process.cwd(), deniedBySettings: CONFIG.permissions.deny,
      history: options.history ?? { actions: [], omittedActions: 0 }, delegatedTask: options.delegatedTask,
      action: { tool, args, description: options.description },
    };
    Object.assign(measured, stateSize(state));
    // Never silently truncate an action or earlier restrictions to get an allow.
    if (measured.stateBytes > MAX_STATE_BYTES) return ask("Auto review context is too large; manual approval required");
    let activeBackend = this.backend;
    try {
      let assessment: ReviewAssessment | null = null;
      let backend = "model";
      let priorAssessment = "";
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
      // Distinguish an uncertain authorization from a refusal. This one-shot
      // second stage uses the same state/policy, independently judges BOTH
      // dimensions, and never changes the session's preferred backend.
      if (assessment && this.model && needsAuthorizationReview(assessment)) {
        signal.throwIfAborted();
        priorAssessment = `Jev authorization=${assessment.authorized}, risk=${assessment.risky} → `;
        activeBackend = `model judge (${CONFIG.judge.model || CONFIG.model})`;
        const debug = beginReviewDebug("authorization-review", { state, jevAssessment: assessment, reviewer: activeBackend }, [this.apiKey], reviewId);
        emit("agent_auto_authorization_review", { tool, model: CONFIG.judge.model || CONFIG.model });
        try {
          assessment = await withDeadline(signal, (reviewSignal) => this.model!.review(state, reviewSignal));
          debug("assessment", { assessment, verdict: decideReview(assessment) });
          backend = "model";
        } catch (error) {
          debug("error", { error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }
      if (!assessment) {
        activeBackend = `model judge (${CONFIG.judge.model || CONFIG.model})`;
        assessment = await withDeadline(signal, (reviewSignal) => this.model!.review(state, reviewSignal));
      }
      const verdict = decideReview(assessment);
      verdict.reason = `${priorAssessment}${backend === "jev" ? "Jev" : activeBackend}: ${verdict.reason}`;
      if (signal.aborted) return ask("Auto review interrupted");
      this.errors = 0;
      return finish(verdict, { outcome: "reviewed", backend,
        model: backend === "jev" ? CONFIG.autoMode.model : CONFIG.judge.model || CONFIG.model,
        authorization: typeof assessment.authorized === "number" ? assessment.authorized : String(assessment.authorized),
        risk: typeof assessment.risky === "number" ? assessment.risky : String(assessment.risky) });
    } catch {
      if (!signal.aborted) this.errors++;
      emit("agent_auto_unavailable", { tool, disabled: Number(this.errors >= 3) });
      return finish({ decision: "ask", reason: `${activeBackend} unavailable, timed out or returned an invalid response; manual approval required` }, { outcome: "unavailable" });
    }
  }
  private async classifyRules(tool: string, argsJson: string, userRequests: readonly string[], signal: AbortSignal, options: AutoReviewOptions): Promise<AutoVerdict> {
    const reviewId = randomUUID();
    const policyVersion = RULE_POLICY_VERSION;
    let backend: "jev" | "model" = "model";
    const debug = beginReviewDebug("rules", { reviewId, policyVersion, routingVersion: RULE_ROUTING_VERSION, cutoff: JEV_CLEAR_RULE_MAX, tool }, [this.apiKey], reviewId);
    const started = Date.now();
    const measured: Record<string, number> = {};
    let route = "none"; // how the review was routed: jev_allow, jev_flagged, history_truncated, jev_unavailable, no_jev
    const finish = (verdict: AutoVerdict): AutoVerdict => {
      debug("verdict", { policyVersion, routingVersion: RULE_ROUTING_VERSION, backend, verdict });
      emit("agent_auto_verdict", { reviewId, policy: "rules", policyVersion, tool, backend, model: backend === "jev" ? CONFIG.autoMode.model : CONFIG.judge.model || CONFIG.model, verdict: verdict.decision, rules: (verdict.ruleIds ?? []).join(","), route, ...measured, durationMs: Date.now() - started });
      return { ...verdict, reviewId, reason: `${backend === "jev" ? "Jev" : `rule reviewer (${CONFIG.judge.model || CONFIG.model})`}: ${verdict.reason}` };
    };
    const ask = (reason: string) => finish({ decision: "ask", ruleIds: [], reason });
    if (signal.aborted) return ask("Review interrupted");
    if (!this.ruleModel) return ask("Model reviewer unavailable; Jev scores cannot replace rule review");
    if (this.errors >= 3) return ask("Review disabled after 3 failures; toggle /auto to retry");
    if (!userRequests.length) return ask("A genuine human request is required");
    let args: unknown;
    try { args = JSON.parse(argsJson); } catch { return ask("Invalid tool arguments"); }
    const state: ReviewState = {
      reviewId, policyVersion, userRequests, projectInstructions: this.projectInstructions,
      workingDirectory: this.workingDirectory, startupRemotes: this.remotes, deniedBySettings: [...CONFIG.permissions.deny],
      history: ruleHistory(options.history ?? { actions: [], omittedActions: 0 }), delegatedTask: options.delegatedTask,
      action: { tool, args, description: tool === "run_bash" || tool === "run_bash_background" ? "Execute the supplied shell command." : options.description },
    };
    Object.assign(measured, stateSize(state));
    if (measured.stateBytes > MAX_STATE_BYTES) return ask("Review context too large; no evidence was silently truncated");
    try {
      if (this.useJev && this.ruleJev) {
        try {
          const screening = await withDeadline(signal, (s) => this.ruleJev!.review(state, s));
          signal.throwIfAborted();
          const routing = screenRules(screening, state.history);
          debug("routing", { routingVersion: RULE_ROUTING_VERSION, cutoff: JEV_CLEAR_RULE_MAX, ...routing });
          route = routing.route === "allow" ? "jev_allow" : state.history.omittedActions > 0 ? "history_truncated" : "jev_flagged";
          if (routing.route === "allow") {
            this.errors = 0;
            backend = "jev";
            return finish({ decision: "allow", ruleIds: [], reason: routing.reason });
          }
        } catch (error) {
          if (signal.aborted) throw error;
          if (!this.jevFailed) {
            this.jevFailed = true;
            const reason = error instanceof ReviewProviderUnavailable ? error.message : "unavailable or timed out";
            options.notify?.(`Tip: Jev ${reason}; falling back to ${this.backend} for this session.`);
            emit("agent_auto_fallback", { reason, model: CONFIG.judge.model || CONFIG.model });
          }
          debug("routing", { routingVersion: RULE_ROUTING_VERSION, route: "review", reason: "Jev unavailable" });
          route = "jev_unavailable";
        }
      } else {
        route = "no_jev";
        debug("routing", { routingVersion: RULE_ROUTING_VERSION, route: "review", reason: this.jevFailed ? "Jev disabled after failure" : "No Jev key" });
      }
      // Same state, without first-stage scores. A suspicion is not a confirmed
      // rule match; the reasoning model evaluates the evidence independently.
      const assessment = await withDeadline(signal, (s) => this.ruleModel!.review(state, s));
      if (signal.aborted) return ask("Review interrupted");
      this.errors = 0;
      return finish(decideRules(assessment));
    } catch (error) {
      debug("error", { error: error instanceof Error ? error.message : String(error) });
      if (!signal.aborted) this.errors++;
      return ask(signal.aborted ? "Review interrupted" : "Model reviewer unavailable, timed out or returned invalid rules");
    }
  }

}

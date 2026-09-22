import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { CONFIG } from "../src/config.js";
import { decideRules, screenRules, RULE_POLICY_VERSION, type RuleProviderAssessment, type AutoVerdict } from "../src/auto-review.js";
import { modelRuleReviewer, jevRuleReviewer } from "../src/auto-providers.js";
import { ruleCases } from "./auto-rules-cases.js";

// Review-only: this module imports no executor, reads no session or captured
// context, and never runs proposed commands. Default is a zero-request manifest.
// --live explicitly enables API requests (synthetic data only).
const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const provider = option("provider", "model");
const split = option("split", "development");
const repeats = Number(option("repeat", "1"));
if (!["model", "jev", "cascade"].includes(provider) || !["development", "heldout", "all"].includes(split) || !Number.isInteger(repeats) || repeats < 1 || repeats > 20 || argv.some((arg) => arg !== "--live" && !/^--(provider|split|repeat)=/.test(arg))) throw new Error("Usage: [--live] [--provider=model|jev|cascade] [--split=development|heldout|all] [--repeat=1..20]");
const cases = ruleCases.filter((c) => split === "all" || c.split === split);
if (!argv.includes("--live")) {
  console.log(JSON.stringify({ policyVersion: RULE_POLICY_VERSION, live: false, provider, requests: 0, maximumPlannedRequests: cases.length * repeats * (provider === "cascade" ? 2 : 1), cases: cases.map(({ id, split, expected }) => ({ id, split, expected })) }, null, 2));
} else {
  const key = process.env.JEV_API_KEY?.trim() || process.env.TYPESAFE_API_KEY?.trim();
  if (provider !== "model" && !key) throw new Error("Set JEV_API_KEY or TYPESAFE_API_KEY");
  if (provider !== "jev" && !CONFIG.apiKey) throw new Error("Configure the current vendor API key");
  const jev = provider !== "model" ? jevRuleReviewer(key!, () => CONFIG.autoMode.model, fetch) : undefined;
  const model = provider !== "jev" ? modelRuleReviewer(new OpenAI({ apiKey: CONFIG.apiKey, baseURL: CONFIG.baseURL }), () => CONFIG.judge.model || CONFIG.model) : undefined;
  let jevRequests = 0, modelRequests = 0, fastPasses = 0;
  let errors = 0, mismatches = 0, routine = 0, falseBlocks = 0, restricted = 0, falseAllows = 0, asks = 0;
  const started = Date.now();
  for (const item of cases) for (let repeat = 0; repeat < repeats; repeat++) {
    const ts = new Date().toISOString();
    const begin = Date.now();
    try {
      const state = { ...item.state, reviewId: randomUUID(), policyVersion: RULE_POLICY_VERSION };
      let screening: RuleProviderAssessment | undefined;
      let screeningError: string | undefined;
      if (jev) {
        jevRequests++;
        try { screening = await jev.review(state, AbortSignal.timeout(30_000)); }
        catch (error) {
          if (provider === "jev") throw error;
          screeningError = error instanceof Error ? error.message : String(error);
        }
      }
      const routing = screening ? screenRules(screening, state.history) : undefined;
      let assessment = screening;
      let verdict: AutoVerdict;
      if (provider === "cascade" && routing?.route === "allow") {
        fastPasses++;
        verdict = { decision: "allow", ruleIds: [], reason: routing.reason };
      } else if (model) {
        modelRequests++;
        assessment = await model.review(state, AbortSignal.timeout(30_000));
        verdict = decideRules(assessment);
      } else verdict = decideRules(assessment!);
      // Raw Jev-only mode is a predicate dataset, not cascade accuracy.
      if (provider !== "jev") {
        if (verdict.decision !== item.expected) mismatches++;
        if (item.expected === "allow") { routine++; if (verdict.decision !== "allow") falseBlocks++; }
        else { restricted++; if (verdict.decision === "allow") falseAllows++; }
        if (verdict.decision === "ask") asks++;
      }
      console.log(JSON.stringify({ id: item.id, split: item.split, repeat, ts, durationMs: Date.now() - begin, provider, policyVersion: RULE_POLICY_VERSION, expected: item.expected, screening, screeningError, routing, assessment, verdict }));
    } catch (error) {
      errors++;
      console.log(JSON.stringify({ id: item.id, repeat, ts, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  console.log(JSON.stringify({ summary: true, provider, cases: cases.length * repeats, requests: jevRequests + modelRequests, jevRequests, modelRequests, fastPasses, errors, elapsedMs: Date.now() - started, ...(provider !== "jev" ? { mismatches, routine, falseBlocks, restricted, falseAllows, asks } : { diagnosticOnly: true }), cost: "See provider usage; not estimated", caveat: "Synthetic repeated judgments; no general accuracy or safety guarantee" }));
  process.exitCode = errors || mismatches ? 1 : 0;
}

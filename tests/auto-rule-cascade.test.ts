import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "../src/config.js";
import { runLoop } from "../src/loop.js";
import { registerExternalTool } from "../src/tools.js";
import { AutoMode } from "../src/auto.js";
import { screenRules, RULE_QUESTIONS, JEV_CLEAR_RULE_MAX, type RuleProbabilities, type ReviewState } from "../src/auto-review.js";
import { check, finish } from "./helpers.js";
const history = { actions: [], omittedActions: 0 };
const scores = (overrides: Record<string, number> = {}): RuleProbabilities => ({ kind: "probabilities", probabilities: { ...Object.fromEntries(Object.keys(RULE_QUESTIONS).map((key) => [key, 0.01])), ...overrides } as RuleProbabilities["probabilities"] });
const response = (assessment = scores()) => new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(assessment.probabilities).map(([id, noul]) => [id, { type: "noul", noul }])) }));
for (const id of Object.keys(RULE_QUESTIONS)) {
  check(`${id} independently sends the action to model review`, screenRules(scores({ [id]: 0.6 }), history).route === "review");
  check(`${id} at the cutoff can pass initial screening`, screenRules(scores({ [id]: JEV_CLEAR_RULE_MAX }), history).route === "allow");
  check(`${id} just above the cutoff cannot fast pass`, screenRules(scores({ [id]: JEV_CLEAR_RULE_MAX + 0.0001 }), history).route === "review");
}
for (const value of [NaN, Infinity, -1, 1.1]) check("invalid probabilities cannot fast pass", screenRules(scores({ destructive_change: value }), history).route === "review");
check("omitted action history forces model review even with clear scores", screenRules(scores(), { ...history, omittedActions: 1 }).route === "review");
let jevCalls = 0, modelCalls = 0;
let jevState: ReviewState | undefined;
let modelState: ReviewState | undefined;
let assessment = scores();
let modelOutput = '{"matches":[],"uncertainty":null}';
let modelAbort: AbortController | undefined;
const client = { chat: { completions: { create: async (params: { messages: { content: string }[] }) => {
  modelCalls++; modelState = JSON.parse(params.messages[1].content); modelAbort?.abort();
  return { choices: [{ message: { content: modelOutput } }] };
} } } };
const mode = new AutoMode(client as never, { policy: "rules", apiKey: "fixture", request: async (_url, init) => { jevCalls++; jevState = JSON.parse(String(init?.body)).state; return response(assessment); } });
const classify = (candidate = mode, signal = new AbortController().signal, notify?: (text: string) => void) => candidate.classify("generic_tool", '{"effect":"fixture"}', ["Perform the requested project task."], signal, { notify });
check("clear Jev screen allows without a model call", (await classify()).decision === "allow" && jevCalls === 1 && modelCalls === 0);
assessment = scores({ forbidden_scope: 0.3 });
check("flagged Jev result gets model review, not a human prompt", (await classify()).decision === "allow" && jevCalls === 2 && modelCalls === 1);
check("both stages receive identical evidence, with no anchoring score in model state", JSON.stringify(jevState) === JSON.stringify(modelState) && !JSON.stringify(modelState).includes("probabilities"));
check("ordinary escalation keeps Jev active for subsequent calls", mode.backend.startsWith("Jev screen"));
for (const [rule, expected] of [["destructive_change", "ask"], ["infrastructure_write", "ask"], ["security_change", "ask"], ["forbidden_scope", "deny"]] as const) {
  assessment = scores({ [rule]: 0.95 });
  modelOutput = JSON.stringify({ matches: [{ ruleId: rule, evidence: "Confirmed fixture effect" }], uncertainty: null });
  const before = modelCalls;
  check(`confirmed ${rule} remains ${expected}, with exactly one model review`, (await classify()).decision === expected && modelCalls === before + 1);
}
assessment = scores({ uncertain_effects: 0.4 });
modelOutput = '{"matches":[],"uncertainty":"Unknown script contents"}';
check("unresolved effects still ask", (await classify()).decision === "ask");
modelOutput = "{}";
check("invalid second-stage reply cannot approve", (await classify()).decision === "ask");
modelOutput = '{"matches":[],"uncertainty":null}';
for (const [status, payload, tip] of [[402, {}, "quota"], [429, {}, "rate-limited"], [503, {}, "HTTP 503"], [200, {}, "invalid response"]] as const) {
  let requests = 0;
  const tips: string[] = [];
  const candidate = new AutoMode(client as never, { policy: "rules", apiKey: "fixture", request: async () => { requests++; return new Response(JSON.stringify(payload), { status }); } });
  const before = modelCalls;
  const first = await classify(candidate, undefined, (s) => tips.push(s));
  const second = await classify(candidate, undefined, (s) => tips.push(s));
  check(`Jev ${status} falls back once and does not retry the key per action`, first.decision === "allow" && second.decision === "allow" && requests === 1 && modelCalls === before + 2 && tips.length === 1 && tips[0].includes(tip));
  check("fallback status identifies the actual model backend", !candidate.backend.startsWith("Jev"));
}
const controller = new AbortController();
const cancelled = new AutoMode(client as never, { policy: "rules", apiKey: "fixture", request: async () => { controller.abort(); return response(); } });
const before = modelCalls;
check("cancelled Jev screen cannot allow or invoke model fallback", (await classify(cancelled, controller.signal)).decision === "ask" && modelCalls === before);
modelAbort = new AbortController();
check("cancellation during second stage cannot allow", (await classify(mode, modelAbort.signal)).decision === "ask");
modelAbort = undefined;
const noKey = new AutoMode(client as never, { policy: "rules", apiKey: "" });
check("missing-key startup tip explains how to enable Jev", noKey.startupNotices().some((s) => s.includes("TYPESAFE_API_KEY")));
const missingBefore = modelCalls;
check("no key goes straight to model rules", (await classify(noKey)).decision === "allow" && modelCalls === missingBefore + 1);
// The same hard permission gate still precedes even a clear Jev screen.
let executions = 0;
registerExternalTool({ definition: { type: "function", function: { name: "mcp__fixture__screened", description: "Fixture effect", parameters: { type: "object", properties: {} } } }, run: () => { executions++; return "done"; } });
async function run() {
  let round = 0;
  const stream = { chat: { completions: { create: async () => (async function* () {
    if (round++ === 0) yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "test", function: { name: "mcp__fixture__screened", arguments: "{}" } }] } }] };
    else yield { choices: [{ delta: { content: "done" } }] };
  })() } } };
  return runLoop([], { client: stream as never, model: "fixture", quiet: true, autoMode: mode, autoRequests: ["Perform fixture effect"], signal: new AbortController().signal, isInterrupted: () => false, confirm: async () => { throw new Error("Fast pass must not prompt"); } });
}
const oldPermissions = CONFIG.permissions;
try {
  mode.enabled = true;
  assessment = scores();
  CONFIG.permissions = { allow: [], deny: ["tool:mcp__fixture__screened"] };
  const before = jevCalls;
  await run();
  check("hard deny prevents even the Jev screening request", executions === 0 && jevCalls === before);
  CONFIG.permissions.deny = [];
  await run();
  check("clear screen reaches the actual executor without human prompt", executions === 1 && jevCalls === before + 1);
} finally { CONFIG.permissions = oldPermissions; }
const cwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-cascade-log-"));
const oldDebug = process.env.MINI_AGENT_REVIEW_DEBUG;
try {
  process.chdir(dir);
  process.env.MINI_AGENT_REVIEW_DEBUG = "1";
  assessment = scores({ forbidden_scope: 0.4 });
  await classify();
  const events = fs.readFileSync(".mini-agent/review-debug.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
  check("both requests, routing and final result correlate in one trace", new Set(events.map((e) => e.id)).size === 1 && events.some((e) => e.backend === "jev" && e.event === "request") && events.some((e) => e.backend === "model" && e.event === "request") && events.some((e) => e.event === "routing" && e.route === "review") && events.some((e) => e.event === "verdict" && e.backend === "model" && e.verdict.decision === "allow"));
} finally {
  process.chdir(cwd);
  if (oldDebug === undefined) delete process.env.MINI_AGENT_REVIEW_DEBUG; else process.env.MINI_AGENT_REVIEW_DEBUG = oldDebug;
  fs.rmSync(dir, { recursive: true, force: true });
}
finish();

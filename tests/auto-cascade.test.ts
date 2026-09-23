import { AutoMode } from "../src/auto.js";
import { check, finish } from "./helpers.js";
import { CONFIG } from "../src/config.js";

// Replay the observed Jev result without making provider calls or executing the
// proposed shell command. Only the normalized review workflow is under test.
const userRequests = ["看看这个repo还有没有什么代码没提交的commit + push"];
const args = JSON.stringify({ command: "npm test 2>&1 | tail -30" });
let jevCalls = 0;
let modelCalls = 0;
let jevState: unknown;
let modelState: unknown;
const mode = new AutoMode({ chat: { completions: { create: async (request: { messages: { content: string }[] }) => {
  modelCalls++;
  modelState = JSON.parse(request.messages[1].content);
  return { choices: [{ message: { content: '{"authorized":true,"risky":false}' } }] };
} } } } as never, { apiKey: "fixture", request: async (_url, init) => {
  jevCalls++;
  jevState = JSON.parse(String(init?.body)).state;
  return new Response('{"answers":{"authorized":{"type":"noul","noul":0.56},"risky":{"type":"noul","noul":0.08}}}');
} });
const verdict = await mode.classify("run_bash_background", args, userRequests, new AbortController().signal);
check("observed 0.56/0.08 result receives one model review before asking the human", verdict.decision === "allow" && jevCalls === 1 && modelCalls === 1);
check("model rechecks the identical user request and action", JSON.stringify(jevState) === JSON.stringify(modelState));
check("review identifies the second-stage model", verdict.reason.includes("Jev") && verdict.reason.includes("model"));
check("uncertainty does not mark Jev unavailable for future actions", mode.backend.startsWith("Jev"));
await mode.classify("run_bash_background", args, userRequests, new AbortController().signal);
check("next action still starts with Jev", jevCalls === 2 && modelCalls === 2);

for (const [authorization, risk, expected, reviews] of [
  [0.5, 0, "allow", 1], [0.799, 0.2, "allow", 1],
  [0.8, 0.2, "allow", 0], [1, 0, "allow", 0],
  [0.499, 0.01, "ask", 0], [0, 0, "ask", 0],
  [0.56, 0.201, "ask", 0], [1, 1, "ask", 0],
] as const) {
  let calls = 0;
  const candidate = new AutoMode({ chat: { completions: { create: async () => {
    calls++; return { choices: [{ message: { content: '{"authorized":true,"risky":false}' } }] };
  } } } } as never, { apiKey: "fixture", request: async () => new Response(JSON.stringify({ answers: { authorized: { type: "noul", noul: authorization }, risky: { type: "noul", noul: risk } } })) });
  const result = await candidate.classify("arbitrary_tool", "{}", userRequests, new AbortController().signal);
  check(`authorization ${authorization}, risk ${risk}: ${expected}, ${reviews} second-stage reviews`, result.decision === expected && calls === reviews);
}

for (const content of ['{"authorized":false,"risky":false}', '{"authorized":true,"risky":true}', '{}', 'not JSON']) {
  let calls = 0;
  const candidate = new AutoMode({ chat: { completions: { create: async () => {
    calls++; return { choices: [{ message: { content } }] };
  } } } } as never, { apiKey: "fixture", request: async () => new Response('{"answers":{"authorized":{"type":"noul","noul":0.56},"risky":{"type":"noul","noul":0.08}}}') });
  const result = await candidate.classify("arbitrary_tool", "{}", userRequests, new AbortController().signal);
  check(`second stage cannot allow refusal, risk or invalid output: ${content}`, result.decision === "ask" && calls === 1);
}

let reviewCalls = 0;
const failing = new AutoMode({ chat: { completions: { create: async () => { reviewCalls++; throw new Error("fixture failure"); } } } } as never,
  { apiKey: "fixture", request: async () => new Response('{"answers":{"authorized":{"type":"noul","noul":0.56},"risky":{"type":"noul","noul":0.08}}}') });
const failed = await failing.classify("arbitrary_tool", "{}", userRequests, new AbortController().signal);
check("model error asks and identifies the model, without retrying for an allow", failed.decision === "ask" && failed.reason.startsWith("model judge") && reviewCalls === 1);
const controller = new AbortController();
const cancelled = new AutoMode({ chat: { completions: { create: async () => { reviewCalls++; return {}; } } } } as never,
  { apiKey: "fixture", request: async () => { controller.abort(); return new Response('{"answers":{"authorized":{"type":"noul","noul":0.56},"risky":{"type":"noul","noul":0.08}}}'); } });
check("user cancellation cannot start second-stage review", (await cancelled.classify("arbitrary_tool", "{}", userRequests, controller.signal)).decision === "ask" && reviewCalls === 1);

const previous = CONFIG.judge.model;
let selectedModel = "";
try {
  CONFIG.judge.model = "dedicated-review-model";
  const configured = new AutoMode({ chat: { completions: { create: async (params: { model: string }) => {
    selectedModel = params.model;
    return { choices: [{ message: { content: '{"authorized":true,"risky":false}' } }] };
  } } } } as never, { apiKey: "fixture", request: async () => new Response('{"answers":{"authorized":{"type":"noul","noul":0.56},"risky":{"type":"noul","noul":0.08}}}') });
  await configured.classify("arbitrary_tool", "{}", userRequests, new AbortController().signal);
  check("second stage honors judge.model at the current vendor", selectedModel === "dedicated-review-model");
} finally { CONFIG.judge.model = previous; }
finish();

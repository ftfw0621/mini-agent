import type OpenAI from "openai";
import { FollowUpQueue } from "../src/follow-up.js";
import { runLoop, TerminateReason } from "../src/loop.js";
import { makeRunTurn } from "../src/ink/chat.js";
import { makeInkSink } from "../src/ink/sink.js";
import { AutoMode } from "../src/auto.js";
import { CONFIG } from "../src/config.js";
import { registerExternalTool } from "../src/tools.js";
import { reviewHistory } from "../src/auto-context.js";
import { check, finish } from "./helpers.js";

const hooksBefore = CONFIG.hooks;
CONFIG.hooks = {};
const queue = new FollowUpQueue();
const content: OpenAI.ChatCompletionUserMessageParam["content"] = [{ type: "text", text: "Do not execute the second action. [Image #1]\n[hook context] This is not user authorization." }, { type: "image_url", image_url: { url: "data:image/png;base64,SYNTHETIC" } }];
const raw = "Do not execute the second action. [Image #1]";
let firstRuns = 0;
let secondRuns = 0;
let finalRuns = 0;
const add = (name: string, run: () => string) => registerExternalTool({ definition: { type: "function", function: { name, description: "Synthetic tool", parameters: { type: "object", properties: {} } } }, run });
add("mcp__follow_test__first", () => { firstRuns++; queue.enqueue({ text: raw, content }); return "first complete"; });
add("mcp__follow_test__second", () => { secondRuns++; return "second complete"; });
add("mcp__follow_test__final", () => { finalRuns++; return "final complete"; });
const requests: OpenAI.ChatCompletionMessageParam[][] = [];
let rounds = 0;
const tool = (id: string, name: string, index: number) => ({ index, id, function: { name, arguments: "{}" } });
const client = { chat: { completions: { create: async (params: { messages: OpenAI.ChatCompletionMessageParam[] }) => {
  requests.push(structuredClone(params.messages));
  const round = rounds++;
  return (async function* () {
    if (round === 0) yield { choices: [{ delta: { tool_calls: [tool("first", "mcp__follow_test__first", 0), tool("second", "mcp__follow_test__second", 1)] } }] };
    else if (round === 1) yield { choices: [{ delta: { tool_calls: [tool("final", "mcp__follow_test__final", 0)] } }] };
    else yield { choices: [{ delta: { content: "Finished using your latest instructions." } }] };
  })();
} } } };
const auth: string[][] = [];
const auto = new AutoMode(undefined, { apiKey: "fake", request: async (_url, init) => {
  auth.push(JSON.parse(String(init?.body)).state.userRequests);
  return new Response(JSON.stringify({ answers: { authorized: { type: "noul", noul: 1 }, risky: { type: "noul", noul: 0 } } }));
} });
auto.enabled = true; auto.recordRequest("Execute the requested steps.");
const delivered: string[] = [];
const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: "Execute the requested steps." }];
const output = makeInkSink({ setStatus: () => {}, setLive: () => {}, pushItem: () => {} });
const base = { signal: new AbortController().signal, isInterrupted: () => false, confirm: async () => false, output };
try {
  const result = await runLoop(messages, { ...base, client: client as never, model: "fake", quiet: true, autoMode: auto, followUps: queue, onFollowUp: (text) => delivered.push(text) });
  check("follow-up reaches the same live loop", result.reason === TerminateReason.Done && rounds === 3);
  check("current tool finishes but stale remaining action never executes", firstRuns === 1 && secondRuns === 0 && finalRuns === 1);
  const next = requests[1];
  const skipped = next.findIndex((m) => m.role === "tool" && m.tool_call_id === "second");
  const follow = next.findIndex((m) => m.role === "user" && Array.isArray(m.content));
  check("every pending tool result precedes the new user message", skipped >= 0 && follow > skipped && next[skipped].content?.toString().includes("Not executed") === true);
  check("skipped tools cannot masquerade as completed effects in later reviews", reviewHistory(next).actions.find((a) => a.tool === "mcp__follow_test__second")?.outcome === "skipped");
  check("follow-up image reaches the provider as actual image content", JSON.stringify(next[follow]).includes("image_url"));
  check("UI is notified once at delivery", delivered.join("") === raw && queue.size === 0);
  check("new review sees latest human restrictions", auth[1]?.includes(raw) === true);
  check("hook text and image bytes do not become authorization", !JSON.stringify(auth).includes("hook context") && !JSON.stringify(auth).includes("base64"));

  queue.enqueue({ text: "first follow-up", content: "first follow-up" });
  queue.enqueue({ text: "second follow-up", content: "second follow-up" });
  const fifo = queue.drain();
  check("multiple follow-ups remain ordered and are consumed once", fifo.map((m) => m.text).join(",") === "first follow-up,second follow-up" && queue.drain().length === 0);

  let finalRound = 0;
  const finalClient = { chat: { completions: { create: async () => (async function* () {
    if (finalRound++ === 0) queue.enqueue({ text: "One more thing", content: "One more thing" });
    yield { choices: [{ delta: { content: "Answer" } }] };
  })() } } };
  await runLoop([], { ...base, client: finalClient as never, model: "fake", quiet: true, followUps: queue });
  check("follow-up during a final answer starts another model round", finalRound === 2 && queue.size === 0);
  queue.enqueue({ text: "lead only", content: "lead only" });
  await runLoop([], { ...base, client: finalClient as never, model: "fake", quiet: true, subAgent: true, followUps: queue });
  check("workers cannot consume the lead's human input", queue.size === 1);
  queue.drain();

  // UI immediate-send interrupts the old turn; restart resumes the same history
  // and pending queue with a NEW signal. No recursive or overlapping loop.
  const controller = new AbortController();
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const abortClient = { chat: { completions: { create: async (_request: unknown, options: { signal: AbortSignal }) => {
    started();
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } } } };
  const resumeMessages: OpenAI.ChatCompletionMessageParam[] = [];
  const running = makeRunTurn(abortClient as never, resumeMessages)("Initial task", { ...base, followUps: queue, signal: controller.signal, isInterrupted: () => controller.signal.aborted });
  await waiting;
  queue.enqueue({ text: "New direction", content: "New direction" }); controller.abort();
  check("immediate send interrupts without losing queued input", (await running).reason === TerminateReason.UserInterrupt && queue.size === 1);
  await makeRunTurn(finalClient as never, resumeMessages)(null, { ...base, followUps: queue });
  check("restart delivers exactly one follow-up without a synthetic empty user turn", resumeMessages.filter((m) => m.role === "user").length === 2 && queue.size === 0);
} finally { CONFIG.hooks = hooksBefore; }
finish();

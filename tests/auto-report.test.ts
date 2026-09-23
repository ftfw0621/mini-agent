import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.js";

// Telemetry resolves its file from the cwd at import time, so move into a temp
// directory BEFORE importing anything that pulls it in — this test must never
// append fixture events to the project's real .mini-agent/telemetry.jsonl.
const cwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-report-"));
process.chdir(dir);
try {
  const { initTelemetry } = await import("../src/telemetry.js");
  const { AutoMode } = await import("../src/auto.js");
  const { runLoop } = await import("../src/loop.js");
  const { registerExternalTool } = await import("../src/tools.js");
  const { RULE_QUESTIONS } = await import("../src/auto-review.js");
  const { summarize, render } = await import("../eval/auto-report.js");
  initTelemetry("fixture-session");
  const events = () => fs.readFileSync(".mini-agent/telemetry.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));

  // Scores policy: Jev says unauthorized and risky → ask, with no second stage.
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"authorized":false,"risky":true}' } }] }) } } };
  const mode = new AutoMode(client as never, { apiKey: "fixture", request: async () => new Response('{"answers":{"authorized":{"type":"noul","noul":0.1},"risky":{"type":"noul","noul":0.9}}}') });
  mode.enabled = true;
  const verdict = await mode.classify("fixture_tool", "{}", ["Do the task."], new AbortController().signal);
  const first = events().find((e) => e.event === "agent_auto_verdict");
  check("scores verdict carries a reviewId shared with its telemetry event", !!verdict.reviewId && first?.reviewId === verdict.reviewId && first.outcome === "reviewed");
  check("verdict event records the sizes behind both cliffs", first?.stateBytes > 0 && first.omittedActions === 0 && typeof first.requestBytes === "number" && typeof first.durationMs === "number");

  const huge = await mode.classify("fixture_tool", "{}", ["x".repeat(30_000)], new AbortController().signal);
  const cliff = events().filter((e) => e.event === "agent_auto_verdict").at(-1);
  check("oversized state is recorded as a precondition ask with its size", huge.decision === "ask" && cliff?.outcome === "precondition" && cliff.stateBytes > 24_000 && cliff.requestBytes > 24_000);

  // The human's answer joins the review that asked.
  registerExternalTool({ definition: { type: "function", function: { name: "mcp__fixture__act", description: "Fixture effect", parameters: { type: "object", properties: {} } } }, run: () => "done" });
  const run = (answer: boolean, canPrompt = true) => {
    let round = 0;
    const stream = { chat: { completions: { create: async () => (async function* () {
      if (round++ === 0) yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "mcp__fixture__act", arguments: "{}" } }] } }] };
      else yield { choices: [{ delta: { content: "done" } }] };
    })() } } };
    return runLoop([], { client: stream as never, model: "fixture", quiet: true, autoMode: mode, autoRequests: ["Do the task."], canPrompt, signal: new AbortController().signal, isInterrupted: () => false, confirm: async () => answer });
  };
  await run(true);
  await run(false);
  await run(false, false);
  // A write outside any work tree or temp dir needs a human with no reviewer:
  // it must still be counted as an interruption, labeled by its source.
  const homeTarget = path.join(os.homedir(), "mini-agent-report-test-never-written.txt");
  {
    let round = 0;
    const stream = { chat: { completions: { create: async () => (async function* () {
      if (round++ === 0) yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "w", function: { name: "write_file", arguments: JSON.stringify({ path: homeTarget, content: "no" }) } }] } }] };
      else yield { choices: [{ delta: { content: "done" } }] };
    })() } } };
    await runLoop([], { client: stream as never, model: "fixture", quiet: true, autoMode: mode, autoRequests: ["Do the task."], signal: new AbortController().signal, isInterrupted: () => false, confirm: async () => false });
  }
  const all = events().filter((e) => e.source !== "requires_human");
  const outsidePrompt = events().filter((e) => e.event === "agent_auto_human" && e.source === "requires_human");
  check("a requires-human prompt is counted with its source, without a reviewId", outsidePrompt.length === 1 && outsidePrompt[0].reviewId === undefined && !fs.existsSync(homeTarget));
  const humans = all.filter((e) => e.event === "agent_auto_human");
  const reviewIds = new Set(all.filter((e) => e.event === "agent_auto_verdict").map((e) => e.reviewId));
  check("approve, decline and unattended block are each recorded once", humans.map((e) => e.decision).join(",") === "approved,declined,unattended");
  check("every human answer joins a verdict by reviewId", humans.every((e) => reviewIds.has(e.reviewId)));
  check("declined tool event carries the reviewId too", all.some((e) => e.event === "agent_tool_declined" && e.reviewId === humans[1].reviewId));

  // Rules policy: a truncated history is labeled as the route that lost the fast pass.
  const clear = JSON.stringify({ answers: Object.fromEntries(Object.keys(RULE_QUESTIONS).map((id) => [id, { type: "noul", noul: 0.01 }])) });
  const rules = new AutoMode({ chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"matches":[],"uncertainty":null}' } }] }) } } } as never, { policy: "rules", apiKey: "fixture", request: async () => new Response(clear) });
  const signal = new AbortController().signal;
  await rules.classify("fixture_tool", "{}", ["Do the task."], signal);
  const truncated = await rules.classify("fixture_tool", "{}", ["Do the task."], signal, { history: { actions: [], omittedActions: 4 } });
  const routes = events().filter((e) => e.event === "agent_auto_verdict" && e.policy === "rules").map((e) => e.route);
  check("rules routes distinguish fast pass from the history cliff", truncated.decision === "allow" && routes.join(",") === "jev_allow,history_truncated");

  const report = summarize(events().filter((e) => e.source !== "requires_human")); // counts below cover the review path only
  check("report splits prompts by source", summarize(events()).humanSources.some(([source, n]) => source === "requires_human" && n === 1));
  check("report counts both cliffs", report.cliffs.stateTooLarge === 1 && report.cliffs.historyTruncated === 1);
  check("report joins human answers", report.humans.approved === 1 && report.humans.declined === 1 && report.humans.unattended === 1 && report.unanswered === 2); // the two direct classify() asks never reached a human
  check("report renders interruption rate and confidence interval", /per 100 tool calls/.test(render(report)) && /95% CI/.test(render(report)));
  check("report tallies fast-path skips by reason", summarize([{ ts: "t", session: "s", event: "agent_auto_skipped", tool: "run_bash", reason: "read-only command" }]).skipped[0]?.[1] === 1);
  check("older events without reviewId still count, but not in cliffs", summarize([{ ts: "t", session: "s", event: "agent_auto_verdict", verdict: "ask", tool: "x" }]).instrumented === 0);
} finally {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
}
finish();

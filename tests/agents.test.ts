import { AgentProgress } from "../src/agent-progress.js";
import { moveAgentFocus } from "../src/ink/agents.js";
import { runLoop, listSubAgents, listAgentViews } from "../src/loop.js";
import { registerTeammate, setTeammateState, finishTeammate, resetTeam } from "../src/team.js";
import { check, finish } from "./helpers.js";

const progress = new AgentProgress("worker-model");
progress.liveTokens = 25;
check("streaming token count is explicitly estimated", progress.view("a", "reader", "Read files", "running").estimated);
progress.finishModelCall(19);
check("provider usage replaces the stream estimate without double counting", progress.view("a", "reader", "Read files", "running").tokens === 19 && !progress.view("a", "reader", "Read files", "running").estimated);
progress.liveTokens = 10;
progress.finishModelCall();
check("providers without usage keep a labeled estimate", progress.view("a", "reader", "Read files", "running").tokens === 29 && progress.view("a", "reader", "Read files", "running").estimated);
progress.append("old" + "x".repeat(40_000) + "recent activity");
check("worker transcript is bounded and omission is visible", progress.view("a", "reader", "", "running").transcript.startsWith("… (earlier activity omitted)") && progress.transcript.endsWith("recent activity") && progress.transcript.length <= 32_000);
progress.finish();
const elapsed = progress.view("a", "reader", "", "done").elapsedMs;
await new Promise((resolve) => setTimeout(resolve, 20));
check("completed worker elapsed time stops increasing", progress.view("a", "reader", "", "done").elapsedMs === elapsed);
const ids = ["main", "sa_1", "team:reader"];
check("down enters the main row", moveAgentFocus(ids, null, 1) === "main");
check("down switches between workers", moveAgentFocus(ids, "sa_1", 1) === "team:reader");
check("up from main returns keyboard focus to input", moveAgentFocus(ids, "main", -1) === null);
check("selection does not wrap past the last worker", moveAgentFocus(ids, "team:reader", 1) === "team:reader");

registerTeammate("reader", "Read tools", Promise.resolve(), progress);
setTeammateState("reader", "idle");
check("teammate idle status is distinct from completion", listAgentViews().find((a) => a.id === "team:reader")?.status === "idle");
finishTeammate("reader", false);
check("teammate failures are exposed to the same agent list", listAgentViews().find((a) => a.id === "team:reader")?.status === "failed");
resetTeam();

// Real asynchronous task delegation: the UI sees the worker before it finishes,
// then receives its separate transcript and provider-reported output tokens.
let release: () => void = () => {};
const gate = new Promise<void>((resolve) => { release = resolve; });
let mainCalls = 0;
const client = { chat: { completions: { create: async (params: { model: string }) => (async function* () {
  if (params.model === "worker") {
    yield { choices: [{ delta: { content: "Worker is inspecting. " } }] };
    await gate;
    yield { choices: [{ delta: { content: "Worker findings." } }] };
    yield { choices: [], usage: { prompt_tokens: 123, completion_tokens: 37 } };
  } else if (mainCalls++ === 0) {
    yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "delegate", function: { name: "task", arguments: '{"description":"Inspect the tools"}' } }] } }] };
  } else yield { choices: [{ delta: { content: "Parent can continue." } }] };
})() } } };
await runLoop([{ role: "user", content: "Inspect tools" }], {
  client: client as never, model: "main", subAgentModel: "worker", quiet: true,
  signal: new AbortController().signal, isInterrupted: () => false, confirm: async () => false,
});
await new Promise((resolve) => setTimeout(resolve, 10));
const running = listSubAgents().at(-1)!;
check("active subagent exposes live output and its own model", running.status === "running" && running.model === "worker" && running.transcript.includes("Worker is inspecting"));
release();
for (let i = 0; i < 50 && listSubAgents().at(-1)?.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
const done = listSubAgents().at(-1)!;
check("completed subagent retains its report and exact tokens", done.status === "done" && done.tokens === 37 && !done.estimated && done.transcript.includes("Worker findings"));
finish();

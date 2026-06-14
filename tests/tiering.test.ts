import { runLoop, subAgentModelFor } from "../src/loop.js"; // the resolver + an end-to-end run
import { check, finish } from "./helpers.js"; // assertions

// ---- the resolver: pure tiering rule ----------------------------------------------------
check("uses the sub-agent model when set", subAgentModelFor({ model: "big", subAgentModel: "small" }) === "small");
check("falls back to the main model when unset", subAgentModelFor({ model: "big" }) === "big");
check("blank sub-agent model falls back too", subAgentModelFor({ model: "big", subAgentModel: "  " }) === "big");

// ---- end to end: a delegated sub-agent actually runs on the other tier -------------------
// A fake OpenAI client that records the `model` of every call and replays a
// scripted stream. Script: (1) main agent calls the task tool, (2) the sub-agent
// answers with plain text, (3) the main agent answers with plain text.
function streamOf(chunks: unknown[]) {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}
const toolCallChunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "task", arguments: '{"description":"explore the repo"}' } }] } }] };
const textChunk = (s: string) => ({ choices: [{ delta: { content: s } }] });

const script = [[toolCallChunk], [textChunk("sub-agent finished")], [textChunk("all done")]];
const seenModels: string[] = [];
let callIndex = 0;
const fakeClient = {
  chat: {
    completions: {
      create: async (params: { model: string }) => {
        seenModels.push(params.model); // the thing under test: which tier each call used
        return streamOf(script[Math.min(callIndex++, script.length - 1)]);
      },
    },
  },
};

const messages = [
  { role: "system" as const, content: "you are a test agent" },
  { role: "user" as const, content: "do the task" },
];
const result = await runLoop(messages, {
  client: fakeClient as never,
  model: "main-model",
  subAgentModel: "sub-model",
  signal: new AbortController().signal,
  isInterrupted: () => false,
  confirm: async () => true,
  quiet: true,
});

check("the run finished cleanly", result.reason === "done" || result.finalText === "all done");
check("three model calls were made", seenModels.length === 3);
check("the orchestrator used the main model", seenModels[0] === "main-model");
check("the delegated sub-agent used the sub-agent model", seenModels[1] === "sub-model");
check("control returns to the main model after delegation", seenModels[2] === "main-model");

finish();

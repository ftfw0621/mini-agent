import type OpenAI from "openai";
import { AutoMode } from "../src/auto.js";
import { CONFIG } from "../src/config.js";
import { runLoop } from "../src/loop.js";
import { registerExternalTool } from "../src/tools.js";
import { check, finish } from "./helpers.js";

// Real loop: a submitted human form answer must reach the next reviewer call,
// including when ask_user and the action arrive in the same model response.
const tool = "mcp__clarification_test__action";
registerExternalTool({ definition: { type: "function", function: { name: tool, description: "Synthetic test action", parameters: { type: "object", properties: {} } } }, run: () => "done" });
const hooks = CONFIG.hooks;
CONFIG.hooks = {};
const question = "The matched recipient is your own account, ID U_EXAMPLE. Send the test message there?";
const options = ["Yes, send there", "No, do not send"];
const call = (id: string, name: string, args: object, index: number) => ({ id, index, function: { name, arguments: JSON.stringify(args) } });
try {
  for (const [label, answer, sameRound] of [
    ["confirmation", options[0], false], ["same-round confirmation", options[0], true],
    ["restriction", options[1], false], ["cancel", null, false],
  ] as const) {
    let round = 0;
    let userRequests: string[] = [];
    const mode = new AutoMode(undefined, { apiKey: "fake", request: async (_url, init) => {
      userRequests = JSON.parse(String(init?.body)).state.userRequests;
      return new Response(JSON.stringify({ answers: { authorized: { type: "noul", noul: 0 }, risky: { type: "noul", noul: 0 } } }));
    } });
    mode.enabled = true;
    mode.recordRequest("Send a test message to Example Person.");
    const priorSnapshot = mode.snapshot();
    const client = { chat: { completions: { create: async () => {
      const current = round++;
      return (async function* () {
        if (current === 0) yield { choices: [{ delta: { tool_calls: [call("ask", "ask_user", { questions: [{ question, options }] }, 0), ...(sameRound ? [call("act", tool, {}, 1)] : [])] } }] };
        else if (current === 1 && !sameRound) yield { choices: [{ delta: { tool_calls: [call("act", tool, {}, 0)] } }] };
        else yield { choices: [{ delta: { content: "Done" } }] };
      })();
    } } } };
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: "Send a test message to Example Person." }];
    await runLoop(messages, { client: client as never, model: "fake", signal: new AbortController().signal,
      isInterrupted: () => false, confirm: async () => false, quiet: true, autoMode: mode,
      askUser: async () => answer === null ? null : [{ question, answer }],
    });
    check(`${label} reaches review with correct provenance`, answer === null ? userRequests.length === 1 : userRequests.length === 2 && userRequests[1].includes(question) && userRequests[1].includes(answer) && !userRequests[1].includes(options.find((v) => v !== answer)!));
    check(`${label} persists without changing old worker snapshots`, mode.snapshot().length === (answer === null ? 1 : 2) && priorSnapshot.length === 1);
  }
} finally { CONFIG.hooks = hooks; }
finish();

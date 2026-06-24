import { runLoop } from "../src/loop.js"; // exercise the streaming path end to end
import { spinnerText } from "../src/ui.js"; // the model tag in the spinner
import { recordReasoning, revealReasoning, clearReasoning } from "../src/tui.js"; // the collapsed-thinking store (Ctrl+R)
import { check, checkContains, finish } from "./helpers.js"; // assertions

// ---- spinner shows the active model (so a /model switch is visible) --------------------
checkContains("spinner tags the top-level call with the model", spinnerText("Thinking", 2, false, "deepseek-reasoner"), "deepseek-reasoner");
check("spinner omits the model tag for sub-agents", !spinnerText("Thinking", 2, true, "deepseek-reasoner").includes("deepseek-reasoner"));
check("spinner without a model still works", spinnerText("Thinking", 0, false).includes("Thinking"));

// ---- reasoning_content is rendered but NOT kept in history -----------------------------
// A fake client that streams a reasoning model's response: some thinking in
// `reasoning_content`, then the actual answer in `content`.
function streamOf(chunks: unknown[]) {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}
const fakeClient = {
  chat: {
    completions: {
      create: async () =>
        streamOf([
          { choices: [{ delta: { reasoning_content: "let me think step by step..." } }] },
          { choices: [{ delta: { content: "The answer is 42." } }] },
        ]),
    },
  },
};

const messages = [
  { role: "system" as const, content: "test" },
  { role: "user" as const, content: "what is the answer?" },
];
const result = await runLoop(messages, {
  client: fakeClient as never,
  model: "deepseek-reasoner",
  signal: new AbortController().signal,
  isInterrupted: () => false,
  confirm: async () => true,
  quiet: true, // no screen output in the test; we check the kept content
});

check("the run finished", result.reason === "done");
check("the answer is kept as the final text", result.finalText === "The answer is 42.");
check("the reasoning trace is NOT in the kept content", !(result.finalText ?? "").includes("step by step"));
// and the assistant message in history holds the answer only, not the thinking
const history = messages as unknown as Array<{ role: string; content?: unknown }>;
const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
const assistantText = String(lastAssistant?.content ?? "");
checkContains("history keeps the answer", assistantText, "42");
check("history does not keep the reasoning", !assistantText.includes("step by step"));

// ---- the collapsed-reasoning store behind Ctrl+R --------------------------------------
// Call revealReasoning with stdout captured so its print doesn't pollute the test
// output; return both the boolean and what it would have printed.
function reveal(): { shown: boolean; out: string } {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  try {
    return { shown: revealReasoning(), out };
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
}

clearReasoning();
const empty = reveal();
check("revealReasoning returns false when there's nothing stored", empty.shown === false && empty.out === "");

recordReasoning("first I consider X");
recordReasoning("then I weigh Y"); // a second round of thinking in the same turn
const got = reveal();
check("revealReasoning returns true once thinking is stored", got.shown === true);
checkContains("revealed output includes the first round", got.out, "consider X");
checkContains("revealed output includes the second round", got.out, "weigh Y");

recordReasoning("   "); // whitespace-only is ignored, never stored
clearReasoning();
check("clearReasoning empties the store (next turn starts fresh)", reveal().shown === false);

finish();

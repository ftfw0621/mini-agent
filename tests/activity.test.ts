import { makeInkSink, type Item } from "../src/ink/sink.js";
import { summarizeActivity, detailPage } from "../src/ink/activity.js";
import { clearToolCalls, getToolCalls, getToolActivity, getToolCallCount, recordToolCall, recordToolResult, clearReasoning, getReasoning } from "../src/tui.js";
import { runLoop } from "../src/loop.js";
import { CONFIG } from "../src/config.js";
import { registerExternalTool } from "../src/tools.js";
import { displayWidth } from "../src/editor.js";
import { check, finish } from "./helpers.js";

const items: Item[] = [];
let status: string | null = null;
let live: string | null = null;
const output = makeInkSink({ setStatus: (s) => { status = s; }, setLive: (s) => { live = s; }, pushItem: (item) => items.push(item) });
const first = output.spinner("first read");
const second = output.spinner("second read");
first.stop();
check("finishing a parallel tool cannot hide another tool's animation", status === "second read" && second.spinning);
first.set("stale update");
check("stopped handles cannot revive stale activity", status === "second read");
const third = output.spinner("permission review");
third.stop();
check("nested review restores the underlying tool status", status === "second read");
second.stop();
check("last handle clears the animation", status === null);
for (let n = 0; n < 100; n++) output.reasoning("thought for 2s");
check("100 reasoning rounds add no permanent rows", items.length === 0);
const answer = output.answer();
answer.push("A streamed ");
answer.push("summary.");
answer.end();
await new Promise((resolve) => setTimeout(resolve, 110));
check("answer commits once and its delayed live repaint is cancelled", items.length === 1 && items[0].text === "A streamed summary." && live === null);

clearToolCalls();
for (let n = 0; n < 150; n++) {
  const call = recordToolCall(`poll ${n}`, `args: {task_id: bg_1, poll: ${n}}`, { id: String(n), name: "bash_output", args: '{"task_id":"bg_1"}' });
  recordToolResult(call, `[bg_1] running\noutput ${n}`);
}
const groups = summarizeActivity(getToolActivity());
check("repeated polling is one card instead of 150 rows", groups.length === 1 && groups[0].title === "Check background task (bg_1)");
check("total count survives bounded detail retention", getToolCallCount() === 150 && getToolActivity().length === 100);
check("details say when older calls were dropped", getToolCalls()!.includes("showing latest 100"));
check("Ctrl+T includes both arguments and output", getToolCalls()!.includes("poll: 149") && getToolCalls()!.includes("output 149"));
const search = recordToolCall("search", "args", { id: "search", name: "search", args: '{"pattern":"TODO"}' });
recordToolResult(search, "a.ts:1: TODO\nb.ts:2: TODO");
check("search card summarizes actual matches", summarizeActivity(getToolActivity()).at(-1)?.detail.includes("Found 2 matches") === true);
const error = recordToolCall("run", "args", { id: "run", name: "run_bash", args: '{"command":"npm test"}' });
recordToolResult(error, "[error] Command exited with code 1.");
check("failed tools keep a visible failure summary", summarizeActivity(getToolActivity()).at(-1)?.failed === true);
check("only two recent groups occupy the default viewport", summarizeActivity(getToolActivity()).length === 2);
const active = recordToolCall("read", "args", { id: "read", name: "read_file", args: '{"path":"README.md"}' });
check("unfinished calls remain marked in progress", summarizeActivity(getToolActivity()).at(-1)?.running === true);
recordToolResult(active, "x".repeat(40_000));
check("oversized details are capped with an explicit marker", getToolCalls()!.includes("display truncated") && getToolActivity().at(-1)!.result!.length < 33_000);
const page = detailPage("中文".repeat(100), 0, 5, 20);
check("detail viewport bounds physical rows including CJK", page.text.split("\n").length <= 5 && page.text.split("\n").every((line) => displayWidth(line) <= 20));
check("older detail pages are reachable and clamped", detailPage("1\n2\n3\n4", 999, 2, 20).text === "1\n2");
check("terminal controls in results cannot escape the details panel", !detailPage("safe\x1b[2J\x1b]0;bad\x07\rtext", 0, 5, 20).text.includes("\x1b"));

// Exercise the real loop: multiple rounds and a delayed tool must stay out of
// scrollback, but leave a trace and animate during BOTH model and tool work.
clearToolCalls();
clearReasoning();
items.length = 0;
let rounds = 0;
let toolAnimated = false;
let argumentsAnimated = false;
let answerAnimated = false;
const allowedBefore = [...CONFIG.permissions.allow];
CONFIG.permissions.allow.push("tool:activity_test");
registerExternalTool({
  definition: { type: "function", function: { name: "activity_test", description: "Offline UI test", parameters: { type: "object", properties: {} } } },
  run: async () => { toolAnimated = status?.includes("activity_test") ?? false; return "test result"; },
});
const client = { chat: { completions: { create: async () => (async function* () {
  rounds++;
  yield { choices: [{ delta: { reasoning_content: `thinking ${rounds}` } }] };
  if (rounds <= 8) {
    yield { choices: [{ delta: { tool_calls: [{ index: 0, id: `test_${rounds}`, function: { name: "activity_test", arguments: "{" } }] } }] };
    argumentsAnimated = status !== null;
    yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] };
  } else {
    yield { choices: [{ delta: { content: "All done." } }] };
    answerAnimated = status !== null;
  }
})() } } };
try {
  const result = await runLoop([{ role: "user", content: "Exercise the UI" }], {
    client: client as never, model: "fake", output, signal: new AbortController().signal,
    isInterrupted: () => false, confirm: async () => false,
  });
  check("real multi-round loop commits only the final summary", result.finalText === "All done." && items.length === 1 && items[0].kind === "answer");
  check("tool-argument streaming, execution and answer streaming all animate", argumentsAnimated && toolAnimated && answerAnimated);
  check("loop clears status when finished", status === null);
  check("hidden tool results and all reasoning remain inspectable", getToolCallCount() === 8 && getToolCalls()!.includes("test result") && getReasoning()!.includes("thinking 9"));
  const interrupted = new AbortController();
  const brokenStream = { chat: { completions: { create: async () => (async function* () {
    yield { choices: [{ delta: { content: "Partial answer" } }] };
    interrupted.abort();
    throw new Error("interrupted stream");
  })() } } };
  const cancelled = await runLoop([{ role: "user", content: "test interruption" }], {
    client: brokenStream as never, model: "fake", output, signal: interrupted.signal,
    isInterrupted: () => interrupted.signal.aborted, confirm: async () => false,
  });
  await new Promise((resolve) => setTimeout(resolve, 110));
  check("interrupted streaming cannot revive a stale live preview", cancelled.reason === "user_interrupt" && live === null && status === null && items.at(-1)?.text === "Partial answer");
} finally {
  CONFIG.permissions.allow = allowedBefore;
  clearToolCalls();
  clearReasoning();
}
finish();

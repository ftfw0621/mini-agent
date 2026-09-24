import fs from "node:fs"; // fixture files
import os from "node:os"; // temp directory
import path from "node:path"; // path joining
import type OpenAI from "openai"; // message shapes
import { estimateTokens, estimateHistoryTokens, recoverFileState, contextWindowFor, compactThreshold, recordContextUsage, contextTokens, contextPercent, estimateToolTokens } from "../src/context.js"; // units under test
import { CONFIG } from "../src/config.js"; // windows per model
import { runLoop, TerminateReason } from "../src/loop.js"; // proactive compaction end to end
import { dispatch, forgetFilesExcept } from "../src/tools.js"; // to drive the file read-state
import { check, checkContains, finish } from "./helpers.js"; // assertions

// ---- token estimation -----------------------------------------------------------
check("4 ascii chars ≈ 1 token", estimateTokens("abcd") === 1, String(estimateTokens("abcd")));
check("dense halves the divisor", estimateTokens("abcdabcd", true) === 4, String(estimateTokens("abcdabcd", true)));
check("rounds up", estimateTokens("abcde") === 2, String(estimateTokens("abcde")));
check("counts bytes not chars (CJK)", estimateTokens("好") === 1 && estimateTokens("好好好好") === 3, String(estimateTokens("好好好好")));
const hist = [
  { role: "user" as const, content: "abcd".repeat(10) }, // 40 chars prose → 10 tokens + 8 overhead
  { role: "tool" as const, tool_call_id: "x", content: "abcd".repeat(10) }, // 40 chars dense → 20 + 8
];
check("history estimate sums with overhead", estimateHistoryTokens(hist) === 10 + 8 + 20 + 8, String(estimateHistoryTokens(hist)));

// ---- post-compaction file recovery ------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-test-ctx-")); // fresh sandbox
const f1 = path.join(dir, "first.txt"); // oldest read
const f2 = path.join(dir, "second.txt"); // middle read
const f3 = path.join(dir, "huge.txt"); // newest read, bigger than the per-file cap
fs.writeFileSync(f1, "FIRST ".repeat(10));
fs.writeFileSync(f2, "SECOND ".repeat(10));
fs.writeFileSync(f3, "X".repeat(20000)); // larger than the 16000-char total budget

forgetFilesExcept([]); // start with a clean read-state (other suites may have run)
await dispatch("read_file", JSON.stringify({ path: f1 })); // touch order: f1 → f2 → f3
await dispatch("read_file", JSON.stringify({ path: f2 }));
await dispatch("read_file", JSON.stringify({ path: f3 }));

const note = recoverFileState(); // what compaction would re-attach
check("recovery returns a note", note !== null);
check("newest file recovered first", note!.indexOf(f3) < note!.indexOf(f1), "f3 should appear before f1");
// The huge file is one unbroken run of X's; the cap shows up as the longest
// such run. (Counting all X's would also catch stray X's in the random temp
// path — a real flake we hit while writing this.)
const longestXRun = Math.max(0, ...(note!.match(/X+/g) || []).map((s) => s.length));
check("huge file capped at 4000", longestXRun <= 4000, String(longestXRun));
check("all three fit within budget", note!.includes(f1) && note!.includes(f2) && note!.includes(f3));

// ---- eviction: not recovered = must re-read before editing ---------------------------
const f4 = path.join(dir, "evicted.txt");
fs.writeFileSync(f4, "EVICT ".repeat(5));
await dispatch("read_file", JSON.stringify({ path: f4 })); // mark as read...
forgetFilesExcept([]); // ...then evict everything (simulating a recovery that dropped it)
checkContains("evicted file requires re-read before edit", await dispatch("edit_file", JSON.stringify({ path: f4, old_string: "EVICT", new_string: "KEPT" })), "have not read");
await dispatch("read_file", JSON.stringify({ path: f4 })); // re-reading unlocks it again
checkContains("re-read unlocks editing", await dispatch("edit_file", JSON.stringify({ path: f4, old_string: "EVICT ".repeat(5), new_string: "KEPT" })), "1 replacement");

// ---- window per model + the compaction threshold --------------------------------------
{
  const before = { window: CONFIG.contextWindow, windows: CONFIG.contextWindows, hooks: CONFIG.hooks };
  delete process.env.MINI_AGENT_COMPACT_AT;
  delete process.env.MINI_AGENT_CONTEXT_WINDOW;
  CONFIG.contextWindow = 1_000_000;
  CONFIG.contextWindows = { small: 128_000, tiny: 32_000 };
  check("window falls back to the global setting", contextWindowFor("big") === 1_000_000);
  check("per-model window wins for that model", contextWindowFor("small") === 128_000);
  check("threshold = window − 20k output − 13k buffer", compactThreshold("big") === 1_000_000 - 33_000);
  check("same reservation on a smaller window", compactThreshold("small") === 128_000 - 33_000);
  check("a tiny window still gets a sane floor", compactThreshold("tiny") === Math.floor(32_000 * 0.6));
  process.env.MINI_AGENT_COMPACT_AT = "500";
  check("env override still wins (tests rely on it)", compactThreshold("big") === 500);
  delete process.env.MINI_AGENT_COMPACT_AT;

  // ---- real usage anchors the count; only the tail is estimated ------------------------
  const msgs: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: "sys" }, { role: "user", content: "hello" }];
  check("no measurement yet → full estimate incl. tool manuals", contextTokens(msgs) === estimateHistoryTokens(msgs) + estimateToolTokens());
  recordContextUsage(msgs, 2, { prompt_tokens: 50_000 });
  check("right after a call: exactly the reported prompt_tokens", contextTokens(msgs) === 50_000);
  msgs.push({ role: "assistant", content: "abcd".repeat(10) });
  check("later messages are added as an estimate", contextTokens(msgs) === 50_000 + 18);
  msgs.length = 0; msgs.push({ role: "system", content: "sys" }, { role: "user", content: "summary" }); // compaction rewrote the array
  check("a rewritten history drops the stale measurement", contextTokens(msgs) === estimateHistoryTokens(msgs) + estimateToolTokens());
  recordContextUsage(msgs, 2, { prompt_tokens: 967_000 * 2 });
  check("status percent is relative to auto-compaction and capped", contextPercent(msgs, "big") === 100);

  // ---- end to end: a big reported prompt → the NEXT call compacts first ----------------
  CONFIG.hooks = {};
  const calls: string[] = [];
  let streamRound = 0;
  const client = { chat: { completions: { create: async (params: { stream?: boolean; messages: OpenAI.ChatCompletionMessageParam[] }) => {
    if (!params.stream) { calls.push("compact"); return { choices: [{ message: { content: "1. summary of the work so far" } }] }; } // compactHistory's call
    const r = streamRound++;
    calls.push(`model:${params.messages.length}`);
    return (async function* () {
      if (r === 0) {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "nope", arguments: "{}" } }] } }] };
        yield { choices: [], usage: { prompt_tokens: 980_000, completion_tokens: 10 } }; // near the 1M window
      } else yield { choices: [{ delta: { content: "done" } }] };
    })();
  } } } };
  const history: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: "sys" }, { role: "user", content: "big task" }];
  const result = await runLoop(history, { client: client as never, model: "big", quiet: true, signal: new AbortController().signal, isInterrupted: () => false, confirm: async () => true });
  check("loop finishes", result.reason === TerminateReason.Done);
  check("real usage above the threshold compacts before the next call", calls[0].startsWith("model:") && calls[1] === "compact" && calls[2]?.startsWith("model:"), calls.join(","));
  check("history after compaction is the summary", history.some((m) => m.role === "user" && String(m.content).includes("summary of the work so far")));

  CONFIG.contextWindow = before.window;
  CONFIG.contextWindows = before.windows;
  CONFIG.hooks = before.hooks;
}

finish();

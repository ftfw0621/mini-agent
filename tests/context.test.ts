import fs from "node:fs"; // fixture files
import os from "node:os"; // temp directory
import path from "node:path"; // path joining
import { estimateTokens, estimateHistoryTokens, recoverFileState } from "../src/context.js"; // units under test
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

finish();

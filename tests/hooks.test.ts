import { runHooks, type HookEvent } from "../src/hooks.js"; // the unit under test
import { CONFIG } from "../src/config.js"; // mutated to inject hooks (the test seam)
import { check, finish } from "./helpers.js"; // assertions

// Helper: set the hooks for one event, run them, return the outcome.
async function withHooks(event: HookEvent, defs: { match?: string; command: string; timeoutMs?: number }[], payload: Record<string, unknown> = {}) {
  CONFIG.hooks[event] = defs; // inject
  const out = await runHooks(event, payload); // run
  CONFIG.hooks[event] = []; // clean up for the next case
  return out;
}

// ---- no hooks registered = the common, fast path -------------------------------------
const none = await runHooks("PreToolUse", { tool: "run_bash" });
check("no hooks → no block, no output", !none.block && !none.feedback && !none.stdout);

// ---- exit 0 passes; stdout is captured ----------------------------------------------------
const pass = await withHooks("SessionStart", [{ command: "echo on-call: alice" }]);
check("exit 0 does not block", !pass.block);
check("exit 0 stdout captured", pass.stdout.includes("on-call: alice"), pass.stdout);

// ---- exit 2 blocks; stderr becomes the feedback --------------------------------------------
const blocked = await withHooks("PreToolUse", [{ command: "echo nope 1>&2; exit 2" }], { tool: "run_bash" });
check("exit 2 blocks", blocked.block);
check("exit 2 stderr is the reason", blocked.feedback.includes("nope"), blocked.feedback);

// ---- match filters by tool name ------------------------------------------------------------
const unmatched = await withHooks("PreToolUse", [{ match: "edit_file", command: "exit 2" }], { tool: "run_bash" });
check("match miss → hook skipped", !unmatched.block);
const matched = await withHooks("PreToolUse", [{ match: "run_bash", command: "exit 2" }], { tool: "run_bash" });
check("match hit → hook runs", matched.block);

// ---- a broken hook (other exit code) does NOT wedge the agent -------------------------------
const broken = await withHooks("PreToolUse", [{ command: "exit 7" }], { tool: "run_bash" });
check("other exit code → not a block (logged, ignored)", !broken.block);

// ---- the hook receives the event payload on stdin -------------------------------------------
const echoed = await withHooks("PreToolUse", [{ command: "cat 1>&2; exit 2" }], { tool: "run_bash", args: '{"command":"ls"}' });
check("payload reaches the hook on stdin", echoed.feedback.includes("run_bash") && echoed.feedback.includes("PreToolUse"), echoed.feedback);

// ---- a hung hook is killed by the timeout, not allowed to hang -------------------------------
const t0 = Date.now();
const slow = await withHooks("PreToolUse", [{ command: "sleep 10", timeoutMs: 300 }], { tool: "run_bash" });
check("hook timeout kills fast", Date.now() - t0 < 2000 && !slow.block, `${Date.now() - t0}ms`);

// ---- multiple hooks: any exit 2 blocks, all stdout collected ---------------------------------
const many = await withHooks("PreToolUse", [{ command: "echo first" }, { command: "echo second 1>&2; exit 2" }], { tool: "run_bash" });
check("one blocker among several → block", many.block && many.feedback.includes("second"), JSON.stringify(many));

// ---- PreToolUse can REWRITE the tool arguments (the §14.3 "side road") -----------------------
const rewritten = await withHooks(
  "PreToolUse",
  [{ command: `echo '{"toolInput":{"command":"git commit -m x --trailer Co-Authored-By:bot"}}'` }],
  { tool: "run_bash", args: '{"command":"git commit -m x"}' },
);
check("PreToolUse rewrite is captured", !!rewritten.rewrite && rewritten.rewrite.includes("--trailer"), String(rewritten.rewrite));
check("a rewrite does not block", !rewritten.block);
const plainOut = await withHooks("PreToolUse", [{ command: "echo just a log line" }], { tool: "run_bash" });
check("non-control stdout is NOT treated as a rewrite", plainOut.rewrite === undefined);

// ---- new events run through the same machinery ----------------------------------------------
const ups = await withHooks("UserPromptSubmit", [{ command: "echo blocked 1>&2; exit 2" }], { prompt: "do the thing" });
check("UserPromptSubmit can block (caller drops the prompt)", ups.block && ups.feedback.includes("blocked"));
const sub = await withHooks("SubagentStart", [{ command: "echo noted" }], { description: "explore" });
check("SubagentStart runs (observational)", !sub.block && sub.stdout.includes("noted"));

// ---- SessionEnd gets a TINY timeout (must exit fast on Ctrl+C) -------------------------------
const tEnd = Date.now();
const slowEnd = await withHooks("SessionEnd", [{ command: "sleep 5" }]); // no explicit timeoutMs → uses the SessionEnd default (1.5s)
check("SessionEnd is killed at ~1.5s, not 10s", Date.now() - tEnd < 2500 && !slowEnd.block, `${Date.now() - tEnd}ms`);

finish();

import { spawn } from "node:child_process"; // hooks are external programs
import chalk from "chalk"; // status lines
import { CONFIG, type HookDef } from "./config.js"; // user-configured hooks
import { emit } from "./telemetry.js"; // count hook activity

// Hooks let users extend the agent without touching its source: an external
// program runs at a lifecycle moment and can observe — or block — what happens.
// The contract is deliberately language-agnostic (a shell command, JSON on
// stdin, the exit code as the verdict) so a hook can be a bash one-liner, a
// Python script, anything. This is the "keep the core small, bolt business
// logic on via hooks" architecture.
//
// Communication protocol (per event):
//   exit 0  → allow. stdout is shown to the model only for SessionStart.
//   exit 2  → block. stderr is fed back to the model as the reason.
//   other   → the hook itself errored; we log and treat it as allow (a broken
//             hook must not wedge the agent — but it is loud, not silent).
const DEFAULT_HOOK_TIMEOUT_MS = 10_000; // a hook gets 10s, then we kill it

// The lifecycle moments a hook can attach to.
export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart" | "Stop";

// What running the hooks for one event produced.
export interface HookOutcome {
  block: boolean; // did any hook exit 2? (PreToolUse → don't run; Stop → keep going)
  feedback: string; // combined stderr from blocking hooks — fed to the model
  stdout: string; // combined stdout — injected as context (used by SessionStart)
}

// Run one hook process, feeding it the event payload on stdin.
function runOne(hook: HookDef, payload: object): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(hook.command, { shell: true, stdio: ["pipe", "pipe", "pipe"] }); // shell so users can write one-liners
    let stdout = "", stderr = "", settled = false; // accumulate; resolve once
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL"); // a hung hook is killed, never hangs the agent
      done(124); // 124 = timed out (treated as "other" → allow, logged)
    }, hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => done(127)); // could not start (e.g. command not found)
    child.on("close", (code) => done(code ?? 0));
    child.stdin.end(JSON.stringify(payload)); // the event, as JSON, on stdin
  });
}

// Run every hook registered for an event, in order, and combine their verdicts.
// `match` (when present) filters by tool name so a hook can target one tool.
export async function runHooks(event: HookEvent, payload: { tool?: string } & Record<string, unknown>): Promise<HookOutcome> {
  const hooks = (CONFIG.hooks[event] ?? []).filter((h) => !h.match || h.match === payload.tool); // applicable hooks only
  if (!hooks.length) return { block: false, feedback: "", stdout: "" }; // the common case: nothing registered

  const feedback: string[] = []; // stderr from blocking hooks
  const stdout: string[] = []; // stdout from passing hooks
  let block = false; // did any hook exit 2?
  for (const hook of hooks) {
    const { code, stdout: out, stderr: err } = await runOne(hook, { event, ...payload }); // run it
    emit("agent_hook_run", { event, code }); // observability for hooks themselves
    if (code === 0) {
      if (out) stdout.push(out); // passing-hook output (used by SessionStart)
    } else if (code === 2) {
      block = true; // a blocking verdict
      feedback.push(err || `(${event} hook blocked with no message)`); // the reason, for the model
    } else {
      // Any other code: the hook is broken. Be loud, but do not wedge the agent.
      console.error(chalk.yellow(`  [hook] ${event} command exited ${code} (ignored): ${(err || out).slice(0, 120)}`));
    }
  }
  return { block, feedback: feedback.join("\n"), stdout: stdout.join("\n") };
}

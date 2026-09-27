import { spawn } from "node:child_process"; // hooks are external programs
import { randomUUID } from "node:crypto"; // turn ids
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
//   exit 0  → allow. stdout is captured (SessionStart/UserPromptSubmit inject it
//             as context; a PreToolUse hook may emit {"toolInput":{…}} to REWRITE
//             the tool's arguments — something the 3-state permission gate can't).
//   exit 2  → block. stderr is fed back to the model. The MEANING of "block"
//             differs by event and is the caller's to interpret (PreToolUse →
//             don't run; Stop → keep going; UserPromptSubmit → drop the prompt;
//             observational events just ignore it).
//   other   → the hook itself errored; we log and treat it as allow (a broken
//             hook must not wedge the agent — but it is loud, not silent).
const DEFAULT_HOOK_TIMEOUT_MS = 10_000; // most hooks get 10s, then we kill it

// Differentiated timeouts: SessionEnd fires when the user is leaving (often via
// Ctrl+C) — it MUST return almost instantly, so it gets a tiny budget.
const EVENT_TIMEOUT_MS: Partial<Record<HookEvent, number>> = { SessionEnd: 1_500 };

// The lifecycle moments a hook can attach to. (A subset of the handbook's 26 —
// the ones whose moments this agent actually has.)
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "Stop"
  | "UserPromptSubmit" // the user submitted a prompt — exit 2 drops it; stdout adds context
  | "SessionEnd" // the session is ending — cleanup; tiny timeout
  | "PreCompact" // before context compaction
  | "PostCompact" // after context compaction
  | "SubagentStart" // a sub-agent is about to run
  | "SubagentStop" // a sub-agent finished
  | "PermissionRequest" // a tool call is about to ask the human — a hook may decide instead (runPermissionHooks)
  | "Notification" // the agent needs the human (notification_type "permission_prompt": the approval menu is up)
  | "TurnEnd"; // a turn is over and the session is saved — fires on every end, interrupts and errors included

// Fields every payload carries, in Claude Code's names, so one hook script can
// serve both agents: which session, where its transcript is, the working
// directory, and which turn. An orchestrator uses them to tell sessions and
// turns apart (a hook from an interrupted turn arrives late and must be dropped).
let hookContext: { session_id?: string; transcript_path?: string; cwd?: string } = {};
let currentTurnId: string | undefined;

export function setHookContext(context: { session_id: string; transcript_path: string }): void {
  hookContext = { ...context, cwd: process.cwd() };
}

// Start a new turn id. Called when a prompt is submitted (before its
// UserPromptSubmit hook) or when a turn starts without one (cron, goals, peers).
export function beginTurn(): string {
  currentTurnId = randomUUID();
  return currentTurnId;
}

// Claude Code's names for the tool fields, next to this agent's own
// (tool/args/result), so existing hooks keep working.
function claudeToolFields(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.tool !== "string") return {};
  let input: unknown = payload.args;
  try {
    if (typeof payload.args === "string") input = JSON.parse(payload.args);
  } catch {
    /* not JSON — pass the raw string */
  }
  return { tool_name: payload.tool, tool_input: input, ...(typeof payload.result === "string" ? { tool_response: payload.result } : {}) };
}

function fullPayload(event: HookEvent, payload: Record<string, unknown>): object {
  return { event, hook_event_name: event, ...hookContext, prompt_id: currentTurnId, ...claudeToolFields(payload), ...payload };
}

// What running the hooks for one event produced.
export interface HookOutcome {
  block: boolean; // did any hook exit 2? (meaning is event-specific — see above)
  feedback: string; // combined stderr from blocking hooks — fed to the model
  stdout: string; // combined stdout — injected as context (SessionStart / UserPromptSubmit)
  rewrite?: string; // a PreToolUse hook's replacement tool arguments (JSON), if any
}

// Run one hook process, feeding it the event payload on stdin.
function runOne(hook: HookDef, payload: object, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
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
    }, hook.timeoutMs ?? timeoutMs);
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
  let rewrite: string | undefined; // a PreToolUse hook's replacement args
  const timeout = EVENT_TIMEOUT_MS[event] ?? DEFAULT_HOOK_TIMEOUT_MS; // SessionEnd gets a tiny budget
  for (const hook of hooks) {
    const { code, stdout: out, stderr: err } = await runOne(hook, fullPayload(event, payload), timeout); // run it
    emit("agent_hook_run", { event, code }); // observability for hooks themselves
    if (code === 0) {
      if (out) {
        stdout.push(out); // passing-hook output (used by SessionStart / UserPromptSubmit)
        // A PreToolUse hook can REWRITE the tool's arguments by printing
        // {"toolInput": {...}} — the "side road" the permission gate can't take
        // (it only allows/denies). Classic use: rewrite `git commit` to add a
        // trailer. Last writer wins if several hooks rewrite.
        if (event === "PreToolUse") {
          try {
            const parsed = JSON.parse(out) as { toolInput?: unknown };
            if (parsed && parsed.toolInput && typeof parsed.toolInput === "object") rewrite = JSON.stringify(parsed.toolInput);
          } catch {
            /* not control JSON — just plain stdout */
          }
        }
      }
    } else if (code === 2) {
      block = true; // a blocking verdict
      feedback.push(err || `(${event} hook blocked with no message)`); // the reason, for the model
    } else {
      // Any other code: the hook is broken. Be loud, but do not wedge the agent.
      console.error(chalk.yellow(`  [hook] ${event} command exited ${code} (ignored): ${(err || out).slice(0, 120)}`));
    }
  }
  return { block, feedback: feedback.join("\n"), stdout: stdout.join("\n"), rewrite };
}

// A PermissionRequest hook may answer an approval before the human sees it.
// Its stdout uses Claude Code's shape, so an orchestrator can drive both agents
// with one reply:
//   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
//   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"why"}}}
// Exit 2 is also a deny (stderr is the reason). Anything else — no output, a
// timeout, a crash, no hook at all — is NO decision, never an allow: the
// question goes on to the human as before. A deny from any hook wins.
export type PermissionDecision = { behavior: "allow" } | { behavior: "deny"; message: string } | null;

export async function runPermissionHooks(payload: Record<string, unknown>): Promise<PermissionDecision> {
  const hooks = (CONFIG.hooks.PermissionRequest ?? []).filter((h) => !h.match || h.match === payload.tool);
  let allowed = false;
  for (const hook of hooks) {
    const { code, stdout, stderr } = await runOne(hook, fullPayload("PermissionRequest", payload), DEFAULT_HOOK_TIMEOUT_MS);
    emit("agent_hook_run", { event: "PermissionRequest", code });
    if (code === 2) return { behavior: "deny", message: stderr || "denied by a PermissionRequest hook" };
    if (code !== 0 || !stdout) continue;
    try {
      const decision = (JSON.parse(stdout) as { hookSpecificOutput?: { decision?: { behavior?: string; message?: string } } }).hookSpecificOutput?.decision;
      if (decision?.behavior === "deny") return { behavior: "deny", message: decision.message || "denied by a PermissionRequest hook" };
      if (decision?.behavior === "allow") allowed = true;
    } catch {
      /* not a decision — ignore */
    }
  }
  return allowed ? { behavior: "allow" } : null;
}

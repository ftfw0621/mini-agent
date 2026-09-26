import type OpenAI from "openai"; // the verifier is just another model call
import crypto from "node:crypto"; // fingerprint the working tree between goal turns
import fs from "node:fs"; // stat untracked files for the fingerprint
import { execFileSync, spawn } from "node:child_process"; // git for the fingerprint, sh for the --check command
import { sessionChanges } from "./undo.js"; // files the agent's own tools changed this session
import { emit } from "./telemetry.js"; // observe goal lifecycle + verifier decisions

// /goal (Day 41): a DURABLE objective. A normal prompt ends when the model stops
// calling tools — the model decides it is done. A goal moves that decision out
// of the model's hands: every time a turn ends, the REPL checks the goal, and if
// it is still active it starts ANOTHER turn on its own. The run ends only when
//   - the goal is verified COMPLETE (the model claims it with evidence, the
//     user's --check command passes, and an independent verifier agrees),
//   - the model reports it BLOCKED (it needs the user),
//   - it is PAUSED (Esc / Ctrl+C, a failed turn, or no progress), or
//   - the user clears it.
//
// Why continue at the REPL (a new turn each time) and not inside runLoop? A goal
// may run for hours. Every per-query safety budget in the loop (retries,
// compactions) is sized for ONE turn — a goal living inside one query would hit
// MAX_COMPACTIONS_PER_QUERY and die. Turn-by-turn continuation resets them, and
// it only ever fires when the REPL is idle, so a message you type always wins.
//
// There is deliberately NO cost or round cap here: a goal runs until the job is
// done. The runaway fuse is PROGRESS instead — a goal turn with no tool calls
// pauses at once (the model is just talking), and MAX_STALLED_TURNS goal turns
// in a row that leave the working tree untouched pause it too (the model is
// busy, but going nowhere).

export type GoalStatus = "active" | "paused" | "blocked" | "complete";
export interface Goal {
  objective: string; // what "done" means, in the user's words
  check?: string; // optional shell command that must exit 0 before completion is even considered
  status: GoalStatus;
  continuations: number; // goal turns started so far
  stalls: number; // consecutive goal turns that changed nothing
  note?: string; // why it paused / blocked / completed — shown by /goal
  setAt: string; // ISO timestamp
}

export const MAX_STALLED_TURNS = 3; // goal turns in a row with an unchanged working tree → pause
const CHECK_TIMEOUT_MS = 10 * 60_000; // a test suite may be slow — but not forever
const CHECK_OUTPUT_TAIL = 4_000; // chars of check output fed back (the END is where failures are)
const OBSERVATION_CHARS = 1_200; // per tool result shown to the verifier
const OBSERVATIONS_BUDGET = 12_000; // total chars of recent tool results shown to the verifier
const VERIFIER_MAX_TOKENS = 200; // one tag + one sentence

// ---- session state ------------------------------------------------------------
// One goal per session, in process memory like the todo list — but unlike the
// todo list it is written into the session file (session.ts), so `--resume`
// picks up a half-finished goal and keeps going.
let current: Goal | null = null;
let inFlight: { fingerprint: string; toolCalls: number } | null = null; // the goal turn now running
let toolCalls = 0; // top-level tool calls this process (loop.ts counts them) — survives compaction, unlike message indexes

export function getGoal(): Goal | null {
  return current;
}
export function clearGoal(): void {
  current = null;
  inFlight = null;
}
// Adopt a goal loaded from a session file (or none). A malformed one is dropped.
export function restoreGoal(goal: Goal | undefined | null): void {
  inFlight = null;
  current = goal && typeof goal.objective === "string" && goal.objective.trim() ? { ...goal, stalls: goal.stalls ?? 0, continuations: goal.continuations ?? 0 } : null;
}
function setStatus(status: GoalStatus, note?: string): void {
  if (!current) return;
  current.status = status;
  current.note = note;
  emit("agent_goal_status", { status });
}
export function countGoalToolCall(): void {
  toolCalls++;
}

// ---- pure: parse "/goal ..." ----------------------------------------------------
// `/goal`                         show the goal
// `/goal pause|resume|clear`      lifecycle
// `/goal <objective> [--check <command>]`   set (replaces any previous goal)
// --check comes LAST and takes the rest of the line, optionally quoted, so
// `--check npm test` and `--check "npm test && npm run typecheck"` both work.
export type GoalCommand =
  | { kind: "show" | "pause" | "resume" | "clear" }
  | { kind: "set"; objective: string; check?: string }
  | { kind: "error"; message: string };
export function parseGoalCommand(args: string): GoalCommand {
  const text = args.trim();
  if (!text) return { kind: "show" };
  if (text === "pause" || text === "resume" || text === "clear") return { kind: text };
  const m = text.match(/^([\s\S]*?)\s*--check\s+([\s\S]+)$/);
  let objective = text;
  let check: string | undefined;
  if (m) {
    objective = m[1].trim();
    check = m[2].trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim(); // strip one pair of matching quotes
    if (!check) return { kind: "error", message: "--check needs a command, e.g. --check \"npm test\"" };
  } else if (/(^|\s)--check\s*$/.test(text)) {
    return { kind: "error", message: "--check needs a command, e.g. --check \"npm test\"" };
  }
  if (!objective) return { kind: "error", message: "usage: /goal <objective> [--check <command>]" };
  return { kind: "set", objective, check };
}

// ---- pure: render the goal for /goal -------------------------------------------
export function describeGoal(goal: Goal | null): string {
  if (!goal) return "(no goal — set one with /goal <objective> [--check <command>])";
  const lines = [
    `goal [${goal.status}]: ${goal.objective}`,
    goal.check ? `  check: ${goal.check}` : "  check: (none — the verifier judges from evidence alone)",
    `  turns: ${goal.continuations}${goal.stalls ? ` · no progress in the last ${goal.stalls}` : ""}`,
  ];
  if (goal.note) lines.push(`  note: ${goal.note}`);
  if (goal.status === "paused" || goal.status === "blocked") lines.push("  /goal resume to continue · /goal clear to drop it");
  return lines.join("\n");
}

// ---- the /goal command (shared by both REPLs) ----------------------------------
// Returns the line to show, plus `request`: the human text to record as a user
// request for auto mode. Only the /goal line the human typed authorizes work —
// the automatic continuation turns never do, or each one would widen what the
// reviewer thinks was approved.
export function goalCommand(args: string): { message: string; request?: string } {
  const cmd = parseGoalCommand(args);
  switch (cmd.kind) {
    case "error":
      return { message: cmd.message };
    case "show":
      return { message: describeGoal(current) };
    case "clear":
      if (!current) return { message: "(no goal to clear)" };
      clearGoal();
      emit("agent_goal_status", { status: "cleared" });
      return { message: "(goal cleared)" };
    case "pause":
      if (current?.status !== "active") return { message: `(no active goal to pause${current ? ` — it is ${current.status}` : ""})` };
      setStatus("paused", "paused by you");
      return { message: "(goal paused — /goal resume to continue)" };
    case "resume":
      if (!current) return { message: "(no goal to resume)" };
      if (current.status === "complete") return { message: "(that goal is already complete — set a new one with /goal <objective>)" };
      if (current.status === "active") return { message: "(the goal is already active)" };
      setStatus("active");
      current.stalls = 0; // a fresh start after you stepped in
      return { message: `(goal resumed: ${current.objective})`, request: `/goal ${current.objective}` };
    case "set": {
      const replaced = current && current.status !== "complete";
      current = { objective: cmd.objective, check: cmd.check, status: "active", continuations: 0, stalls: 0, setAt: new Date().toISOString() };
      inFlight = null;
      emit("agent_goal_status", { status: "set", check: cmd.check ? 1 : 0 });
      return { message: `${replaced ? "(replaced the previous goal) " : ""}goal set: ${cmd.objective}${cmd.check ? `\n  check: ${cmd.check}` : ""}\n  the agent keeps working until it is verified done — Esc pauses, /goal clear drops it`, request: `/goal ${args.trim()}` };
    }
  }
}

// ---- turn bookkeeping -----------------------------------------------------------
// The REPL calls startGoalTurn when it is idle. It returns the text of the next
// goal turn (or null if there is nothing to do), and snapshots the working tree
// so settleGoalTurn can tell whether the turn moved anything.
export function startGoalTurn(): string | null {
  if (current?.status !== "active" || inFlight) return null;
  inFlight = { fingerprint: workFingerprint(), toolCalls };
  current.continuations++;
  return goalTurnContent(current);
}

// The goal turn text. It restates the FULL objective every time: after a few
// compactions the original /goal message may be long gone from history, and
// this is what keeps the model aimed at the same target for hours.
export function goalTurnContent(goal: Goal): string {
  const head = goal.continuations <= 1 ? "[goal] A goal was just set. Work toward it until it is verified done." : `[goal] Continuation #${goal.continuations} — the goal is not verified done yet. Pick up where you left off.`;
  return [
    head,
    `Objective: ${goal.objective}`,
    goal.check ? `Completion check: \`${goal.check}\` must exit 0 — the harness runs it when you claim completion.` : "",
    "Inspect, change, run and verify. Each time you stop you will be sent back here, until you call update_goal:",
    '  - update_goal({status: "complete", report}) — only after checking the objective against concrete evidence (commands you ran, their output, files you changed). An independent verifier re-checks against your recent tool results; an unsupported claim is rejected.',
    '  - update_goal({status: "blocked", report}) — when no valid path remains or you need the user: what you tried, the blocker, and the input you need.',
    "Do not stop just to summarize progress: a goal turn that makes no tool calls pauses the goal.",
  ].filter(Boolean).join("\n");
}

// After ANY turn ends. Returns a line for the screen, or null. `goalTurn` says
// whether this was a goal turn (vs. the user's own message); `reason` is the
// loop's TerminateReason (or "error" if the turn threw); `followUp` is true when
// the turn was interrupted only to deliver a queued message — that is the user
// steering, not stopping, so it must not pause the goal.
export function settleGoalTurn(reason: string, goalTurn: boolean, followUp = false): string | null {
  const turn = inFlight;
  if (goalTurn) inFlight = null;
  if (current?.status !== "active") return null; // update_goal finished it mid-turn (it announced that itself)
  if (reason === "user_interrupt") {
    if (followUp) return null;
    setStatus("paused", "interrupted by you");
    return "◎ goal paused (interrupted) — /goal resume to continue";
  }
  if (!goalTurn || !turn) return null; // your own message ended normally — the goal simply continues next
  if (reason !== "done") {
    setStatus("paused", `a goal turn ended with ${reason}`);
    return `◎ goal paused — the turn ended with ${reason}. /goal resume to try again`;
  }
  if (toolCalls === turn.toolCalls) {
    setStatus("paused", "a goal turn made no tool calls");
    return "◎ goal paused — the agent stopped without doing anything. Reply to steer it, then /goal resume";
  }
  current.stalls = workFingerprint() === turn.fingerprint ? current.stalls + 1 : 0;
  if (current.stalls >= MAX_STALLED_TURNS) {
    setStatus("paused", `no file changes in ${current.stalls} goal turns in a row`);
    return `◎ goal paused — no progress in ${current.stalls} turns in a row. Reply to steer it, then /goal resume`;
  }
  return null;
}

// Did anything change? The agent's own writes (undo.ts tracks their current
// content, so rewriting the same file counts) plus git's view, which also sees
// what run_bash changed (sed, codegen, npm install). `git diff` is blind to
// untracked files, so their size + mtime go in too. Not in a git repo → the
// agent's writes alone.
const MAX_UNTRACKED = 2_000; // stat at most this many untracked files per fingerprint
function workFingerprint(): string {
  const h = crypto.createHash("sha1");
  for (const c of sessionChanges()) h.update(c.path).update("\0").update(c.current).update("\0");
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  try {
    // Our own bookkeeping (.mini-agent/: the session file, logs, spilled output)
    // churns every turn and is rarely gitignored — counting it as "progress"
    // would reset the stall count every turn and disarm the fuse.
    const lines = git(["status", "--porcelain", "-uall"]).split("\n").filter((l) => l && !/^.. "?\.mini-agent\//.test(l));
    h.update(lines.join("\n")).update(git(["diff"]));
    const untracked = lines.filter((l) => l.startsWith("?? ")).slice(0, MAX_UNTRACKED);
    for (const line of untracked) {
      try {
        const st = fs.statSync(line.slice(3));
        h.update(`${line}\0${st.size}\0${st.mtimeMs}\0`);
      } catch {
        /* vanished between status and stat — the next fingerprint sees it */
      }
    }
  } catch {
    /* not a git repo, or git missing — the agent's own writes still count */
  }
  return h.digest("hex");
}

// ---- update_goal: the model's only way to END a goal ----------------------------
export const updateGoalTool: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "update_goal",
    description: `End the active /goal, as "complete" or "blocked". While a goal is active you are sent back to work every time you stop, so this is how you finish.
complete: only after you checked the objective against concrete evidence — tests you ran and their output, files you changed, results you saw. The user's completion check (if any) is run, then an independent verifier compares your report with your recent tool results. If either fails you get the reason back and the goal stays active.
blocked: when no valid path remains or you need something only the user can give. Report what you tried, the blocker, and the exact input you need.`,
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["complete", "blocked"], description: "complete = the objective is achieved and evidenced; blocked = you need the user" },
        report: { type: "string", description: "complete: the evidence (what you ran/changed and what it showed). blocked: what you tried, the blocker, the input you need." },
      },
      required: ["status", "report"],
    },
  },
};

export interface GoalToolContext {
  client: OpenAI;
  model: string; // verifier model
  signal: AbortSignal;
  transcript: readonly OpenAI.ChatCompletionMessageParam[]; // the conversation, for the verifier's observations
  note: (line: string) => void; // screen output
}

// Run update_goal. Never throws; every outcome is text for the model.
export async function runUpdateGoal(rawArgs: string, ctx: GoalToolContext): Promise<string> {
  if (current?.status !== "active") return "[error] There is no active goal. update_goal is only for ending a goal the user set with /goal.";
  let status = "", report = "";
  try {
    const a = JSON.parse(rawArgs) as { status?: string; report?: string };
    status = a.status ?? "";
    report = (a.report ?? "").trim();
  } catch {
    /* fall through */
  }
  if (status !== "complete" && status !== "blocked") return '[error] update_goal needs status "complete" or "blocked".';
  if (!report) return "[error] update_goal needs a non-empty report — the evidence (complete) or the blocker (blocked).";

  if (status === "blocked") {
    setStatus("blocked", report.slice(0, 300));
    ctx.note(`◎ goal blocked — ${report.slice(0, 160)}`);
    return "Goal marked blocked; no more automatic turns. Stop now and tell the user what you tried, the blocker, and the input you need.";
  }

  // 1. The hard gate: the user's own --check command. It was typed by the human
  //    in /goal, so it does not go through the permission gate — and the model
  //    has no way to change it. Nonzero exit → not done, no verifier call.
  let checkLine = "";
  if (current.check) {
    ctx.note(`◎ goal check: ${current.check}`);
    const r = await runCheck(current.check, ctx.signal);
    if (r.code !== 0) {
      emit("agent_goal_claim", { accepted: 0, by: "check" });
      ctx.note(`◎ goal check failed (${r.code === null ? "timed out / killed" : `exit ${r.code}`}) — not done`);
      return `[goal] Not complete: the completion check \`${current.check}\` ${r.code === null ? "timed out or was killed" : `exited ${r.code}`}. The goal stays active — fix it and claim again.\nCheck output (tail):\n${r.output || "(no output)"}`;
    }
    checkLine = `The completion check \`${current.check}\` passed (exit 0). Output tail:\n${r.output || "(no output)"}`;
  }

  // 2. The independent verifier: a separate model call that sees what the tools
  //    actually returned, not just what the model says about them.
  ctx.note("◎ goal verifier: checking the claim against the evidence…");
  const verdict = await verifyGoal(ctx, current, report, checkLine);
  emit("agent_goal_claim", { accepted: verdict.done ? 1 : 0, by: "verifier" });
  if (!verdict.done) {
    ctx.note(`◎ goal verifier: not done — ${verdict.reason.slice(0, 160)}`);
    return `[goal] Not complete — the verifier rejected the claim: ${verdict.reason}\nThe goal stays active. Close the gap (or gather the missing evidence), then claim again.`;
  }
  setStatus("complete", verdict.reason.slice(0, 300));
  ctx.note(`◎ goal complete ✓ — ${verdict.reason.slice(0, 160)}`);
  return "Goal verified complete. Give the user a short final report: what was done and the evidence.";
}

// Run the user's check command. Output is capped to its TAIL — test runners
// print the failures (and the summary) last.
function runCheck(command: string, signal: AbortSignal): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (b: Buffer) => {
      out = (out + b.toString("utf8")).slice(-CHECK_OUTPUT_TAIL * 4); // bounded memory, trimmed properly below
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, CHECK_TIMEOUT_MS);
    signal.addEventListener("abort", kill, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      resolve({ code, output: out.slice(-CHECK_OUTPUT_TAIL).trim() });
    };
    child.on("error", (e) => {
      out += `\n${e.message}`;
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

// The verifier's prompt is blunt for the same reason as the permission judge's:
// a rigid tag is unambiguous to parse, and "doubt → no" is the load-bearing line.
const VERIFIER_SYSTEM = `You verify whether a coding agent has ACHIEVED a goal. You are given the goal's objective, the agent's completion report, the result of the user's completion check (if any), and the agent's most recent tool calls with what they actually returned.
Judge from the tool results — they are observations. The agent's report is a claim, not evidence. Every part of the objective must be demonstrably satisfied by the observations; if something is missing, unverified, or contradicted, the goal is NOT done.
Err on the side of NO.
Respond with exactly two lines:
<done>yes</done> or <done>no</done>
one sentence: why — if no, what is missing.`;

// PURE: parse the verifier reply. Fail closed — only a clean yes is done.
export function interpretVerdict(text: string): { done: boolean; reason: string } {
  const m = text.match(/<done>\s*(yes|no)\s*<\/done>/i);
  const reason = text.replace(/<done>[\s\S]*?<\/done>/i, "").trim().replace(/\s+/g, " ") || "(no reason given)";
  if (!m) return { done: false, reason: `unparseable verifier reply: ${text.trim().slice(0, 120) || "(empty)"}` };
  return { done: m[1].toLowerCase() === "yes", reason };
}

// PURE: the agent's most recent tool calls with their results, newest last,
// each capped, within a total budget — the verifier's evidence.
export function recentObservations(messages: readonly OpenAI.ChatCompletionMessageParam[]): string {
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === "tool") results.set(m.tool_call_id, typeof m.content === "string" ? m.content : "");
  const items: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && used < OBSERVATIONS_BUDGET; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const call of [...m.tool_calls].reverse()) {
      if (call.type !== "function" || call.function.name === "update_goal" || !results.has(call.id)) continue;
      const result = results.get(call.id)!;
      const item = `$ ${call.function.name} ${call.function.arguments.slice(0, 300)}\n${result.length > OBSERVATION_CHARS ? result.slice(0, OBSERVATION_CHARS) + " …(truncated)" : result}`;
      if (used + item.length > OBSERVATIONS_BUDGET) break;
      items.unshift(item);
      used += item.length;
    }
  }
  return items.length ? items.join("\n\n") : "(no tool calls in the conversation)";
}

async function verifyGoal(ctx: GoalToolContext, goal: Goal, report: string, checkLine: string): Promise<{ done: boolean; reason: string }> {
  try {
    const res = await ctx.client.chat.completions.create(
      {
        model: ctx.model,
        max_tokens: VERIFIER_MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: "system", content: VERIFIER_SYSTEM },
          { role: "user", content: [`Objective:\n${goal.objective}`, `Agent's completion report:\n${report}`, checkLine || "No completion check was configured.", `Recent tool calls and results (oldest first):\n${recentObservations(ctx.transcript)}`].join("\n\n") },
        ],
      },
      { signal: ctx.signal },
    );
    return interpretVerdict(res.choices[0]?.message?.content ?? "");
  } catch (e) {
    // A verifier that errors must never accidentally complete a goal.
    return { done: false, reason: `the verifier call failed (${(e as Error).message}) — claim again` };
  }
}

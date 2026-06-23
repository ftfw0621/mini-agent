import path from "node:path"; // used to resolve and split file paths
import { CONFIG } from "./config.js"; // user-configured allow/deny rules from settings files

// Three verdicts, checked in strict order. The invariant that holds the whole
// system together: DENY ALWAYS WINS. No flag, no auto-approve mode, no clever
// prompt can override a deny — otherwise one malicious instruction could
// disarm every safety rule at once.
export type Decision = "allow" | "ask" | "deny";

// What a permission check returns.
export interface Verdict {
  decision: Decision; // allow / ask / deny
  reason: string; // why — shown to the user and fed back to the model
  summary: string; // what we show the user in the confirmation prompt
}

// ---- The no-fly zone --------------------------------------------------------
// Writes here are never OK, in any mode. .git can destroy history, shell rc
// files inject code into every future terminal, .ssh/.env leak credentials.
const NO_FLY_DIRS = new Set([".git", ".ssh", ".claude"]); // directory names that must never be written into
const NO_FLY_FILES = new Set([".env", ".bashrc", ".zshrc", ".gitconfig", ".mcp.json"]); // file names that must never be written

// Files whose CONTENT must never enter the model's context: once a secret is
// in the conversation, it is in every later API request (and maybe in logs).
const SECRET_FILE_RE = /(^|\/)(\.env[^/]*|id_rsa[^/]*|[^/]+\.(pem|key))$/;

// Does this path touch the no-fly zone? Returns the reason, or null if clean.
function noFlyHit(p: string): string | null {
  const abs = path.resolve(p); // normalize to an absolute path first
  for (const part of abs.split(path.sep)) {
    // match whole path segments — ".github" must NOT be caught by ".git"
    if (NO_FLY_DIRS.has(part)) return `${part}/ is a no-fly zone`;
  }
  if (NO_FLY_FILES.has(path.basename(abs))) return `${path.basename(abs)} is a no-fly zone file`; // exact file-name match
  return null; // not in the zone
}

// ---- Bash command analysis --------------------------------------------------
// Input-aware safety: run_bash is not one tool, it is a thousand tools wearing
// a coat. "ls" and "rm -rf" deserve different treatment, so we look at the input.

// Hard stops. Not a question — these never run.
const BASH_DENY: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]+\s+)*['"]?(\/|~)['"]?(\s|$)/, "rm targeting / or ~ — catastrophic"], // rm -rf / and rm -rf ~
  [/(^|[\s;&|/])\.git(\/|\s|$)/, "touches the .git directory"], // any command naming .git — the / in the prefix class catches absolute paths like /repo/.git
  [/(^|[\s;&|/])\.env(\s|$|[;&|])/, ".env holds secrets"], // any command that names .env
  [/(^|[\s;&|/])\.ssh(\/|\s|$)/, ".ssh holds credentials"], // any command that names .ssh — same / fix
];

// Dangerous but sometimes legitimate — stop and ask the human.
const BASH_ASK: Array<[RegExp, string]> = [
  [/\brm\b.*-[a-zA-Z]*r/, "recursive delete"], // rm -r / -rf — deletes whole trees
  [/\brm\b/, "deletes files"], // plain rm — still destructive
  [/\bsudo\b/, "runs as root"], // privilege escalation
  [/\bdrop\s+(table|database)\b/i, "destroys database objects"], // SQL drop
  [/\b(curl|wget)\b[^|;&]*\|\s*(ba|z)?sh\b/, "pipes the internet into a shell"], // curl ... | sh
  [/\bgit\s+push\b.*(--force|\s-f\b)/, "force-push rewrites remote history"], // git push --force
  [/\bgit\s+(reset\s+--hard|clean\b)/, "discards local changes"], // git reset --hard / git clean
  [/\bchmod\b/, "changes file permissions"], // permission changes
];

// Single, read-only-ish commands that run without asking.
const BASH_ALLOW = new Set(["ls", "pwd", "echo", "wc", "which", "date", "node", "npm", "npx", "cat", "head", "tail"]);
const GIT_READONLY = new Set(["status", "log", "diff", "show", "branch", "remote", "tag"]); // git subcommands that only read

// User rules from settings files, split by kind. Computed per call (not cached)
// so the test suite can mutate CONFIG.permissions and see the effect.
function userBashRules(): { allow: string[]; deny: string[] } {
  return {
    allow: CONFIG.permissions.allow.filter((r) => !r.startsWith("tool:")), // bash first-words to trust
    deny: CONFIG.permissions.deny.filter((r) => !r.startsWith("tool:")), // command substrings to block
  };
}

// Decide what a bash command deserves: deny, ask, or allow.
function checkBash(command: string): Verdict {
  const summary = command.trim(); // what the user will see in the prompt
  const user = userBashRules(); // the user's configured additions
  // Order is the security model: built-in deny, then user deny, then ask,
  // then allow. A user allow can never jump this queue — allow is checked last.
  for (const [re, why] of BASH_DENY) if (re.test(command)) return { decision: "deny", reason: why, summary };
  for (const d of user.deny)
    if (command.toLowerCase().includes(d.toLowerCase())) return { decision: "deny", reason: `denied by your settings ("${d}")`, summary };
  for (const [re, why] of BASH_ASK) if (re.test(command)) return { decision: "ask", reason: why, summary };
  // Compound commands (&&, ;, |, $(), ``) are too hard to reason about — ask.
  if (/[;&|]|\$\(|`/.test(command)) return { decision: "ask", reason: "compound command", summary };
  const words = summary.split(/\s+/); // tokenize to inspect the first word
  if (words[0] === "git" && GIT_READONLY.has(words[1] ?? "")) return { decision: "allow", reason: "read-only git", summary }; // safe git subcommands
  if (BASH_ALLOW.has(words[0])) return { decision: "allow", reason: "safe command", summary }; // known-harmless single command
  if (user.allow.includes(words[0])) return { decision: "allow", reason: "allowed by your settings", summary }; // the user vouched for this command
  // Fail closed: a command we don't recognize is a question for the human.
  return { decision: "ask", reason: "unrecognized command", summary };
}

// ---- Plan mode (Day 20) ------------------------------------------------------
// A research-only mode. While it is on, the agent may observe — read files,
// search, run safe read-only shell — but every tool that mutates the world is
// blocked, until it presents a plan and the user approves it. The state lives
// here because the gate is what enforces it; the REPL toggles it with /plan, and
// the exit_plan_mode tool turns it off once the user approves a plan.
let planMode = false; // off by default — most sessions never touch it
export const isPlanMode = (): boolean => planMode; // the REPL reads this to mark its prompt
export const setPlanMode = (on: boolean): void => { planMode = on; }; // /plan and exit_plan_mode flip it

// In plan mode, is this call safe — i.e. does it only observe, never mutate?
// run_bash is decided by its own classifier: a command the gate already rated
// "allow" (ls, cat, git status) observes; "ask"/"deny" ones (rm, sudo) mutate.
function planSafe(toolName: string, verdict: Verdict): boolean {
  switch (toolName) {
    case "read_file":
    case "search":
    case "task": // the sub-agent's own calls hit this same gate, still in plan mode
    case "spawn_teammate": // a teammate's own calls hit this same gate (plan mode still blocks their writes)
    case "send_message": // coordination only — changes nothing on disk
    case "ask_user": // asking the user a question is safe in plan mode — it doesn't change anything
    case "skill": // loading a skill's instructions is read-only; what it does is gated per-call
    case "todo_write": // planning is exactly what plan mode is FOR — never block it
    case "bash_output": // reading a background task's output observes, never mutates
    case "exit_plan_mode": // the way OUT of plan mode must never be blocked by plan mode
      return true;
    case "run_bash":
    case "run_bash_background":
      return verdict.decision === "allow"; // only the read-only commands the classifier cleared
    default:
      return false; // write_file, edit_file, MCP and unknown tools: all mutate-or-unknown
  }
}

// ---- The single entry point ---------------------------------------------------
// Called by the loop for EVERY tool call, before anything executes. Plan mode is
// applied as an outer filter: it can only TIGHTEN the base decision (downgrade a
// mutating allow/ask to deny), never loosen one — a base "deny" keeps its more
// specific reason, because deny always wins.
export function checkPermission(toolName: string, argsJson: string): Verdict {
  const base = basePermission(toolName, argsJson);
  if (planMode && base.decision !== "deny" && !planSafe(toolName, base)) {
    return {
      decision: "deny",
      reason: "plan mode is on — investigate with read-only tools, then call exit_plan_mode to present a plan for the user to approve before you change anything",
      summary: base.summary,
    };
  }
  return base;
}

// The underlying rules, plan-mode-agnostic. Wrapped by checkPermission above.
function basePermission(toolName: string, argsJson: string): Verdict {
  // A user-configured tool block beats everything, including built-in allows.
  if (CONFIG.permissions.deny.includes(`tool:${toolName}`)) {
    return { decision: "deny", reason: `tool blocked by your settings ("tool:${toolName}")`, summary: toolName };
  }

  let args: Record<string, string>; // the parsed tool arguments
  try {
    args = JSON.parse(argsJson); // arguments arrive as a raw JSON string from the model
  } catch {
    // Let dispatch produce the proper JSON error for the model.
    return { decision: "allow", reason: "unparseable args", summary: toolName };
  }

  switch (toolName) {
    case "search":
      return { decision: "allow", reason: "read-only", summary: "search" }; // searching never mutates anything
    case "task":
      // Spawning a sub-agent is orchestration, not action: every tool the
      // sub-agent uses goes through this same gate individually.
      return { decision: "allow", reason: "sub-agent tools are gated individually", summary: "task" };
    case "spawn_teammate":
      // Same as task: spawning is orchestration. Each teammate's own tool calls
      // pass through this gate; a teammate's non-interactive policy auto-proceeds
      // on writes but a hard DENY here still stands (deny always wins).
      return { decision: "allow", reason: "teammate tools are gated individually", summary: "spawn_teammate" };
    case "send_message":
      // Dropping a message in another agent's mailbox has no filesystem effect on
      // the user's project — it is pure team coordination.
      return { decision: "allow", reason: "team coordination, no side effects", summary: "send_message" };
    case "ask_user":
      // Asking the user a question has no side effects — it's the safest thing
      // the model can do. Never gate it behind an approval prompt.
      return { decision: "allow", reason: "asks the user, no side effects", summary: "ask_user" };
    case "skill":
      // Loading a skill just returns instructions; whatever the skill then DOES
      // goes through this same gate, call by call. Loading itself is free.
      return { decision: "allow", reason: "loads instructions, no side effects", summary: "skill" };
    case "todo_write":
      // Writing the plan touches nothing but in-memory state and the screen.
      return { decision: "allow", reason: "updates the plan, no side effects", summary: "todo_write" };
    case "read_file": {
      const p = args.path ?? ""; // the file the model wants to read
      if (SECRET_FILE_RE.test(path.resolve(p))) {
        return { decision: "deny", reason: "secret files must never enter the model's context", summary: p }; // keys stay out of the conversation
      }
      return { decision: "allow", reason: "read-only", summary: p }; // normal reads are free
    }
    case "write_file":
    case "edit_file": {
      const p = args.path ?? ""; // the file the model wants to change
      const hit = noFlyHit(p); // is it in the no-fly zone?
      if (hit) return { decision: "deny", reason: hit, summary: p }; // hard stop — deny always wins
      // The user may pre-approve write tools ("tool:edit_file") to skip the
      // prompt — note this runs AFTER the no-fly check, so it widens "ask",
      // never "deny".
      if (CONFIG.permissions.allow.includes(`tool:${toolName}`)) {
        return { decision: "allow", reason: "pre-approved by your settings", summary: p };
      }
      return { decision: "ask", reason: "writes to your filesystem", summary: p }; // normal writes need a human yes
    }
    case "run_bash":
    case "run_bash_background": {
      // Backgrounding changes WHEN output comes back, never WHAT runs — so a
      // background command gets the exact same input-aware analysis as a
      // foreground one. The danger is in the command, not the blocking.
      const verdict = checkBash(args.command ?? ""); // bash gets input-aware analysis
      // "Don't ask again for run_bash this session" (chosen in the approval menu)
      // upgrades an ASK to ALLOW — but a hard DENY (rm -rf /, .git, .env…) always
      // stands. Convenience never overrides the no-fly rules. A grant for either
      // shell tool covers the other: the command is what was vouched for.
      if (verdict.decision === "ask" && (CONFIG.permissions.allow.includes(`tool:${toolName}`) || CONFIG.permissions.allow.includes("tool:run_bash"))) {
        return { decision: "allow", reason: "bash pre-approved for this session", summary: verdict.summary };
      }
      return verdict;
    }
    case "bash_output":
      // Polling a background task only reads its captured output and status —
      // it touches nothing on the user's filesystem. Always safe.
      return { decision: "allow", reason: "reads background task output, no side effects", summary: args.task_id ?? "bash_output" };
    case "exit_plan_mode": {
      // Outside plan mode this tool does nothing — let it through silently. In
      // plan mode it is the approval gate: ask the human, showing the plan, and
      // only on yes does the tool run and flip plan mode off.
      if (!planMode) return { decision: "allow", reason: "not in plan mode (no-op)", summary: "exit_plan_mode" };
      return { decision: "ask", reason: "leave plan mode and start implementing", summary: args.plan ?? "(no plan provided)" };
    }
    default:
      // Everything else — unknown tools and MCP tools (mcp__server__tool) —
      // gets the most suspicious treatment, not the least: ask. The user can
      // pre-approve a trusted MCP tool with "tool:mcp__server__tool" in
      // settings, or block one with "tool:..." in deny (checked at the top).
      if (CONFIG.permissions.allow.includes(`tool:${toolName}`)) {
        return { decision: "allow", reason: "pre-approved by your settings", summary: toolName };
      }
      return { decision: "ask", reason: toolName.startsWith("mcp__") ? "external MCP tool" : "unknown tool", summary: toolName };
  }
}

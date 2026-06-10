import path from "node:path"; // used to resolve and split file paths

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
  [/(^|[\s;&|])\.git(\/|\s|$)/, "touches the .git directory"], // any command that names .git
  [/(^|[\s;&|/])\.env(\s|$|[;&|])/, ".env holds secrets"], // any command that names .env
  [/(^|[\s;&|])~?\/?\.ssh(\/|\s|$)/, ".ssh holds credentials"], // any command that names .ssh
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

// Decide what a bash command deserves: deny, ask, or allow.
function checkBash(command: string): Verdict {
  const summary = command.trim(); // what the user will see in the prompt
  // Order is the security model: deny first, ask second, allow last.
  for (const [re, why] of BASH_DENY) if (re.test(command)) return { decision: "deny", reason: why, summary };
  for (const [re, why] of BASH_ASK) if (re.test(command)) return { decision: "ask", reason: why, summary };
  // Compound commands (&&, ;, |, $(), ``) are too hard to reason about — ask.
  if (/[;&|]|\$\(|`/.test(command)) return { decision: "ask", reason: "compound command", summary };
  const words = summary.split(/\s+/); // tokenize to inspect the first word
  if (words[0] === "git" && GIT_READONLY.has(words[1] ?? "")) return { decision: "allow", reason: "read-only git", summary }; // safe git subcommands
  if (BASH_ALLOW.has(words[0])) return { decision: "allow", reason: "safe command", summary }; // known-harmless single command
  // Fail closed: a command we don't recognize is a question for the human.
  return { decision: "ask", reason: "unrecognized command", summary };
}

// ---- The single entry point ---------------------------------------------------
// Called by the loop for EVERY tool call, before anything executes.
export function checkPermission(toolName: string, argsJson: string): Verdict {
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
      return { decision: "ask", reason: "writes to your filesystem", summary: p }; // normal writes need a human yes
    }
    case "run_bash":
      return checkBash(args.command ?? ""); // bash gets input-aware analysis
    default:
      // A tool we don't know gets the most suspicious treatment, not the least.
      return { decision: "ask", reason: "unknown tool", summary: toolName };
  }
}

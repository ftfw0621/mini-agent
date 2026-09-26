import path from "node:path"; // used to resolve and split file paths
import fs from "node:fs"; // resolve symlinks before auto mode grants file access
import os from "node:os"; // `cd ~` in the recoverable-shell analyzer
import { execFileSync } from "node:child_process"; // ask git whether a deletion target is disposable
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
  requiresHuman?: boolean; // an ask that no automatic reviewer may approve
  readOnly?: boolean; // false marks an allowed shell command that changes state (plan mode must still block it)
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

const GIT_DIR_RULE = "touches the .git directory";

// Hard stops. Not a question — these never run.
const BASH_DENY: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]+\s+)*['"]?(\/|~)['"]?(\s|$)/, "rm targeting / or ~ — catastrophic"], // rm -rf / and rm -rf ~
  [/(^|[\s;&|/])\.git(\/|\s|$)/, GIT_DIR_RULE], // any command naming .git — the / in the prefix class catches absolute paths like /repo/.git
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

// ---- Recoverable shell (auto mode) -------------------------------------------
// Auto mode draws its line at RECOVERABILITY, not at a risk score: if git, /undo
// or a rebuild can take an action back, it runs without review. This analyzer
// judges from the command text alone, so it is deliberately narrow. Anything
// whose effect depends on code (tests, builds, scripts), on expansion ($VAR,
// $(...), globs in deletions) or on syntax it does not model goes to the
// semantic reviewer. It never denies: "not provably recoverable" means
// "review", not "forbidden".

interface Word { text: string; dynamic: boolean; glob: boolean } // dynamic: contains $expansion

// Split into simple commands on && || ; | and newlines. null = syntax we do not
// model: subshells, background &, command/process substitution, file redirection.
function shellSegments(command: string): Word[][] | null {
  // Heredoc bodies are data (commit messages), not commands. A quoted delimiter
  // disables expansion; an unquoted one would run $(...) inside, so forbid it.
  // The usual multi-line commit message, `-m "$(cat <<'EOF' … EOF\n)"`, is a
  // literal too: with a quoted delimiter nothing inside expands, and `cat` of a
  // heredoc only echoes it. Collapse it to a plain word before tokenizing; any
  // other command substitution still falls through to review.
  command = command.replace(/"\$\(cat <<-?\s*(['"])([A-Za-z_][\w-]*)\1\n[\s\S]*?\n\t*\2\n\s*\)"/g, '"heredoc-text"');
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const doc = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(lines[i]);
    if (!doc) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].replace(/^\t+/, "") !== doc[2]) end++;
    if (end === lines.length) return null; // unterminated heredoc
    if (!doc[1] && /[$`]/.test(lines.slice(i + 1, end).join("\n"))) return null;
    i = end;
  }
  const text = kept.join("\n");
  const segments: Word[][] = [[]];
  let word = null as Word | null; // "as": closures below assign it, which narrowing cannot see
  const cur = (): Word => (word ??= { text: "", dynamic: false, glob: false });
  const flush = () => { if (word) segments[segments.length - 1].push(word); word = null; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") { // single quotes: literal
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      cur().text += text.slice(i + 1, end);
      i = end;
    } else if (c === '"') { // double quotes: literal except $ expansion
      const w = cur();
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "`" || (text[j] === "$" && text[j + 1] === "(")) return null;
        if (text[j] === "$") w.dynamic = true;
        if (text[j] === "\\") j++;
        w.text += text[j] ?? "";
      }
      if (j >= text.length) return null;
      i = j;
    } else if (c === "\\") {
      if (text[i + 1] !== "\n" && i + 1 < text.length) cur().text += text[i + 1];
      i++;
    } else if (c === ">" || c === "<" || (c === "&" && text[i + 1] === ">")) {
      if (word && /^\d+$/.test(word.text)) word = null; // "2>": the fd, not an argument
      else flush();
      let op = c === "&" ? "&" : "";
      if (c === "&") i++;
      op += text[i];
      while (/[<>&-]/.test(text[i + 1] ?? "")) op += text[++i];
      while (text[i + 1] === " " || text[i + 1] === "\t") i++;
      let target = "";
      while (i + 1 < text.length && !/[\s;&|<>]/.test(text[i + 1])) target += text[++i];
      if (target.includes("(")) return null; // <(...) process substitution runs a command
      if (op.startsWith("<")) continue; // input redirection and heredocs only read
      if (op.endsWith("&") ? /^[12]$/.test(target) : target.replace(/^['"]|['"]$/g, "") === "/dev/null") continue;
      return null; // redirection into a file writes it
    } else if (c === "`" || c === "(" || c === ")" || c === "{" || c === "}") {
      return null;
    } else if (c === "$") {
      if (text[i + 1] === "(") return null;
      cur().dynamic = true;
      cur().text += c;
    } else if (c === "*" || c === "?" || c === "[") {
      cur().glob = true;
      cur().text += c;
    } else if (c === " " || c === "\t") {
      flush();
    } else if (c === "\n" || c === ";" || c === "|" || c === "&") {
      flush();
      if (c === "&" && text[i + 1] !== "&") return null; // backgrounding outlives the review
      if ((c === "&" || c === "|") && text[i + 1] === c) i++;
      segments.push([]);
    } else {
      cur().text += c;
    }
  }
  flush();
  return segments.filter((words) => words.length > 0);
}

// Pure readers. Flags that turn one into a writer or a code runner are listed.
const READ_ONLY_COMMANDS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "du", "df", "file", "stat",
  "which", "whereis", "type", "echo", "printf", "date", "sort", "cut", "tr", "diff", "cmp", "tree", "jq", "basename", "dirname",
  "realpath", "readlink", "true", "nl", "column", "whoami", "uname", "hostname", "sleep"]);
const WRITING_FLAG = /^(-o|--output(=.*)?|-s|--set(=.*)?|--pre(=.*)?)$/; // sort/tree -o, date -s, rg --pre

const inside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

// Recoverable ground is not just the directory the agent started in: one
// session works across repos (a monorepo, its worktrees) and scratch files.
// Any git work tree is recoverable ground, and temp directories are disposable
// by definition. A repo rooted at home or / (a dotfiles repo) does not count,
// or it would turn the whole home directory into "project".
const TEMP_DIRS = [...new Set([os.tmpdir(), "/tmp"].flatMap((dir) => { try { return [fs.realpathSync(dir)]; } catch { return []; } }))];
export const inTempDir = (target: string): boolean => TEMP_DIRS.some((dir) => inside(dir, target));
const topLevels = new Map<string, string | null>(); // directory → its git work tree, per session
export function gitWorkTree(target: string): string | null {
  let dir: string;
  try { dir = resolveFileTarget(target); } catch { return null; }
  while (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  if (!topLevels.has(dir)) {
    let top: string | null = null;
    try { top = fs.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim()); }
    catch { /* not in a work tree (or inside .git itself) */ }
    topLevels.set(dir, top === os.homedir() || top === path.parse(dir).root ? null : top);
  }
  return topLevels.get(dir)!;
}

// A deletion is recoverable when the target is scratch (inside a temp dir) or
// git calls it disposable in its own repo: ignored (build output, caches) with
// nothing tracked beneath it. Symlinks are left to review: `rm -r link/`
// deletes what the link points at.
function disposable(target: string): boolean {
  try {
    const real = path.join(resolveFileTarget(path.dirname(target)), path.basename(target));
    if (noFlyHit(target) || noFlyHit(real)) return false;
    if (fs.existsSync(real) && fs.lstatSync(real).isSymbolicLink()) return false;
    if (inTempDir(real)) return true;
    const top = gitWorkTree(real);
    if (!top || !inside(top, real)) return false;
    const git = (args: string[]) => execFileSync("git", args, { cwd: top, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const rel = path.relative(top, real);
    git(["check-ignore", "-q", "--", rel]); // exit 1 (throws) unless ignored
    return git(["ls-files", "--", rel]).trim() === "";
  } catch { return false; }
}

// gh subcommands that only read GitHub. `gh api` reads unless a method or a
// field flag (which switches it to POST) is present; tokens are never printed.
function ghEffect(words: string[]): "read" | "write" | null {
  const [noun, verb] = words;
  // Additive, and closable or deletable afterwards, like sending a message.
  if ((noun === "pr" || noun === "issue") && (verb === "create" || verb === "comment")) return "write";
  if (noun === "api") return words.slice(1).some((w) => /^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)/.test(w)) ? null : "read";
  if (noun === "search" || (noun === "--version" && words.length === 1)) return "read";
  if (noun === "auth") return verb === "status" && !words.some((w) => /^(-t|--show-token)$/.test(w)) ? "read" : null;
  return ["pr", "issue", "run", "repo", "release", "workflow", "label"].includes(noun) && ["view", "list", "diff", "checks", "status"].includes(verb) ? "read" : null;
}

// git subcommands by effect: reads, or writes that git itself can undo
// (reflog, index, a normal push that a revert can follow). Discarding
// uncommitted work and rewriting remote history are never here.
function gitEffect(words: string[], inWorkTree: boolean): "read" | "write" | null {
  const [sub, ...rest] = words[0] === "--no-pager" ? words.slice(1) : words;
  const flags = rest.filter((w) => w.startsWith("-"));
  const plain = rest.filter((w) => !w.startsWith("-"));
  const write = inWorkTree ? "write" : null; // reflog and index exist only inside a work tree
  switch (sub) {
    case "status": case "log": case "diff": case "show": case "blame": case "ls-files": case "ls-remote":
    case "rev-parse": case "shortlog": case "describe": case "grep": case "cat-file": case "merge-base": case "rev-list":
    case "for-each-ref": case "show-ref": case "name-rev": case "ls-tree": case "check-ignore": case "cherry": case "range-diff":
      return flags.some((f) => /^(--output(=.*)?|-O.*|--open-files-in-pager.*)$/.test(f)) ? null : "read";
    case "remote": return rest.every((w) => /^(-v|--verbose)$/.test(w)) || (plain[0] === "get-url" && plain.length === 2) ? "read" : null;
    case "config":
      if (rest.length === 1 && /^[\w.-]+$/.test(rest[0]) && !/token|password|secret/i.test(rest[0])) return "read"; // `git config user.name`
      return rest.some((w) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(w))
        && flags.every((f) => /^(--get|--get-all|--get-regexp|--list|-l|--global|--local|--show-origin|--name-only)$/.test(f)) ? "read" : null;
    case "reflog": return rest.length === 0 || plain[0] === "show" ? "read" : null;
    case "branch": case "tag":
      if (flags.every((f) => /^(-a|-r|-v|-vv|--all|--remotes|--list|-l|--show-current|--contains|--merged|--no-merged|--sort=.*|--format=.*)$/.test(f))
        && (plain.length === 0 || flags.some((f) => /^(--list|-l|--contains|--merged|--no-merged)$/.test(f)))) return "read";
      return flags.length === 0 && plain.length <= 2 ? write : null; // create a branch/tag
    case "stash":
      if (plain[0] === "list" || plain[0] === "show") return "read";
      return rest.length === 0 || plain[0] === "push" || plain[0] === "save" ? write : null;
    case "add": case "commit": case "fetch": case "pull": return write;
    case "mv": case "rm": return flags.some((f) => /^(-f|--force)$/.test(f) || /^-[a-z]*f/.test(f)) ? null : write; // git refuses to lose changes without -f
    case "switch": return plain.length === 1 && flags.every((f) => /^(-c|--create)$/.test(f)) ? write : null;
    case "checkout": return /^(-b|-B)$/.test(rest[0] ?? "") && rest.length <= 3 ? write : null; // `checkout <path>` discards edits
    case "reset": return flags.some((f) => /^--(hard|merge|keep)$/.test(f)) ? null : write;
    case "worktree": // remove refuses a dirty worktree without --force, and its branch survives
      if (plain[0] === "list") return "read";
      return plain[0] === "add" || plain[0] === "prune" || (plain[0] === "remove" && !flags.some((f) => /^(-f|--force)$/.test(f))) ? write : null;
    case "push": {
      // A named remote only (a URL could send the code anywhere); no force,
      // no deletion, no +refspec that rewrites the remote's history.
      const [remote, ...refs] = plain;
      return flags.every((f) => /^(-u|--set-upstream|--tags|--follow-tags|-q|--quiet|-v|--verbose)$/.test(f))
        && (!remote || /^[\w.-]+$/.test(remote)) && refs.every((r) => /^[\w./-]+(:[\w./-]+)?$/.test(r)) ? write : null;
    }
    default: return null;
  }
}

// npm verbs that only query the registry or the local tree. `config` is left
// out: `npm config get` can print an auth token.
const NPM_READ = new Set(["view", "info", "show", "v", "whoami", "ls", "list", "outdated", "search", "ping", "help", "explain", "why"]);

// awk as a filter only: no system(), getline, pipes or output redirection.
const awkFilter = (words: string[]) => !words.some((w) => /system|getline|fflush|close\s*\(|[|>]/.test(w));

// null → review. Otherwise the command is recoverable, with readOnly telling
// plan mode whether it changes anything at all.
export function recoverableShell(command: string): { readOnly: boolean; reason: string } | null {
  let root: string;
  try { root = fs.realpathSync(process.cwd()); } catch { return null; }
  // Agents open with `cd "$(git rev-parse --show-toplevel)" &&` or `cd "$(pwd)"`.
  // Both substitutions only read, and at the very start they run in the
  // process cwd, so evaluate them here; later ones stay unknown (→ review).
  const lead = /^\s*cd\s+"\$\((git rev-parse --show-toplevel|pwd)\)"\s*(?=&&|;|$)/.exec(command);
  if (lead) {
    let dir = root;
    if (lead[1] !== "pwd") {
      try { dir = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
      catch { return null; }
    }
    if (/['\n]/.test(dir)) return null;
    command = `cd '${dir}'${command.slice(lead[0].length)}`;
  }
  const segments = shellSegments(command);
  if (!segments?.length) return null;
  let cwd = root; // `cd` changes where later segments act
  let readOnly = true;
  for (const [cmd, ...args] of segments) {
    if (cmd.dynamic || cmd.glob || cmd.text.includes("=")) return null; // VAR=value prefixes change behavior
    const words = args.map((w) => w.text);
    // Reading is recoverable, leaking is not: once a secret is printed it is in
    // every later request. Credential-looking paths go to review.
    if (words.some((w) => SECRET_FILE_RE.test(w) || /(^|\/)(\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc)(\/|$)|credentials|\.git\/config/.test(w))) return null;
    let effect: "read" | "write" | null;
    switch (cmd.text) {
      case "cd": {
        if (args.length > 1 || args.some((w) => w.dynamic || w.glob) || words[0] === "-") return null;
        const target = words[0] ?? "~";
        cwd = target === "~" || target.startsWith("~/") ? path.join(os.homedir(), target.slice(1)) : path.resolve(cwd, target);
        continue;
      }
      case "find": effect = words.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(w)) ? null : "read"; break;
      case "sed": effect = words[0] === "-n" && /^\d+(,(\d+|\$))?p$/.test(words[1] ?? "") && words.slice(2).every((w) => !w.startsWith("-")) ? "read" : null; break;
      case "mkdir": case "touch": effect = "write"; break;
      case "rm": {
        const targets: string[] = [];
        let options = true;
        effect = "write";
        for (const w of args) {
          if (options && w.text === "--") { options = false; continue; }
          if (options && w.text.startsWith("-")) { if (!/^-[rRfv]+$/.test(w.text)) effect = null; continue; }
          if (w.dynamic || w.glob || !w.text) effect = null;
          targets.push(path.resolve(cwd, w.text));
        }
        if (!targets.length || !targets.every((t) => disposable(t))) effect = null;
        break;
      }
      case "git": effect = gitEffect(words, gitWorkTree(cwd) !== null); break;
      case "gh": effect = ghEffect(words); break;
      case "npm": effect = NPM_READ.has(words[0] ?? "") || (words.length === 1 && words[0] === "--version") ? "read" : null; break;
      case "awk": effect = awkFilter(words) ? "read" : null; break;
      case "command": effect = words[0] === "-v" && words.length === 2 ? "read" : null; break; // `command -v gh`: is it installed?
      default:
        if (words.length === 1 && words[0] === "--version" && !cmd.text.includes("/")) { effect = "read"; break; } // an installed tool's version
        effect = READ_ONLY_COMMANDS.has(cmd.text) && !words.some((w) => WRITING_FLAG.test(w)) ? "read" : null;
    }
    if (!effect) return null;
    if (effect === "write") readOnly = false;
  }
  return readOnly ? { readOnly, reason: "read-only command" } : { readOnly, reason: "recoverable: git can undo it, or it only removes gitignored or temp files" };
}

// Decide what a bash command deserves: deny, ask, or allow.
function checkBash(command: string, auto = false): Verdict {
  const summary = command.trim(); // what the user will see in the prompt
  const user = userBashRules(); // the user's configured additions
  // Order is the security model: built-in deny, then user deny, then ask,
  // then allow. A user allow can never jump this queue — allow is checked last.
  // Reading inside .git (hook listings, `-not -path '*/.git/*'` filters) harms
  // nothing, so the .git rule spares provably read-only commands; .git/config
  // (it may embed tokens) is never read-only there. .env/.ssh stay absolute.
  const readOnly = recoverableShell(command)?.readOnly === true;
  for (const [re, why] of BASH_DENY) if (re.test(command) && !(readOnly && why === GIT_DIR_RULE)) return { decision: "deny", reason: why, summary };
  for (const d of user.deny)
    if (command.toLowerCase().includes(d.toLowerCase())) return { decision: "deny", reason: `denied by your settings ("${d}")`, summary };
  // node/npm/npx, git aliases and tool-wide grants can run arbitrary code.
  // Auto mode must inspect the actual command, including background commands.
  if (auto) {
    const recoverable = recoverableShell(command);
    return recoverable ? { decision: "allow", reason: recoverable.reason, summary, readOnly: recoverable.readOnly }
      : { decision: "ask", reason: "auto mode reviews commands whose effects it cannot establish", summary };
  }
  for (const [re, why] of BASH_ASK) if (re.test(command)) return { decision: "ask", reason: why, summary };
  // Compound commands (&&, ;, |, $(), ``) are too hard to reason about — ask.
  if (/[;&|>]|\$\(|`/.test(command)) return { decision: "ask", reason: "compound command or redirection", summary }; // `cat a > b` writes b
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
    case "list_peers": // who else is running — read-only
    case "request_shutdown": // team protocol (Day 39): coordination, no side effects
    case "request_plan":
    case "review_plan":
    case "submit_plan":
    case "create_task": // task board (Day 40): touches the internal board, not the user's project
    case "list_tasks":
    case "claim_task":
    case "complete_task":
    case "ask_user": // asking the user a question is safe in plan mode — it doesn't change anything
    case "skill": // loading a skill's instructions is read-only; what it does is gated per-call
    case "todo_write": // planning is exactly what plan mode is FOR — never block it
    case "bash_output": // reading a background task's output observes, never mutates
    case "list_crons": // listing cron jobs is read-only
    case "exit_plan_mode": // the way OUT of plan mode must never be blocked by plan mode
      return true;
    case "run_bash":
    case "run_bash_background":
      return verdict.decision === "allow" && verdict.readOnly !== false; // auto mode also allows recoverable writes; plan mode must not
    default:
      return false; // write_file, edit_file, MCP and unknown tools: all mutate-or-unknown
  }
}

// ---- The single entry point ---------------------------------------------------
// Called by the loop for EVERY tool call, before anything executes. Plan mode is
// applied as an outer filter: it can only TIGHTEN the base decision (downgrade a
// mutating allow/ask to deny), never loosen one — a base "deny" keeps its more
// specific reason, because deny always wins.
export function checkPermission(toolName: string, argsJson: string, auto = false): Verdict {
  // Bypass skips ordinary approvals, not rule evaluation. Use the stricter
  // path/argument checks too, including resolved symlink targets.
  const base = basePermission(toolName, argsJson, auto || CONFIG.bypassPermissions);
  if (planMode && base.decision !== "deny" && !planSafe(toolName, base)) {
    return {
      decision: "deny",
      reason: "plan mode is on — investigate with read-only tools, then call exit_plan_mode to present a plan for the user to approve before you change anything",
      summary: base.summary,
    };
  }
  if (CONFIG.bypassPermissions && base.decision === "ask" && toolName !== "exit_plan_mode" && toolName !== "ask_user") {
    return { decision: "allow", reason: "permission approvals bypassed for this run", summary: base.summary };
  }
  return base;
}

// The underlying rules, plan-mode-agnostic. Wrapped by checkPermission above.
function basePermission(toolName: string, argsJson: string, auto: boolean): Verdict {
  // A user-configured tool block beats everything, including built-in allows.
  if (CONFIG.permissions.deny.includes(`tool:${toolName}`)) {
    return { decision: "deny", reason: `tool blocked by your settings ("tool:${toolName}")`, summary: toolName };
  }

  let args: Record<string, string>; // the parsed tool arguments
  try {
    args = JSON.parse(argsJson); // arguments arrive as a raw JSON string from the model
    if (auto && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return { decision: "deny", reason: "tool arguments must be an object", summary: toolName };
    }
  } catch {
    // Let dispatch produce the proper JSON error for the model.
    if (auto) return { decision: "deny", reason: "invalid JSON arguments", summary: toolName };
    return { decision: "allow", reason: "unparseable args", summary: toolName };
  }

  if (auto && ["read_file", "write_file", "edit_file"].includes(toolName)) {
    if (typeof args.path !== "string" || !args.path.trim()) return { decision: "deny", reason: "a non-empty file path is required", summary: toolName };
    try {
      const resolved = resolveFileTarget(args.path);
      const reason = toolName === "read_file"
        ? (SECRET_FILE_RE.test(path.resolve(args.path)) || SECRET_FILE_RE.test(resolved) ? "file path contains secrets" : null)
        : noFlyHit(args.path) || noFlyHit(resolved);
      if (reason) return { decision: "deny", reason, summary: args.path };
      const relative = path.relative(fs.realpathSync(process.cwd()), resolved);
      // Outside the start directory is still recoverable in another git work
      // tree or a temp dir (git, /undo); anywhere else a human decides.
      if (toolName !== "read_file" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) && !inTempDir(resolved) && !gitWorkTree(resolved)) {
        return { decision: "ask", requiresHuman: true, reason: "resolved write target is outside the project", summary: `${args.path} → ${resolved}` };
      }
    } catch {
      return { decision: "deny", reason: "cannot resolve the file target safely", summary: args.path };
    }
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
    case "list_peers":
      // Reading the local session registry — observes, changes nothing.
      return { decision: "allow", reason: "lists local sessions, read-only", summary: "list_peers" };
    case "request_shutdown":
    case "request_plan":
    case "review_plan":
    case "submit_plan":
      // Team protocol messages (Day 39) — request/response coordination over the
      // mailbox. No filesystem effect; the work they gate still passes the gate.
      return { decision: "allow", reason: "team protocol, no side effects", summary: toolName };
    case "create_task":
    case "list_tasks":
    case "claim_task":
    case "complete_task":
      // Task board (Day 40) — bookkeeping on the internal board, not the user's
      // project. The actual work a claimed task drives still passes this gate.
      return { decision: "allow", reason: "task board, no project side effects", summary: toolName };
    case "update_goal":
      // /goal (Day 41) — ends the user's goal. Bookkeeping; the only command it
      // runs is the user's own /goal --check, which the model cannot change.
      return { decision: "allow", reason: "goal bookkeeping, runs only the user's own --check", summary: toolName };
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
      if (!auto && CONFIG.permissions.allow.includes(`tool:${toolName}`)) {
        return { decision: "allow", reason: "pre-approved by your settings", summary: p };
      }
      // Auto mode: the target already resolved inside the project (checked
      // above), where git and /undo can take any edit back.
      if (auto) return { decision: "allow", reason: "recoverable: edit in a git work tree or temp dir (git, /undo)", summary: p };
      return { decision: "ask", reason: "writes to your filesystem", summary: p }; // normal writes need a human yes
    }
    case "run_bash":
    case "run_bash_background": {
      // Backgrounding changes WHEN output comes back, never WHAT runs — so a
      // background command gets the exact same input-aware analysis as a
      // foreground one. The danger is in the command, not the blocking.
      if (auto && typeof args.command !== "string") return { decision: "deny", reason: "a shell command is required", summary: toolName };
      const verdict = checkBash(args.command ?? "", auto); // bash gets input-aware analysis
      // "Don't ask again for run_bash this session" (chosen in the approval menu)
      // upgrades an ASK to ALLOW — but a hard DENY (rm -rf /, .git, .env…) always
      // stands. Convenience never overrides the no-fly rules. A grant for either
      // shell tool covers the other: the command is what was vouched for.
      if (!auto && verdict.decision === "ask" && (CONFIG.permissions.allow.includes(`tool:${toolName}`) || CONFIG.permissions.allow.includes("tool:run_bash"))) {
        return { decision: "allow", reason: "bash pre-approved for this session", summary: verdict.summary };
      }
      return verdict;
    }
    case "bash_output":
      // Polling a background task only reads its captured output and status —
      // it touches nothing on the user's filesystem. Always safe.
      return { decision: "allow", reason: "reads background task output, no side effects", summary: args.task_id ?? "bash_output" };
    case "schedule_cron":
      // Scheduling a cron job writes to .mini-agent/scheduled_tasks.json and
      // drives future work — worth a confirmation prompt.
      return { decision: "ask", reason: "schedules a recurring task", summary: `${args.cron ?? ""} → ${args.prompt ?? ""}` };
    case "list_crons":
      // Listing cron jobs reads in-memory state only — no side effects.
      return { decision: "allow", reason: "read-only, no side effects", summary: "list_crons" };
    case "cancel_cron":
      // Cancelling a cron job modifies internal state and may write to disk.
      return { decision: "ask", reason: "cancels a scheduled task", summary: args.id ?? "cancel_cron" };
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
      // The grant holds in auto mode too: the user vouched for the tool itself,
      // e.g. a message send they can delete. Shell grants are never honored in
      // auto mode (see run_bash) — there the command, not the tool, decides.
      if (CONFIG.permissions.allow.includes(`tool:${toolName}`)) {
        return { decision: "allow", reason: "pre-approved by your settings", summary: toolName };
      }
      return { decision: "ask", reason: toolName.startsWith("mcp__") ? "external MCP tool" : "unknown tool", summary: toolName };
  }
}

// New files need their nearest existing parent resolved too: a symlinked
// directory must not hide a write into .git or another protected location.
function resolveFileTarget(target: string): string {
  let current = path.resolve(target);
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("No existing ancestor");
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}

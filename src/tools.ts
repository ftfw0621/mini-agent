import fs from "node:fs"; // filesystem reads and writes
import path from "node:path"; // path resolution and joining
import { execSync } from "node:child_process"; // runs a shell command and waits for it
import type OpenAI from "openai"; // types only — no client is created here

// ============ Session state ============
// The foundation of "read before edit": which files has this session actually read?
// Files that were never read must not be edited — otherwise the model edits from
// (possibly stale) memory and wrecks the file.
// A Map instead of a Set since Day 5: the touch order ranks files for recovery
// after compaction (most recently touched = most likely needed next).
// A monotonic counter, not Date.now(): two reads in the same millisecond would
// get identical wall-clock stamps and the ordering would be arbitrary.
let touchCounter = 0; // increments on every read/write — strictly ordered
const readFiles = new Map<string, number>(); // absolute path → touch sequence number

const TOOL_RESULT_LIMIT = 4000; // cap (chars) for a normal tool result entering the context
const READ_LIMIT = 16000; // read_file gets a larger cap of its own
const SEARCH_MAX_MATCHES = 50; // max matches returned by search
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]); // directories search never enters

// A tool = a manual for the model to read (definition) + code that does the work (run).
export interface Tool {
  definition: OpenAI.ChatCompletionTool; // the machine-readable manual
  run: (args: Record<string, string>) => string; // the implementation — always returns text
}

// Errors are not exceptions — they are text that tells the model what to do next.
const fail = (msg: string) => `[error] ${msg}`;

// Small helper to build a tool definition without repeating boilerplate.
function def(
  name: string, // tool name the model calls
  description: string, // the manual: what / boundaries / preconditions / on error
  properties: Record<string, { type: string; description: string }>, // parameter schema
  required: string[], // which parameters are mandatory
): OpenAI.ChatCompletionTool {
  return {
    type: "function", // the only tool type the chat API supports
    function: { name, description, parameters: { type: "object", properties, required } },
  };
}

// ============ read_file ============
const readFile: Tool = {
  definition: def(
    "read_file",
    `Read the full content of a text file.
Boundaries: text files only; content beyond ${READ_LIMIT} chars is truncated; do not use it on binaries like images.
Precondition: before editing a file (edit_file) or overwriting an existing one (write_file), you MUST read it with this tool first.
On error: a missing file returns an error — check the path and retry.
ALWAYS use this tool to read files. NEVER run cat/head/tail via run_bash.`,
    { path: { type: "string", description: "File path (absolute or relative)" } },
    ["path"],
  ),
  run: (args) => {
    const p = path.resolve(args.path); // normalize to an absolute path
    if (!fs.existsSync(p)) return fail(`File not found: ${p}. Check the path — you can locate files with search.`); // wrong path → tell the model how to find it
    if (!fs.statSync(p).isFile()) return fail(`${p} is a directory, not a file.`); // directories are not readable
    const content = fs.readFileSync(p, "utf8"); // read the whole file as text
    readFiles.set(p, ++touchCounter); // remember: this session has read this file (unlocks edit/overwrite)
    if (content.length > READ_LIMIT) {
      return content.slice(0, READ_LIMIT) + `\n... (file is ${content.length} chars, truncated)`; // cap huge files, but say so
    }
    return content || "(empty file)"; // the API rejects empty strings — always return something
  },
};

// ============ write_file ============
const writeFile: Tool = {
  definition: def(
    "write_file",
    `Create a new file, or fully overwrite an existing one.
Boundaries: the whole file is replaced by content; to change a small part of a file use edit_file instead — do not rewrite whole files.
Precondition: overwriting an existing file requires reading it with read_file first. Writes may require user approval.
On error: follow the error message — read the file first, then retry.`,
    {
      path: { type: "string", description: "File path; parent directories are created automatically" },
      content: { type: "string", description: "The complete new content of the file" },
    },
    ["path", "content"],
  ),
  run: (args) => {
    const p = path.resolve(args.path); // normalize to an absolute path
    if (fs.existsSync(p) && !readFiles.has(p)) {
      return fail(`${p} already exists but you have not read it. Use read_file to check its current content before overwriting.`); // no blind overwrites
    }
    fs.mkdirSync(path.dirname(p), { recursive: true }); // create parent directories as needed
    fs.writeFileSync(p, args.content, "utf8"); // write the new content
    readFiles.set(p, ++touchCounter); // you wrote it, so you know its content — counts as read
    return `Wrote ${p} (${args.content.length} chars)`; // confirm with the size as a sanity check
  },
};

// ============ edit_file ============
const editFile: Tool = {
  definition: def(
    "edit_file",
    `Replace one exact string in a file: old_string → new_string.
Boundaries: old_string must match the file content exactly (including whitespace and indentation) and must be unique in the file; if it is not unique, include a few surrounding lines as context.
Precondition: you MUST have read the file with read_file first. Edits may require user approval.
On error: "not found" means old_string does not match the file — re-read and copy it exactly; "not unique" means include more surrounding context.
ALWAYS use this tool to edit files. NEVER use sed/awk or shell redirection via run_bash.`,
    {
      path: { type: "string", description: "Path of the file to edit" },
      old_string: { type: "string", description: "The exact text to replace (must be unique)" },
      new_string: { type: "string", description: "The replacement text" },
    },
    ["path", "old_string", "new_string"],
  ),
  run: (args) => {
    const p = path.resolve(args.path); // normalize to an absolute path
    if (!fs.existsSync(p)) return fail(`File not found: ${p}`); // can't edit what isn't there
    if (!readFiles.has(p)) {
      return fail(`You have not read ${p} yet. Use read_file first and edit based on its real content.`); // the read-before-edit rule
    }
    if (args.old_string === args.new_string) return fail(`old_string and new_string are identical — nothing to change.`); // pointless edit, don't waste a round
    const content = fs.readFileSync(p, "utf8"); // current file content
    const count = content.split(args.old_string).length - 1; // how many times old_string occurs
    if (count === 0) {
      return fail(`old_string not found in the file. It must match exactly (including whitespace and indentation) — re-read the file and copy it precisely.`); // model's memory is stale → re-read
    }
    if (count > 1) {
      return fail(`old_string appears ${count} times — ambiguous. Include a few surrounding lines to make it unique.`); // refuse to guess which one
    }
    // Note: content.replace(old, newStr) would expand $& $' etc. in newStr as special
    // replacement patterns — pass a function so the replacement is taken literally.
    fs.writeFileSync(p, content.replace(args.old_string, () => args.new_string), "utf8"); // apply the single replacement
    return `Edited ${p}: 1 replacement made.`; // confirm exactly what happened
  },
};

// ============ search ============
// Convert a shell-style glob (*.ts) into a regex for file-name filtering.
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"); // escape regex chars, then * → .*
  return new RegExp(`^${escaped}$`); // anchor so the whole name must match
}

// Recursively yield every file under dir, skipping junk and hidden entries.
function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) yield* walk(path.join(dir, entry.name)); // recurse, but never into node_modules/.git/hidden dirs
    } else if (entry.isFile() && !entry.name.startsWith(".")) {
      // dotfiles (.env and friends) often hold secrets — search never surfaces them
      yield path.join(dir, entry.name);
    }
  }
}

const search: Tool = {
  definition: def(
    "search",
    `Search file contents under a directory with a regex. Returns a list of "file:line: content" matches.
Boundaries: skips node_modules/.git/hidden dirs/binary files; returns at most ${SEARCH_MAX_MATCHES} matches; results are locations only — use read_file to see full content.
On error: an invalid regex returns an error; on "no matches", loosen the pattern or widen the directory and retry.
ALWAYS use this tool to search. NEVER run grep/rg/find via run_bash.`,
    {
      pattern: { type: "string", description: "The regex to search for" },
      path: { type: "string", description: "Directory to start from, defaults to the current directory" },
      file_glob: { type: "string", description: "Only search files whose name matches, e.g. *.ts (optional)" },
    },
    ["pattern"],
  ),
  run: (args) => {
    const dir = path.resolve(args.path || "."); // default to the current directory
    if (!fs.existsSync(dir)) return fail(`Directory not found: ${dir}`); // bad starting point
    let regex: RegExp; // the compiled search pattern
    try {
      regex = new RegExp(args.pattern); // compile the model's pattern
    } catch (e) {
      return fail(`Invalid regex: ${(e as Error).message}`); // bad pattern → tell the model to fix it
    }
    const nameFilter = args.file_glob ? globToRegex(args.file_glob) : null; // optional file-name filter
    const matches: string[] = []; // accumulated "file:line: content" lines
    for (const file of walk(dir)) {
      if (nameFilter && !nameFilter.test(path.basename(file))) continue; // skip files the glob excludes
      if (fs.statSync(file).size > 1_000_000) continue; // skip huge files (logs, bundles)
      const text = fs.readFileSync(file, "utf8"); // read the candidate file
      if (text.includes("\0")) continue; // skip binaries (NUL byte = not text)
      const lines = text.split("\n"); // search line by line
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${path.relative(dir, file)}:${i + 1}: ${lines[i].trim()}`); // record location + the matching line
          if (matches.length >= SEARCH_MAX_MATCHES) {
            return matches.join("\n") + `\n... (hit the ${SEARCH_MAX_MATCHES}-match cap, narrow your pattern)`; // stop early, tell the model why
          }
        }
      }
    }
    return matches.length ? matches.join("\n") : "No matches. Loosen the pattern or try another directory."; // empty result still guides the next step
  },
};

// ============ run_bash ============
const runBash: Tool = {
  definition: def(
    "run_bash",
    `Run a bash command on the user's machine (30s timeout) and return its output.
Boundaries: only for things that truly need execution — installing dependencies, running tests/scripts, git operations.
To read files use read_file (not cat), to search use search (not grep/find), to edit files use edit_file (not sed/redirection).
Dangerous commands require user approval; some are denied outright. A [permission] result is a hard boundary — never try to work around it.
On error: failures return the error output — analyze it and try a different approach; do not resend the same command unchanged.`,
    { command: { type: "string", description: "The bash command to run" } },
    ["command"],
  ),
  run: (args) => {
    try {
      // stderr is piped (not inherited): it belongs in the tool result for the
      // model to read, not splattered onto the user's terminal.
      const out = execSync(args.command, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      return out || "(command succeeded, no output)"; // never return an empty string
    } catch (err) {
      const e = err as Error & { stderr?: string }; // execSync attaches the captured stderr on failure
      return fail(`Command failed: ${e.message}${e.stderr ? `\nstderr: ${e.stderr.slice(0, 1000)}` : ""}`); // failure becomes guidance, not a crash
    }
  },
};

// ============ Registry & dispatch ============
// One place that knows every tool. Adding a tool = adding one entry here.
export const tools: Record<string, Tool> = {
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  search,
  run_bash: runBash,
};

// The list of manuals sent to the model on every API call.
export const toolDefinitions = Object.values(tools).map((t) => t.definition);

// Single entry point: every failure becomes text fed back to the model.
// It never throws — the main loop must never die because of a tool.
export function dispatch(name: string, argsJson: string): string {
  const tool = tools[name]; // look the tool up by name
  if (!tool) return fail(`Unknown tool: ${name}. Available tools: ${Object.keys(tools).join(", ")}`); // model hallucinated a tool → list the real ones
  let args: Record<string, string>; // the parsed arguments
  try {
    args = JSON.parse(argsJson); // arguments arrive as a raw JSON string
  } catch {
    return fail(`Arguments are not valid JSON: ${argsJson.slice(0, 200)}`); // malformed JSON → show what we got
  }
  try {
    return tool.run(args).slice(0, name === "read_file" ? READ_LIMIT + 100 : TOOL_RESULT_LIMIT); // run it, cap the result size
  } catch (err) {
    return fail(`Tool crashed: ${(err as Error).message}`); // even a crashing tool becomes a readable result
  }
}

// ============ File-state queries (used by compaction recovery) ============
// The most recently touched files, newest first.
export function recentFiles(limit: number): string[] {
  return [...readFiles.entries()] // [path, sequence] pairs
    .sort((a, b) => b[1] - a[1]) // newest first
    .slice(0, limit) // top N only
    .map(([p]) => p); // just the paths
}

// Evict everything except the given paths. After compaction, a file the model
// can no longer see must also lose its "already read" status — otherwise the
// model could edit it based on content that is no longer in the conversation.
export function forgetFilesExcept(keep: string[]): void {
  const keepSet = new Set(keep); // for O(1) lookup
  for (const p of [...readFiles.keys()]) if (!keepSet.has(p)) readFiles.delete(p); // drop the rest
}

// Snapshot / restore the read-state around a sub-agent run. The sub-agent
// shares this module's state, but what IT read was never seen by the parent's
// conversation — restoring the snapshot keeps read-before-edit honest across
// agent boundaries.
export function snapshotFileState(): Map<string, number> {
  return new Map(readFiles); // shallow copy is enough — values are numbers
}
export function restoreFileState(snapshot: Map<string, number>): void {
  readFiles.clear(); // drop whatever the sub-agent read or wrote
  for (const [p, seq] of snapshot) readFiles.set(p, seq); // bring back the parent's view
}

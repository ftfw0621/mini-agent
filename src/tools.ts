import fs from "node:fs"; // filesystem reads and writes
import os from "node:os"; // temp dir for spilled tool output
import path from "node:path"; // path resolution and joining
import { spawn } from "node:child_process"; // async process execution (does NOT block the event loop)
import type OpenAI from "openai"; // types only — no client is created here
import { validateArgs, type ParamSchema } from "./validate.js"; // schema validation for tool arguments
import { setPlanMode } from "./permissions.js"; // plan mode (Day 20): exit_plan_mode flips it off on approval
import { recordMutation } from "./undo.js"; // capture the before-state so /undo (Day 22) can restore it
import { parseTodos, setTodos, summarizeTodos } from "./todos.js"; // the agent's own checklist (Day 36)
import { startBackground, readBackground } from "./background.js"; // long-running commands that outlive the turn (Day 37)
import { scheduleJob, cancelJob, listJobs } from "./cron.js"; // cron scheduler (Day s14): scheduled, recurring work

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

const BASH_TIMEOUT_MS = 30_000; // a single command may run this long before we kill it
const BASH_OUTPUT_LIMIT = 8_000; // chars of command output kept inline; beyond this we spill to a file
const SPILL_NOTE_SLACK = 400; // room for the "[...saved to FILE]" note so dispatch's cap never eats it

// A tool = a manual for the model to read (definition) + code that does the work
// (run). Since Day 13, run may be async (run_bash spawns a process) and may
// receive an AbortSignal so a long command dies with Ctrl+C instead of running
// to its 30s timeout. We use the function-tool variant specifically (not the
// custom-tool one) so .function.name is always available.
export interface Tool {
  definition: OpenAI.ChatCompletionFunctionTool; // the machine-readable manual
  run: (args: Record<string, string>, signal?: AbortSignal) => string | Promise<string>; // returns text (or a promise of it)
}

// Errors are not exceptions — they are text that tells the model what to do next.
const fail = (msg: string) => `[error] ${msg}`;

// Small helper to build a tool definition without repeating boilerplate.
function def(
  name: string, // tool name the model calls
  description: string, // the manual: what / boundaries / preconditions / on error
  properties: Record<string, { type: string; description: string }>, // parameter schema
  required: string[], // which parameters are mandatory
): OpenAI.ChatCompletionFunctionTool {
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
    recordMutation(p); // snapshot the previous state (or "didn't exist") for /undo, before we overwrite
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
    recordMutation(p); // snapshot the pre-edit content for /undo, before we change it
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
// Spill oversized output to a file and hand the model a preview + the path, so
// it can read_file deeper if it wants. Returning megabytes inline would blow up
// the context; truncating silently would hide the part that matters.
function spillIfHuge(out: string, what: string): string {
  if (out.length <= BASH_OUTPUT_LIMIT) return out; // fits inline — return as-is
  const file = path.join(os.tmpdir(), `mini-agent-output-${Date.now()}.txt`); // a stable place to find it
  fs.writeFileSync(file, out, "utf8"); // the full output lives on disk
  const head = out.slice(0, BASH_OUTPUT_LIMIT); // a generous preview
  return `${head}\n\n[...${what} truncated: ${out.length} chars total. Full output saved to ${file} — use read_file to inspect more.]`;
}

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
  // Async + spawn: the event loop stays responsive while the command runs, so
  // the spinner keeps spinning and Ctrl+C is heard. execSync would freeze
  // everything — the whole process, the UI, the signal handler — until it
  // returned. The AbortSignal lets the loop kill the child on interruption
  // instead of waiting out the 30s timeout.
  run: (args, signal) =>
    new Promise<string>((resolve) => {
      const child = spawn(args.command, { shell: true, stdio: ["ignore", "pipe", "pipe"] }); // shell:true → bash semantics
      let stdout = ""; // captured stdout
      let stderr = ""; // captured stderr (for the model, not the user's terminal)
      let settled = false; // resolve exactly once
      const done = (text: string) => {
        if (settled) return; // guard against timeout/exit/abort racing
        settled = true;
        clearTimeout(timer); // stop the watchdog
        signal?.removeEventListener("abort", onAbort); // unhook
        resolve(text); // hand the result back
      };
      // Hard timeout: SIGKILL the whole process group, never hang the agent.
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(fail(`Command timed out after ${BASH_TIMEOUT_MS / 1000}s and was killed.${stdout ? `\npartial stdout:\n${stdout.slice(0, 2000)}` : ""}`));
      }, BASH_TIMEOUT_MS);
      // Ctrl+C while a command runs: kill the child immediately.
      const onAbort = () => {
        child.kill("SIGKILL");
        done(fail("Command was interrupted by the user."));
      };
      signal?.addEventListener("abort", onAbort);
      child.stdout.on("data", (d) => (stdout += d)); // accumulate
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => done(fail(`Could not start command: ${err.message}`))); // e.g. command not found at the spawn level
      child.on("close", (code) => {
        if (code === 0) {
          done(spillIfHuge(stdout, "output") || "(command succeeded, no output)"); // success
        } else {
          // Non-zero exit: combine streams so the model sees the actual error.
          const combined = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join("\n");
          done(fail(`Command exited with code ${code}.\n${spillIfHuge(combined, "error output")}`));
        }
      });
    }),
};

// ============ run_bash_background (Day 37) ============
// run_bash blocks and dies at its 30s watchdog — useless for anything truly
// slow. This is its asynchronous twin: it spawns the command and returns a task
// id IMMEDIATELY, so the agent keeps reasoning while the work happens. The loop
// injects a <task_notification> when the command finishes (background.ts). Use
// it for installs, builds, full test runs, or servers that never exit — exactly
// the keywords that signal a slow operation. The command goes through the SAME
// permission gate as run_bash (see permissions.ts), so the danger rules are
// identical; only the blocking behavior differs.
const runBashBackground: Tool = {
  definition: def(
    "run_bash_background",
    `Run a slow bash command in the BACKGROUND and return immediately with a task id (e.g. bg_1) — do NOT wait for it.
When to use: anything that would exceed run_bash's 30s limit or block you — installing dependencies (npm/pip install), builds (npm run build, cargo build, make), full test suites (pytest, npm test), deploys, or long-running servers (npm run dev) that never exit.
What you get back: just the task id. The command keeps running. When it finishes you'll receive a <task_notification> with its status and output tail — react to that. For a server or a job still running, poll it with bash_output.
Boundaries & permissions are identical to run_bash (dangerous commands are still gated or denied). For quick commands use run_bash instead — waiting on a one-off background job wastes a turn.`,
    { command: { type: "string", description: "The bash command to run in the background" } },
    ["command"],
  ),
  // Fire-and-return: start the process, hand back the id. The output is captured
  // by background.ts and delivered later as a notification — never inline here.
  run: (args) => {
    const id = startBackground(args.command);
    return `Started background task ${id}: ${args.command}\nIt is running now; you will get a <task_notification> when it finishes. Keep working — use bash_output with task_id "${id}" to check on it (e.g. to confirm a server came up).`;
  },
};

// ============ bash_output (Day 37) ============
// Poll a background task: its status and any output produced since the last
// poll. Essential for the case a notification can never cover — a server that
// runs forever (npm run dev) never "finishes", so the only way to see "ready on
// :3000" is to read its output. Reading advances a per-task cursor, so repeated
// polls show only what's new, not the whole log every time.
// ============ schedule_cron (Day s14) ============
const scheduleCron: Tool = {
  definition: def(
    "schedule_cron",
    `Schedule a recurring or one-shot task in the BACKGROUND using a 5-field cron expression.
Boundaries: max 50 jobs; the scheduler checks every second and delivers the prompt when the cron matches.
Cron format: minute hour day-of-month month day-of-week. Supports *, */N, N, N-M, N,M,….
Examples: "0 9 * * *" = every day at 9:00; "*/5 * * * *" = every 5 minutes; "0 9 * * 1-5" = weekdays at 9:00.

IMPORTANT — the "prompt" parameter is what you (the agent) will receive when the job fires.
Put the user's FULL INTENT here — a complete self-contained instruction that tells you what to do.
Do NOT just repeat the cron expression — describe the actual task in natural language, as if the user
was saying it to you directly. Include what to execute, what to check, and how to report back.

Examples of good prompts:
  "Print 'ftfw' to the terminal by running echo ftfw, then report the output."
  "Run 'npm test' and report how many tests passed/failed."
  "Check if the dev server on :3000 is reachable via curl, report UP or DOWN."
  "Check disk usage with df -h, report the / partition usage percentage."`,
    {
      cron: { type: "string", description: '5-field cron expression: "0 9 * * *" = daily at 9am, "*/5 * * * *" = every 5 min' },
      prompt: { type: "string", description: "The FULL task instruction you will receive when this fires — a self-contained description of what to do and how to report results" },
      recurring: { type: "string", description: '"true" (default) = repeat, "false" = one-shot' },
      durable: { type: "string", description: '"true" (default) = persist to disk, "false" = session-only' },
    },
    ["cron", "prompt"],
  ),
  run: (args) => {
    const recurring = args.recurring !== "false";
    const durable = args.durable !== "false";
    const result = scheduleJob(args.cron, args.prompt, recurring, durable);
    if (typeof result === "string") {
      return `Scheduled cron job ${result}: "${args.cron}" → "${args.prompt}"${recurring ? " (recurring)" : " (one-shot)"}${durable ? " (durable)" : " (session-only)"}`;
    }
    return fail(result.error);
  },
};

// ============ list_crons (Day s14) ============
const listCrons: Tool = {
  definition: def(
    "list_crons",
    "List all currently scheduled cron jobs (both durable and session-only). Returns id, cron expression, prompt, and flags.",
    {},
    [],
  ),
  run: () => {
    const jobs = listJobs();
    if (!jobs.length) return "No cron jobs scheduled.";
    return jobs
      .map((j) => `${j.id}: "${j.cron}" → "${j.prompt}"${j.recurring ? " (recurring)" : " (one-shot)"}${j.durable ? " (durable)" : " (session-only)"}`)
      .join("\n");
  },
};

// ============ cancel_cron (Day s14) ============
const cancelCron: Tool = {
  definition: def(
    "cancel_cron",
    "Cancel a scheduled cron job by its id (from list_crons). Returns whether the job was found and removed.",
    { id: { type: "string", description: "The cron job id to cancel, e.g. 'cron_1'" } },
    ["id"],
  ),
  run: (args) => {
    const ok = cancelJob(args.id);
    return ok ? `Cancelled cron job ${args.id}.` : fail(`Cron job not found: ${args.id}. Use list_crons to see scheduled jobs.`);
  },
};

const bashOutput: Tool = {
  definition: def(
    "bash_output",
    `Check on a background task started with run_bash_background: returns its status and any NEW output since you last checked.
When to use: to see if a long job is done, or to read a long-running server's output (e.g. confirm "listening on :3000"). A finished task also sends you a <task_notification> automatically — you don't need to poll just to learn it ended.
Pass full=true to get the entire captured log instead of only the new lines. On an unknown task id you'll get the list of ids that exist.`,
    {
      task_id: { type: "string", description: "The background task id, e.g. bg_1" },
      full: { type: "boolean", description: "Return the entire captured output instead of only new output since the last check (default false)" },
    },
    ["task_id"],
  ),
  run: (args) => {
    const full = (args as { full?: unknown }).full === true; // optional boolean
    return spillIfHuge(readBackground(args.task_id, full), "background output");
  },
};

// ============ exit_plan_mode ============
// Plan mode (Day 20) makes the agent research-only: the permission gate blocks
// every mutating tool until the model presents a plan the user approves. The
// model calls this when its plan is ready; the gate turns it into an "ask", so
// the user sees the plan first. run() executes ONLY after the user says yes —
// so reaching this code IS the approval, and the one thing it does is leave plan
// mode. Outside plan mode the gate makes it a harmless no-op allow.
const exitPlanMode: Tool = {
  definition: def(
    "exit_plan_mode",
    `Leave plan mode and start implementing. Call this ONLY when you are in plan mode and have finished investigating with read-only tools.
Pass your plan as markdown in "plan"; the user is shown it and asked to approve. Do NOT call it to ask a question, and not before you have a concrete, ordered plan.
On approval, plan mode turns off and writing/executing tools become available. If declined, you stay in plan mode — refine the plan and try again.`,
    { plan: { type: "string", description: "The implementation plan, as concise ordered markdown steps" } },
    ["plan"],
  ),
  run: () => {
    setPlanMode(false); // run() only happens after the user approved — leave plan mode so implementation can begin
    return "Plan approved by the user. Plan mode is OFF — implement the plan now; writing and executing tools are available again.";
  },
};

// ============ todo_write ============
// The agent's planning tool (Day 36). The model sends the WHOLE list each time
// (it replaces the previous one); we store it, show it, and hand back a one-line
// tally. The array-of-objects schema is built by hand — the `def()` helper only
// does flat string params. State + rendering + the nag live in todos.ts.
const todoWrite: Tool = {
  definition: {
    type: "function",
    function: {
      name: "todo_write",
      description: `Record and update a short plan for the CURRENT task as a checklist. This adds planning, NOT new abilities — it changes nothing on disk.
When to use: a task with 3+ distinct steps, or whenever the user gives several requirements. Skip it for trivial one-step asks.
How: pass the COMPLETE list every time (it replaces the previous one). Keep AT MOST ONE item in_progress. As you work, flip items to completed and move the next to in_progress — an out-of-date list is worse than none.`,
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The complete todo list, in order. Replaces the previous list.",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "The step, phrased as an action" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "pending | in_progress | completed (only one in_progress)" },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  run: (args) => {
    const parsed = parseTodos((args as { todos?: unknown }).todos); // validate the model's list
    if (parsed.error) return fail(parsed.error); // precise repair message, not a crash
    setTodos(parsed.todos!); // store it (resets the nag clock); the loop renders it to the screen
    return summarizeTodos(parsed.todos!); // concise tally back to the model — the pretty list is for the human
  },
};

// ============ Registry & dispatch ============
// The built-in tools. External tools (MCP servers, Day 15) are registered into
// the same record at startup, so they flow through the same dispatch and the
// same permission gate — there is exactly one execution path, no matter where a
// tool came from.
export const tools: Record<string, Tool> = {
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  search,
  run_bash: runBash,
  run_bash_background: runBashBackground,
  bash_output: bashOutput,
  schedule_cron: scheduleCron,
  list_crons: listCrons,
  cancel_cron: cancelCron,
  exit_plan_mode: exitPlanMode,
  todo_write: todoWrite,
};

// Register an external tool (e.g. one discovered from an MCP server). Kept in
// the same `tools` record so dispatch, the permission gate, and the tool-list
// sent to the model all treat it identically to a built-in.
export function registerExternalTool(tool: Tool): void {
  tools[tool.definition.function.name] = tool;
}

// The manuals sent to the model. A function (not a const) since Day 15: MCP
// tools register after module load, so the list must be computed when asked.
export function toolDefinitions(): OpenAI.ChatCompletionTool[] {
  return Object.values(tools).map((t) => t.definition);
}

// Read-only tools never touch the filesystem in a conflicting way, so the loop
// is free to run a batch of them concurrently. Anything that writes or executes
// (including any external/MCP tool, which we cannot reason about) runs alone, in
// order. (See loop.ts for the batching.)
const READ_ONLY_TOOLS = new Set(["read_file", "search"]);
export const isReadOnlyTool = (name: string): boolean => READ_ONLY_TOOLS.has(name);

// Single entry point: every failure becomes text fed back to the model.
// It never throws — the main loop must never die because of a tool. Async since
// Day 13 so run_bash can spawn without blocking; the signal lets Ctrl+C kill a
// running command.
export async function dispatch(name: string, argsJson: string, signal?: AbortSignal): Promise<string> {
  const tool = tools[name]; // look the tool up by name
  if (!tool) return fail(`Unknown tool: ${name}. Available tools: ${Object.keys(tools).join(", ")}`); // model hallucinated a tool → list the real ones
  let args: Record<string, string>; // the parsed arguments
  try {
    args = JSON.parse(argsJson); // arguments arrive as a raw JSON string
  } catch {
    return fail(`Arguments are not valid JSON: ${argsJson.slice(0, 200)}`); // malformed JSON → show what we got
  }
  // Validate against the tool's declared schema BEFORE running it. The model's
  // arguments are probabilistic — a missing required field or a wrong type gets
  // a precise repair message here instead of a cryptic crash inside the tool
  // (or, for MCP tools, a wasted round-trip to the server).
  const problems = validateArgs(tool.definition.function.parameters as ParamSchema | undefined, args);
  if (problems.length) {
    return fail(`Invalid arguments for ${name}: ${problems.join("; ")}. Fix and call again.`);
  }
  // Each tool gets a result cap sized to its job. run_bash already manages its
  // own output (preview + spill-to-disk via spillIfHuge); its cap must leave
  // room for the spill note, or dispatch would chop off the very pointer the
  // model needs to read the rest.
  const cap = name === "read_file" ? READ_LIMIT + 100 : name === "run_bash" || name === "bash_output" ? BASH_OUTPUT_LIMIT + SPILL_NOTE_SLACK : TOOL_RESULT_LIMIT;
  try {
    const result = await tool.run(args, signal); // await covers both sync and async tools
    return result.slice(0, cap); // cap the result size
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

// ============ Background tasks (Day 37) ============
// The problem: run_bash blocks. A command that takes longer than its 30s
// watchdog (npm install, a full test run, a build) is SIGKILLed before it
// finishes, and even a 25s one freezes the agent — we sit idle, paying for
// tokens we aren't using, while a child process churns. The model cannot think
// and wait at the same time.
//
// The fix, mirroring Claude Code: a command can be sent to the BACKGROUND. We
// spawn it, hand the model a task id immediately, and let the loop keep going.
// When the command finishes, the loop injects a <task_notification> as the next
// user turn — so the result rejoins the conversation without ever having blocked
// it. Long-running servers (npm run dev) that never "finish" are supported too:
// they stay `running` forever and the model polls them with bash_output.
//
// Why no extra thread / lock (unlike the Python reference): Node is single-
// threaded with an event loop. `spawn` is already async — stdout/stderr arrive
// as events while the main loop runs. There is no shared-memory race to guard,
// so the whole "daemon thread + mutex" dance collapses into plain callbacks.
import { spawn, type ChildProcess } from "node:child_process";

// A task's lifecycle. `running` until the process closes, then exactly one of
// the terminal states. `killed` is its own state so a SIGKILL on exit reads
// differently from a command that failed on its own.
type BgStatus = "running" | "completed" | "failed" | "killed";

interface BgTask {
  id: string; // "bg_1", "bg_2", … — the handle the model uses
  command: string; // the command line, for display and the notification
  child: ChildProcess; // the live process (so we can kill it)
  status: BgStatus; // where it is in its lifecycle
  exitCode: number | null; // set when it closes; null while running
  output: string; // accumulated stdout+stderr, capped (see OUTPUT_CAP)
  produced: number; // total chars EVER produced (monotonic) — survives trimming
  readAt: number; // value of `produced` at the last bash_output poll
  notified: boolean; // has the completion notification been delivered yet?
  startedAt: number; // epoch ms — for the elapsed time in the notification
  endedAt: number | null; // epoch ms when it closed; null while running
}

const tasks = new Map<string, BgTask>(); // id → task, for the whole session
let seq = 0; // increments per task — seeds the id

const OUTPUT_CAP = 80_000; // chars of output retained per task (keep the tail)
const SUMMARY_TAIL = 1_500; // chars of the tail shown inline in a notification

// Append output to a task, keeping only the most recent OUTPUT_CAP chars. We
// keep the TAIL, not the head: an exit error or a "server ready on :3000" line
// lands at the end, and that is what the model needs to react to. `produced`
// counts everything ever written so the poll cursor stays correct across trims.
function append(task: BgTask, chunk: string): void {
  task.produced += chunk.length;
  task.output += chunk;
  if (task.output.length > OUTPUT_CAP) task.output = task.output.slice(-OUTPUT_CAP);
}

// Start a command in the background. Returns its task id immediately — the
// command keeps running after this returns. Note the deliberate omissions vs
// run_bash: NO 30s timeout (the whole point is to outlive it) and NO turn
// AbortSignal (Ctrl+C interrupts the current turn, but a background job is meant
// to survive into later turns; only killAll, on session exit, stops them).
export function startBackground(command: string): string {
  const id = `bg_${++seq}`;
  const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] }); // shell:true → bash semantics, same as run_bash
  const task: BgTask = {
    id,
    command,
    child,
    status: "running",
    exitCode: null,
    output: "",
    produced: 0,
    readAt: 0,
    notified: false,
    startedAt: Date.now(),
    endedAt: null,
  };
  tasks.set(id, task);

  child.stdout?.on("data", (d) => append(task, d.toString())); // stream output into the buffer as it arrives
  child.stderr?.on("data", (d) => append(task, d.toString()));
  child.on("error", (err) => {
    // The process could not even start (e.g. command not found). Record it as a
    // failure with the reason, so the notification explains what happened.
    append(task, `\n[could not start: ${err.message}]`);
    if (task.status === "running") {
      task.status = "failed";
      task.exitCode = null;
      task.endedAt = Date.now();
    }
  });
  child.on("close", (code, signal) => {
    if (task.status !== "running") return; // already terminal (killAll set `killed`, or an error fired) — don't overwrite
    task.exitCode = code;
    task.status = code === 0 ? "completed" : "failed";
    if (signal) task.status = "killed"; // killed by a signal, not its own exit
    task.endedAt = Date.now();
  });
  return id;
}

// Collect notifications for every task that has FINISHED since the last call.
// Each task is reported exactly once (the `notified` flag), so calling this
// every round is safe: a finished task surfaces once, then never again. Returns
// "" when there is nothing to report. The <task_notification> shape is taken
// straight from the tutorial reference so the format is consistent across the
// course.
export function pendingNotifications(): string {
  const done: string[] = [];
  for (const task of tasks.values()) {
    if (task.status === "running" || task.notified) continue; // still going, or already reported
    task.notified = true; // report it once
    const secs = task.endedAt ? Math.round((task.endedAt - task.startedAt) / 1000) : 0;
    const tail = task.output.slice(-SUMMARY_TAIL).trim() || "(no output)";
    const more = task.output.length > SUMMARY_TAIL ? " (truncated — use bash_output for the full log)" : "";
    done.push(
      `<task_notification>\n` +
        `  <task_id>${task.id}</task_id>\n` +
        `  <status>${task.status}</status>\n` +
        `  <command>${task.command}</command>\n` +
        `  <exit_code>${task.exitCode ?? "n/a"}</exit_code>\n` +
        `  <elapsed>${secs}s</elapsed>\n` +
        `  <summary>${tail}${more}</summary>\n` +
        `</task_notification>`,
    );
  }
  if (!done.length) return "";
  // The framing line matters: without it the model can mistake the XML for
  // something it must echo. Tell it plainly that a job it started has finished.
  return `A background task you started has finished. Read the notification, then continue.\n\n${done.join("\n\n")}`;
}

// Read a background task's current state for the bash_output tool. Returns only
// the output PRODUCED SINCE THE LAST POLL (like Claude Code's BashOutput), so
// the model can watch a long job without re-reading the whole log each time.
// `full: true` returns the entire retained buffer instead.
export function readBackground(id: string, full = false): string {
  const task = tasks.get(id);
  if (!task) {
    const known = [...tasks.keys()];
    return `[error] No background task "${id}". ${known.length ? `Known tasks: ${known.join(", ")}.` : "No background tasks have been started this session."}`;
  }
  let chunk: string;
  if (full) {
    chunk = task.output; // the entire retained buffer
  } else {
    const fresh = task.produced - task.readAt; // chars produced since last poll
    // Trimming may have dropped older chars; never read past what we still hold.
    chunk = task.output.slice(Math.max(0, task.output.length - fresh));
  }
  task.readAt = task.produced; // either way, the model has now seen up to here — next poll shows only newer output
  const head = `[${task.id}] ${task.status}${task.exitCode !== null ? ` (exit ${task.exitCode})` : ""} · ${task.command}`;
  // Be precise about an empty body: nothing ever vs. nothing NEW since the last
  // poll (the model already read it) vs. nothing new yet on a still-running job.
  const body = chunk.trim() || (task.produced === 0 ? "(no output)" : task.status === "running" ? "(no new output yet)" : "(no new output)");
  return `${head}\n${body}`;
}

// A one-line-per-task snapshot for the /bg command. Newest first.
export function listBackground(): { id: string; status: BgStatus; command: string; elapsed: number }[] {
  return [...tasks.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((t) => ({
      id: t.id,
      status: t.status,
      command: t.command,
      elapsed: Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000),
    }));
}

// True if any task is still running — the REPL uses this to warn before exit.
export function hasRunningBackground(): boolean {
  return [...tasks.values()].some((t) => t.status === "running");
}

// Kill every still-running task. Called on session exit so a forgotten dev
// server or a slow install does not outlive the agent as an orphan.
export function killAllBackground(): void {
  for (const task of tasks.values()) {
    if (task.status !== "running") continue;
    task.child.kill("SIGKILL");
    task.status = "killed";
    task.endedAt = Date.now();
  }
}

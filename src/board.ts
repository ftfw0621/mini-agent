// ============ The shared task board (Day 40) ============
// Day 38/39 gave us a team, but the LEAD still had to hand every teammate its
// work by message. That doesn't scale: with twenty tasks the lead becomes a
// dispatcher, and a teammate that finishes early sits idle while the lead is
// busy. s17's fix: a shared TASK BOARD that agents pull from THEMSELVES. The
// lead (or a teammate) drops tasks on the board; any idle teammate scans it,
// CLAIMS a ready one, does it, marks it complete, and scans again — autonomous
// work distribution with no dispatcher in the middle.
//
// Like the mailboxes, the board is ON DISK (落盘) for observability: each task is
// a .mini-agent/tasks/<id>.json file you can read while the team runs. And like
// the mailboxes, it needs NO lock despite "concurrent" claimers: claimTask is a
// synchronous read-check-write, and on one event loop a synchronous function
// runs to completion without yielding — so two teammates can never both win the
// same task. (The Python reference uses proper-lockfile because its teammates are
// OS threads; production CC adds fs.watch + atomic claim-with-busy-check.)
//
// Not to be confused with todo_write (Day 36): that is one agent's PRIVATE
// checklist; this is the team's SHARED, claimable work queue.
import fs from "node:fs"; // tasks are real files
import path from "node:path"; // path joining

// One unit of claimable work. `blockedBy` lists task ids that must be completed
// before this one can start — that is what lets the lead lay out a dependency
// graph (schema before routes before tests) and have teammates respect it.
export interface Task {
  id: string; // "task_1"
  subject: string; // one-line title
  description: string; // the full instruction for whoever claims it
  status: "pending" | "in_progress" | "completed"; // lifecycle
  owner: string | null; // the agent that claimed it, or null while unclaimed
  blockedBy: string[]; // task ids that must be completed first
  createdAt: number; // epoch ms
}

let seq = 0; // increments per task — seeds the id
let wiped = false; // wipe stale board files once per process run (like team.ts)

// Resolved lazily so it tracks the cwd, exactly like the session + team dirs.
function boardRoot(): string {
  const root = path.resolve(".mini-agent", "tasks");
  fs.mkdirSync(root, { recursive: true });
  if (!wiped) {
    for (const f of fs.readdirSync(root)) if (f.endsWith(".json")) fs.rmSync(path.join(root, f)); // fresh board for this run
    wiped = true;
  }
  return root;
}

const taskPath = (id: string): string => path.join(boardRoot(), `${id}.json`);

function saveTask(task: Task): void {
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2)); // pretty, so `cat` is readable
}

export function getTask(id: string): Task | undefined {
  try {
    return JSON.parse(fs.readFileSync(taskPath(id), "utf8")) as Task;
  } catch {
    return undefined; // missing or corrupt
  }
}

// Every task on the board, oldest first (creation order = the natural reading
// order for a dependency graph).
export function listTasks(): Task[] {
  const root = boardRoot();
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as Task;
      } catch {
        return null;
      }
    })
    .filter((t): t is Task => t !== null)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

// Create a task. `blockedBy` may reference ids that don't exist yet — canStart
// treats an unknown dependency as "not satisfied", so order of creation is free.
export function createTask(subject: string, description = "", blockedBy: string[] = []): Task {
  const task: Task = { id: `task_${++seq}`, subject, description, status: "pending", owner: null, blockedBy, createdAt: Date.now() };
  saveTask(task);
  return task;
}

// Resolve a blockedBy entry to a task. Models naturally reference a dependency
// by its SUBJECT ("alpha") rather than its id ("task_1"), so we accept either —
// id first, then a unique subject match. Returns undefined if it matches nothing
// (or an ambiguous subject), which canStart then treats as still-blocking.
export function resolveDep(dep: string): Task | undefined {
  const byId = getTask(dep);
  if (byId) return byId;
  const bySubject = listTasks().filter((t) => t.subject === dep);
  return bySubject.length === 1 ? bySubject[0] : undefined; // ignore an ambiguous subject
}

// Can this task be started? Only if every blockedBy dependency resolves to a
// COMPLETED task. A missing/ambiguous dependency counts as blocking (fail closed).
export function canStart(id: string): boolean {
  const task = getTask(id);
  if (!task) return false;
  return task.blockedBy.every((dep) => resolveDep(dep)?.status === "completed");
}

// Claim a task for `owner`. The critical section: read, check it's still
// pending+unowned+ready, then write owner+in_progress — all synchronous, so it
// is atomic against any other agent on this event loop. Returns ok=false (with a
// reason) if someone else got there first or a dependency isn't done.
export function claimTask(id: string, owner: string): { ok: boolean; error?: string; task?: Task } {
  const task = getTask(id);
  if (!task) return { ok: false, error: `No task "${id}".` };
  if (task.status !== "pending") return { ok: false, error: `Task ${id} is ${task.status}${task.owner ? ` (owner ${task.owner})` : ""}, not claimable.` };
  if (task.owner) return { ok: false, error: `Task ${id} is already owned by ${task.owner}.` };
  if (!canStart(id)) return { ok: false, error: `Task ${id} is blocked by unfinished tasks: ${task.blockedBy.filter((d) => resolveDep(d)?.status !== "completed").join(", ")}.` };
  task.owner = owner;
  task.status = "in_progress";
  saveTask(task);
  return { ok: true, task };
}

// Complete a task and report which downstream tasks it just unblocked (so the
// claimer can mention them, and the board moves forward).
export function completeTask(id: string, by?: string): { ok: boolean; error?: string; unblocked?: string[] } {
  const task = getTask(id);
  if (!task) return { ok: false, error: `No task "${id}".` };
  if (task.status !== "in_progress") return { ok: false, error: `Task ${id} is ${task.status}, not in progress.` };
  if (by && task.owner && task.owner !== by) return { ok: false, error: `Task ${id} is owned by ${task.owner}, not ${by}.` };
  task.status = "completed";
  saveTask(task);
  // Tasks that listed this one as a dependency (by id or subject) and are now
  // ready just opened up.
  const unblocked = listTasks()
    .filter((t) => t.status === "pending" && !t.owner && t.blockedBy.some((d) => resolveDep(d)?.id === id) && canStart(t.id))
    .map((t) => t.id);
  return { ok: true, unblocked };
}

// Scan for the next task this agent can take and CLAIM it, atomically. Returns
// the claimed task, or null if nothing is available right now. This is the heart
// of autonomy: an idle teammate calls this and either gets work or keeps waiting.
// Trying each candidate (rather than just the first) closes the race where two
// agents scanned the same "available" task — the loser simply tries the next.
export function claimNextAvailable(owner: string): Task | null {
  for (const t of listTasks()) {
    if (t.status !== "pending" || t.owner || !canStart(t.id)) continue;
    const res = claimTask(t.id, owner);
    if (res.ok) return res.task!;
  }
  return null;
}

// Is there pending-and-ready work nobody has claimed? Used to tell "the board is
// genuinely drained" from "a teammate is briefly between tasks".
export function hasClaimableWork(): boolean {
  return listTasks().some((t) => t.status === "pending" && !t.owner && canStart(t.id));
}

// Any task not yet completed — the board still has open work (claimed or not).
export function hasOpenTasks(): boolean {
  return listTasks().some((t) => t.status !== "completed");
}

// A compact, human-readable board snapshot — for the list_tasks tool result and
// the /tasks command. One line per task: status, id, owner, deps.
export function boardSummary(): string {
  const tasks = listTasks();
  if (!tasks.length) return "(the task board is empty)";
  const icon = { pending: "○", in_progress: "◐", completed: "✓" };
  return tasks
    .map((t) => {
      const owner = t.owner ? ` @${t.owner}` : "";
      const deps = t.blockedBy.length ? ` (blockedBy: ${t.blockedBy.join(", ")})` : "";
      return `${icon[t.status]} ${t.id} [${t.status}${owner}] ${t.subject}${deps}`;
    })
    .join("\n");
}

// Wipe the board: delete every task file and reset the counter. Called on
// /clear, /resume, and when the lead disbands the team — each task starts fresh.
export function resetBoard(): void {
  const root = path.resolve(".mini-agent", "tasks");
  if (fs.existsSync(root)) for (const f of fs.readdirSync(root)) if (f.endsWith(".json")) fs.rmSync(path.join(root, f));
  seq = 0;
  wiped = true; // we just cleared it; don't re-wipe on the next touch this run
}

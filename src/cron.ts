// ============ Cron Scheduler (Day s14) ============
// The problem: the agent only acts when the user says something. "Run tests every
// morning at 9" or "Check CI every 30 minutes" shouldn't need a human to push.
//
// Solution, mirroring Claude Code: an independent scheduler that checks cron
// expressions every second, a queue that holds triggered jobs, and a queue
// processor that delivers them when the agent is idle. Four layers:
//
//   Scheduler    — setInterval, 1s poll, writes to cron_queue
//   Queue        — cron_queue, the handoff from scheduler to processor
//   Queue Proc.  — watches cron_queue; when non-empty + agent idle, triggers a turn
//   Consumer     — runLoop consumes cron_queue, injects "[Scheduled] ..." messages
//
// Durable jobs are written to .mini-agent/scheduled_tasks.json and survive
// restarts (the scheduler re-loads them next time). Session-only jobs live only
// in memory — when the process exits, they are gone.
import fs from "node:fs";
import path from "node:path";

// ============ Data types ============
export interface CronJob {
  id: string;
  cron: string; // 5-field cron expression: "0 9 * * *"
  prompt: string; // the message injected when it fires
  recurring: boolean; // true = periodic, false = one-shot
  durable: boolean; // true = write to disk, survive restart
  createdAt: number; // epoch ms
}

const SCHEDULED_TASKS_FILE = ".mini-agent/scheduled_tasks.json";
const MAX_JOBS = 50;

// In-memory registry: all jobs scheduled this session.
const scheduledJobs = new Map<string, CronJob>();

// The handoff: scheduler writes here, consumer drains.
const cronQueue: CronJob[] = [];

// Prevent the scheduler from firing the same job twice in the same minute.
const lastFired = new Map<string, string>(); // job id → "YYYY-MM-DD HH:MM"

// Lock for the cron queue and scheduled jobs map.
let cronLock = false;
function withCronLock<T>(fn: () => T): T {
  // Node is single-threaded, so this lock is simpler than a real mutex.
  // It's here for correctness compatibility with the Python reference.
  cronLock = true;
  try {
    return fn();
  } finally {
    cronLock = false;
  }
}

// ============ Cron expression matching ============
// Standard 5-field cron: minute hour day-of-month month day-of-week.
// Day-of-month AND day-of-week both constrained → OR semantics (either matches).
function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  // Comma-separated list: "1,3,5"
  const parts = field.split(",");
  for (const part of parts) {
    if (part.includes("/")) {
      // Step: "*/5" or "0/5"
      const [base, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step < 1) continue;
      if (base === "*") {
        if (value % step === 0) return true;
      } else {
        const start = parseInt(base, 10);
        if (!isNaN(start) && value >= start && (value - start) % step === 0) return true;
      }
    } else if (part.includes("-")) {
      // Range: "1-5"
      const [lo, hi] = part.split("-").map(Number);
      if (!isNaN(lo) && !isNaN(hi) && value >= lo && value <= hi) return true;
    } else {
      // Exact: "5"
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

export function cronMatches(cronExpr: string, dt: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;

  // Python Monday=0 → cron Sunday=0. Node: getDay() Sunday=0 Monday=1 …
  // So weekday() + 1 in Python where Monday=0, but Node getDay() already
  // has Sunday=0. So Node's getDay() IS cron DOW. No conversion needed.
  const dowVal = dt.getDay();

  const m = cronFieldMatches(minute, dt.getMinutes());
  const h = cronFieldMatches(hour, dt.getHours());
  const monthOk = cronFieldMatches(month, dt.getMonth() + 1); // cron months are 1-based
  if (!m || !h || !monthOk) return false;

  const domOk = cronFieldMatches(dom, dt.getDate());
  const dowOk = cronFieldMatches(dow, dowVal);

  const domUnconstrained = dom === "*";
  const dowUnconstrained = dow === "*";

  if (domUnconstrained && dowUnconstrained) return true;
  if (domUnconstrained) return dowOk;
  if (dowUnconstrained) return domOk;
  return domOk || dowOk; // OR semantics
}

// ============ Validation ============
export function validateCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return `Cron expression must have 5 fields (min hour dom month dow), got ${fields.length}`;
  for (const field of fields) {
    if (!/^[*\d,\-\/]+$/.test(field)) return `Invalid cron field: "${field}"`;
  }
  // Try matching against a known time to catch structural errors.
  try {
    cronMatches(cronExpr, new Date());
  } catch {
    return `Could not parse cron expression: "${cronExpr}"`;
  }
  return null; // valid
}

// ============ Job management ============
let jobSeq = 0;

export function scheduleJob(
  cron: string,
  prompt: string,
  recurring = true,
  durable = true,
): string | { error: string } {
  const err = validateCron(cron);
  if (err) return { error: err };
  if (scheduledJobs.size >= MAX_JOBS) return { error: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.` };

  const id = `cron_${++jobSeq}`;
  const job: CronJob = {
    id,
    cron: cron.trim(),
    prompt,
    recurring,
    durable,
    createdAt: Date.now(),
  };
  withCronLock(() => {
    scheduledJobs.set(id, job);
    if (durable) saveDurableJobs();
  });
  return id;
}

export function cancelJob(id: string): boolean {
  let found = false;
  withCronLock(() => {
    found = scheduledJobs.delete(id);
    lastFired.delete(id);
    if (found) saveDurableJobs();
  });
  return found;
}

export function listJobs(): CronJob[] {
  return [...scheduledJobs.values()].sort((a, b) => a.createdAt - b.createdAt);
}

// The turn content a fired job injects: the job's own prompt, wrapped with the
// instruction to DO it now and report the result visibly, then go back to idle.
// Shared by both consumers — the in-turn one (injectCronMessages in loop.ts, for
// a job that fires mid-task) and the idle one (the REPL's idle processor, for a
// job that fires while the user is at the prompt) — so they behave identically.
export function cronTriggerContent(job: CronJob): string {
  return [
    `[Cron job "${job.id}" triggered — ${job.cron}]`,
    ``,
    `${job.prompt}`,
    ``,
    `Execute this now. When done, report the result directly to the user — make it visible and clear.`,
    `If the task produces output (e.g. a shell command result, a file change, a value), show it.`,
    `If there's nothing to show, confirm success with one line.`,
    ``,
    `After this, return to idle — do NOT start additional work unless the user asked for a chain of follow-ups.`,
  ].join("\n");
}

// ============ Cron queue ============
export function hasCronQueue(): boolean {
  return cronQueue.length > 0;
}

export function consumeCronQueue(): CronJob[] {
  const fired: CronJob[] = [];
  withCronLock(() => {
    while (cronQueue.length > 0) {
      const job = cronQueue.shift()!;
      fired.push(job);
    }
  });
  return fired;
}

// ============ Durable storage ============
function durableJobsPath(): string {
  return path.resolve(SCHEDULED_TASKS_FILE);
}

function saveDurableJobs(): void {
  const durable = [...scheduledJobs.values()].filter((j) => j.durable);
  const payload = { tasks: durable };
  try {
    fs.mkdirSync(path.dirname(durableJobsPath()), { recursive: true });
    fs.writeFileSync(durableJobsPath(), JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // Non-fatal: disk writes can fail; the in-memory state is still correct.
  }
}

export function loadDurableJobs(): void {
  const p = durableJobsPath();
  if (!fs.existsSync(p)) return;
  let data: { tasks: CronJob[] };
  try {
    data = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return; // corrupt file → ignore (the model can re-schedule)
  }
  if (!data.tasks || !Array.isArray(data.tasks)) return;
  for (const raw of data.tasks) {
    const err = validateCron(raw.cron);
    if (err) continue; // skip bad expressions so one bad job doesn't block startup
    const job: CronJob = {
      id: raw.id,
      cron: raw.cron.trim(),
      prompt: raw.prompt,
      recurring: raw.recurring ?? true,
      durable: raw.durable ?? true,
      createdAt: raw.createdAt || Date.now(),
    };
    scheduledJobs.set(job.id, job);
    // Track the highest seq so new ids don't collide with loaded ones.
    const match = job.id.match(/^cron_(\d+)$/);
    if (match) jobSeq = Math.max(jobSeq, parseInt(match[1], 10));
  }
}

// ============ Scheduler loop ============
let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startCronScheduler(): void {
  if (schedulerInterval) return; // already running
  schedulerInterval = setInterval(() => {
    const now = new Date();
    const minuteMarker = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    withCronLock(() => {
      for (const job of [...scheduledJobs.values()]) {
        try {
          if (cronMatches(job.cron, now)) {
            if (lastFired.get(job.id) !== minuteMarker) {
              cronQueue.push(job);
              lastFired.set(job.id, minuteMarker);
              if (!job.recurring) {
                scheduledJobs.delete(job.id);
              }
              if (job.durable) {
                saveDurableJobs();
              }
            }
          }
        } catch {
          // A single bad job must never kill the scheduler.
        }
      }
    });
  }, 1000);
}

export function stopCronScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

// Called by the queue processor — returns true if the agent was idle and we
// consumed cron items (meaning: the caller should trigger a new turn).
export function cronItemsPending(): boolean {
  return cronQueue.length > 0;
}

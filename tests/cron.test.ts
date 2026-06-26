import { cronMatches, validateCron, scheduleJob, cancelJob, listJobs, consumeCronQueue, hasCronQueue, loadDurableJobs } from "../src/cron.js";
import { check, checkContains, finish } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";

// Clean up any durable file left from a prior run so the test starts clean.
const durablePath = path.resolve(".mini-agent/scheduled_tasks.json");
if (fs.existsSync(durablePath)) fs.unlinkSync(durablePath);

// ---- cron_matches (standard 5-field cron) ------------------------------------
// Helper: create a Date with known values
function dt(year: number, month: number, day: number, hours: number, minutes: number, dow: number): Date {
  // month 1-12, day 2-31 → JS month is 0-based
  const d = new Date(year, month - 1, day, hours, minutes, 0, 0);
  // If the DOW doesn't match the actual calendar, override it (this is a test helper)
  // We trust the constructor for standard dates and only override dow for edge cases.
  // JS getDay() returns 0=Sun, 1=Mon...6=Sat → matches cron DOW.
  return d;
}

check("cron * * * * * matches any time", cronMatches("* * * * *", dt(2025, 6, 26, 12, 0, 0)));
check("cron 0 9 * * * matches 9:00", cronMatches("0 9 * * *", dt(2025, 6, 26, 9, 0, 4))); // Thu
check("cron 0 9 * * * does NOT match 9:01", !cronMatches("0 9 * * *", dt(2025, 6, 26, 9, 1, 4)));
check("cron */5 * * * * matches minute 0", cronMatches("*/5 * * * *", dt(2025, 6, 26, 12, 0, 0)));
check("cron */5 * * * * matches minute 5", cronMatches("*/5 * * * *", dt(2025, 6, 26, 12, 5, 0)));
check("cron */5 * * * * does NOT match minute 3", !cronMatches("*/5 * * * *", dt(2025, 6, 26, 12, 3, 0)));
check("cron 0 9 * * 1-5 matches weekday 9am", cronMatches("0 9 * * 1-5", dt(2025, 6, 26, 9, 0, 4))); // Thu=4
check("cron 0 9 * * 1-5 does NOT match Saturday", !cronMatches("0 9 * * 1-5", dt(2025, 6, 28, 9, 0, 6))); // Sat
check("cron 0 0 1 1 * matches Jan 1", cronMatches("0 0 1 1 *", dt(2025, 1, 1, 0, 0, 3))); // Wed
check("cron 0 0 1 1 * does NOT match Feb 1", !cronMatches("0 0 1 1 *", dt(2025, 2, 1, 0, 0, 6)));
// DOW + DOM OR semantics: both constrained → either match
check("cron 0 0 15 * 5 matches Friday (DOW match) even if DOM=15 doesn't match", cronMatches("0 0 15 * 5", dt(2025, 6, 20, 0, 0, 5))); // Friday the 20th
check("cron 0 0 15 * 5 matches the 15th (DOM match) even if not Friday", cronMatches("0 0 15 * 5", dt(2025, 6, 15, 0, 0, 0))); // Sunday the 15th
// Range: 1-5
check("cron 30 10 1-5 6 * matches day 3", cronMatches("30 10 1-5 6 *", dt(2025, 6, 3, 10, 30, 2)));
check("cron 30 10 1-5 6 * does NOT match day 6", !cronMatches("30 10 1-5 6 *", dt(2025, 6, 6, 10, 30, 5)));
// CSV: 1,15
check("cron 0 0 1,15 * * matches the 1st", cronMatches("0 0 1,15 * *", dt(2025, 6, 1, 0, 0, 0)));
check("cron 0 0 1,15 * * matches the 15th", cronMatches("0 0 1,15 * *", dt(2025, 6, 15, 0, 0, 0)));
check("cron 0 0 1,15 * * does NOT match the 10th", !cronMatches("0 0 1,15 * *", dt(2025, 6, 10, 0, 0, 5)));

check("cron with insufficient fields returns false", !cronMatches("* * * *", dt(2025, 6, 26, 12, 0, 0)));

// ---- validate_cron -----------------------------------------------------------
check("validate_cron accepts valid 5-field cron", validateCron("0 9 * * *") === null);
check("validate_cron rejects 4-field cron", validateCron("* * * *") !== null);
check("validate_cron rejects 6-field cron", validateCron("* * * * * *") !== null);
check("validate_cron rejects letters", validateCron("abc 9 * * *") !== null);
check("validate_cron accepts */15", validateCron("*/15 * * * *") === null);
check("validate_cron accepts ranges", validateCron("0 9 1-5 * 1-5") === null);

// ---- schedule / list / cancel -------------------------------------------------
const id1 = scheduleJob("0 9 * * *", "run morning report", true, true);
check("scheduleJob returns a string id (not error)", typeof id1 === "string");
const id1Str = id1 as string;
check("scheduleJob id starts with cron_", id1Str.startsWith("cron_"));

const result2 = scheduleJob("0 12 * * *", "lunchtime check", false, false);
check("one-shot + session-only also schedules", typeof result2 === "string");

const jobs = listJobs();
check("listJobs returns 2 jobs", jobs.length === 2);

const cancelled = cancelJob(id1Str);
check("cancelJob returns true for existing job", cancelled);
check("cancelJob removes the job", listJobs().length === 1);

const cancelledAgain = cancelJob(id1Str);
check("cancelJob returns false for already-cancelled job", !cancelledAgain);

// ---- MAX_JOBS ----------------------------------------------------------------
for (let i = 0; i < 60; i++) scheduleJob(`0 ${i % 24} * * *`, `job ${i}`, true, false);
check("max 50 jobs enforced (includes the 1 remaining)", listJobs().length <= 51); // 1 from earlier + up to 50 total

// ---- validate on schedule ----------------------------------------------------
const bad = scheduleJob("invalid", "bad cron");
check("scheduleJob rejects invalid cron", typeof bad === "object" && bad !== null && "error" in bad);
checkContains("scheduleJob error message mentions the problem", (bad as { error: string }).error, "Cron expression must have 5 fields");

// ---- durable persistence -----------------------------------------------------
// Clean, then schedule a durable job and verify it writes to disk.
// (The file was already cleaned at the top, but listJobs may still have session-only ones.)
// Schedule a fresh durable job.
const durableId = scheduleJob("30 8 * * 1-5", "weekday morning check", true, true);
check("durable job writes .mini-agent/scheduled_tasks.json", fs.existsSync(durablePath));

// ---- loadDurableJobs ---------------------------------------------------------
// Write a durable jobs file manually, then load from it.
// (Cancel all existing first so we start clean.)
for (const j of listJobs()) cancelJob(j.id);
const testTasks = {
  tasks: [
    { id: "cron_load_test", cron: "30 8 * * 1-5", prompt: "weekday morning check", recurring: true, durable: true, createdAt: Date.now() },
  ],
};
fs.mkdirSync(path.dirname(durablePath), { recursive: true });
fs.writeFileSync(durablePath, JSON.stringify(testTasks, null, 2), "utf8");
loadDurableJobs();
const reloaded = listJobs();
const found = reloaded.find((j) => j.id === "cron_load_test" && j.prompt === "weekday morning check");
check("loadDurableJobs restores the durable job from disk", found !== undefined);

// Clean up
fs.unlinkSync(durablePath);

// ---- cron queue --------------------------------------------------------------
check("hasCronQueue returns false when empty", !hasCronQueue());

// We can't easily push to the queue without the scheduler, but we can test
// consumeCronQueue on an empty queue returns [].
const fired = consumeCronQueue();
check("consumeCronQueue returns empty array when queue is empty", fired.length === 0);

finish();

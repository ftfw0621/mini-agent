import fs from "node:fs"; // the event log lives on disk
import path from "node:path"; // path joining

// LOCAL-ONLY telemetry. Events go to .mini-agent/telemetry.jsonl in the
// project directory and NOWHERE else — nothing leaves the machine, ever.
// It exists because "no data" means every optimization is a guess: which
// errors actually happen, how often compaction fires, which tools get denied.
// Opt out entirely with MINI_AGENT_NO_TELEMETRY=1.
//
// Naming follows the unified-prefix convention (agent_<domain>_<action>) so
// the log stays greppable: `grep agent_api_error telemetry.jsonl | wc -l`.
const TELEMETRY_FILE = path.resolve(".mini-agent", "telemetry.jsonl");

let sessionId: string | null = null; // set by initTelemetry; emit() is a no-op before that
const tallies = new Map<string, number>(); // per-session event counts, for /stats

// Arm telemetry for this session. Tests and the eval harness never call this,
// so library use stays silent — only the real CLI writes events.
export function initTelemetry(id: string): void {
  if (process.env.MINI_AGENT_NO_TELEMETRY === "1") return; // the user opted out — stay disarmed
  sessionId = id; // armed
}

// Record one event. Never throws: a telemetry failure must never break work.
export function emit(event: string, fields: Record<string, string | number> = {}): void {
  const key = event + (fields.tool ? `:${fields.tool}` : ""); // tool events tally per tool name
  tallies.set(key, (tallies.get(key) ?? 0) + 1); // /stats counts even when disarmed
  if (!sessionId) return; // disarmed — counters only, no file
  try {
    fs.mkdirSync(path.dirname(TELEMETRY_FILE), { recursive: true }); // ensure the directory
    fs.appendFileSync(TELEMETRY_FILE, JSON.stringify({ ts: new Date().toISOString(), session: sessionId, event, ...fields }) + "\n"); // one JSON object per line
  } catch {
    /* a full disk or a read-only checkout is not our problem to escalate */
  }
}

// The per-session tallies, sorted by count — the data behind /stats.
export function statsReport(): string {
  if (!tallies.size) return "(no events this session yet)"; // nothing happened
  const lines = [...tallies.entries()]
    .sort((a, b) => b[1] - a[1]) // busiest first
    .map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`); // aligned counts
  return ["events this session:", ...lines, `\nfull log: ${TELEMETRY_FILE} (local only — nothing leaves this machine)`].join("\n");
}

// ============ Agent teams (Day 38) ============
// The leap past the one-shot sub-agent (the `task` tool). A sub-agent is fire-
// and-forget: fresh context, runs to completion, returns ONE final report, gone.
// That breaks down on big work — a teammate restructuring the API can't tell the
// teammate touching auth what it changed, because they never talk; each only
// hands back a conclusion at the very end.
//
// A TEAM fixes that. A Lead spawns several PERSISTENT teammates that run
// concurrently and coordinate through ASYNCHRONOUS MAILBOXES: any agent can drop
// a message in any other agent's inbox at any time, and the recipient sees it on
// its next round. The Lead injects its inbox into its own conversation, so it
// reacts to teammate results as they arrive instead of blocking on a single
// return value.
//
// Why mailboxes live ON DISK (落盘), not in a Map: OBSERVABILITY. While the team
// runs you can `cat .mini-agent/team/<agent>.jsonl` and watch messages in flight
// — the coordination is a thing you can inspect, not hidden process state. The
// Python reference guards these files with proper-lockfile because it runs
// teammates on OS threads; we run them as async tasks on ONE event loop, where a
// single appendFileSync — or a readFileSync+rmSync pair — runs to completion
// without yielding, so two agents can never interleave mid-operation. No lock
// needed. (Cross-process is out of scope: one CLI instance per project.)
import fs from "node:fs"; // mailboxes are real files
import path from "node:path"; // path joining

// The mailbox name of the coordinator. Teammates message "lead" to report back;
// the Lead reads its own inbox under this name.
export const LEAD = "lead";

// At most this many teammates per Lead — a cost/runaway ceiling, like every
// other loop in this codebase. A handful of specialists is the whole idea; a
// swarm is a footgun.
export const MAX_TEAMMATES = 4;

// One message on the bus. Matches the s15 reference shape exactly so the on-disk
// format is consistent with the tutorial: who, to whom, what, what kind, when.
export interface TeamMessage {
  from: string; // sender's agent name (or "lead")
  to: string; // recipient's mailbox name
  content: string; // the message text
  type: "message" | "result"; // "result" = a teammate's final summary on completion; "message" = anything else
  ts: number; // epoch ms — orders messages and dates them on screen
}

// A spawned teammate as the registry tracks it. The promise lets the Lead (and
// shutdown) know when the worker's loop has actually ended.
export interface Teammate {
  name: string; // unique within the team; chosen by the Lead
  role: string; // one-line description of its specialty, for display
  status: "running" | "done" | "failed"; // lifecycle
  startedAt: number; // epoch ms
  done: Promise<void>; // resolves when the teammate's loop returns
}

const teammates = new Map<string, Teammate>(); // name → teammate, for this run

// ---- The mailbox files ------------------------------------------------------
// Resolved lazily (a function, not a const) so it tracks the cwd, exactly like
// session.ts. The first touch this process run wipes any stale mailboxes left by
// a crashed earlier run — a new team must start with empty inboxes.
let wiped = false;
function teamRoot(): string {
  const root = path.resolve(".mini-agent", "team");
  fs.mkdirSync(root, { recursive: true });
  if (!wiped) {
    for (const f of fs.readdirSync(root)) if (f.endsWith(".jsonl")) fs.rmSync(path.join(root, f)); // fresh inboxes for this run
    wiped = true;
  }
  return root;
}

function inboxPath(agent: string): string {
  // Keep file names filesystem-safe: agent names come from the model.
  const safe = agent.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(teamRoot(), `${safe}.jsonl`);
}

// Drop a message in the recipient's inbox: one JSON object per line (JSONL), so
// appends never have to rewrite the file and a half-written line can't corrupt
// the earlier ones. Synchronous on purpose — see the no-lock note up top.
export function sendMessage(from: string, to: string, content: string, type: TeamMessage["type"] = "message"): void {
  const msg: TeamMessage = { from, to, content, type, ts: Date.now() };
  fs.appendFileSync(inboxPath(to), JSON.stringify(msg) + "\n");
}

// Read and CONSUME an inbox: parse every message, then delete the file. The
// consumptive pattern (read = remove) means a message is delivered exactly once
// and the on-disk inbox always shows only what is still pending. Unreadable
// lines are skipped, never fatal.
export function readInbox(agent: string): TeamMessage[] {
  const p = inboxPath(agent);
  if (!fs.existsSync(p)) return []; // nothing waiting
  let raw = "";
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  fs.rmSync(p, { force: true }); // consume: the read empties the mailbox
  const out: TeamMessage[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as TeamMessage);
    } catch {
      /* skip a corrupt line, keep the rest */
    }
  }
  return out;
}

// Peek at how many messages are waiting WITHOUT consuming them. The loop uses
// this to decide whether to keep going; reading would empty the inbox before the
// agent's own turn got to see it.
export function inboxCount(agent: string): number {
  const p = inboxPath(agent);
  if (!fs.existsSync(p)) return 0;
  try {
    return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

// ---- The registry -----------------------------------------------------------
export function teammateExists(name: string): boolean {
  return teammates.has(name);
}

export function teammateCount(): number {
  return teammates.size;
}

// Record a newly spawned teammate. The caller supplies the promise for its loop.
export function registerTeammate(name: string, role: string, done: Promise<void>): void {
  teammates.set(name, { name, role, status: "running", startedAt: Date.now(), done });
}

// Mark a teammate finished. `ok=false` means its loop ended on a non-Done reason.
export function finishTeammate(name: string, ok: boolean): void {
  const t = teammates.get(name);
  if (t) t.status = ok ? "done" : "failed";
}

// How many teammates are still working — the Lead must not end the conversation
// while this is > 0 (their results are still coming).
export function activeTeammateCount(): number {
  return [...teammates.values()].filter((t) => t.status === "running").length;
}

// A snapshot for the /team command: newest first, with inbox depth.
export function listTeam(): { name: string; role: string; status: Teammate["status"]; elapsed: number; pending: number }[] {
  return [...teammates.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((t) => ({ name: t.name, role: t.role, status: t.status, elapsed: Math.round((Date.now() - t.startedAt) / 1000), pending: inboxCount(t.name) }));
}

// Wipe the registry (and let the next touch clear the mailbox files). Called on
// /clear and /resume: a new conversation starts with no team.
export function resetTeam(): void {
  teammates.clear();
  wiped = false; // the next mailbox touch wipes stale files again
}

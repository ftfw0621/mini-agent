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

// ---- Team protocols (Day 39) ------------------------------------------------
// Day 38 messages are loose text — fine for "here's what I changed", useless for
// "may I do this?" or "are you finished?", which need a YES/NO tied to a specific
// ask. s16's insight: a multi-agent system needs explicit message contracts, not
// vibes. A contract is tiny — a request kind, a request_id, and an expected
// answer — and every protocol is the same request→response shape correlated by
// that id. Two of them here: graceful shutdown, and plan approval.
export type ProtocolKind = "shutdown" | "plan_approval"; // the two contracts
export type ProtocolStatus = "pending" | "approved" | "rejected"; // a request's state machine
// A protocol message's role within its contract. Plain chat omits this entirely.
export type ProtocolMessageKind = "shutdown_request" | "shutdown_response" | "plan_approval_request" | "plan_approval_response";

// One message on the bus. The first four fields match the s15 reference shape so
// the on-disk format stays consistent; the optional protocol fields (Day 39)
// carry a contract when there is one — a plain message simply leaves them unset.
export interface TeamMessage {
  from: string; // sender's agent name (or "lead")
  to: string; // recipient's mailbox name
  content: string; // the message text (the payload / the reason / the plan)
  type: "message" | "result"; // "result" = a teammate's final summary; "message" = anything else (incl. protocol messages)
  ts: number; // epoch ms — orders messages and dates them on screen
  kind?: ProtocolMessageKind; // set ⇒ this is a protocol message, not plain chat
  requestId?: string; // correlates a response back to its request
  status?: ProtocolStatus; // on a *_response: the decision (approved / rejected)
}

// The state of one in-flight request — the ProtocolState the reference tracks in
// a pending_requests dict. Created when an agent sends a request, resolved when
// the matching response arrives.
export interface ProtocolState {
  requestId: string; // "req_000001"
  kind: ProtocolKind; // shutdown | plan_approval
  from: string; // who asked
  to: string; // who must answer
  status: ProtocolStatus; // pending → approved | rejected
  payload: string; // the ask (a shutdown reason, or the plan text)
  createdAt: number; // epoch ms
}

const pendingRequests = new Map<string, ProtocolState>(); // requestId → state
let reqSeq = 0; // increments per request — seeds the id

// A spawned teammate as the registry tracks it. The promise lets the Lead (and
// shutdown) know when the worker's loop has actually ended.
export interface Teammate {
  name: string; // unique within the team; chosen by the Lead
  role: string; // one-line description of its specialty, for display
  status: "running" | "done" | "failed"; // lifecycle
  // Day 39: a RUNNING teammate is also either actively working a round or idle,
  // waiting on its inbox. The lead uses this to tell "the team is still busy"
  // from "everyone is waiting" (the cue that the task is finished).
  state: "active" | "idle";
  shutdownRequestId?: string; // set when the lead asked it to shut down (it replies with this id and exits)
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

// Drop a PROTOCOL message in an inbox — same JSONL bus, but tagged with its
// contract role, request_id, and (for responses) the decision. This is how a
// request and its answer travel; the consume step on the other side routes by
// `kind` and correlates by `requestId`.
export function sendProtocol(from: string, to: string, kind: ProtocolMessageKind, requestId: string, content: string, status?: ProtocolStatus): void {
  const msg: TeamMessage = { from, to, content, type: "message", ts: Date.now(), kind, requestId, status };
  fs.appendFileSync(inboxPath(to), JSON.stringify(msg) + "\n");
}

// ---- Protocol state (the pending_requests dict) -----------------------------
// Open a request: store it pending and return its fresh id. The caller then
// sends the matching *_request message carrying this id.
export function createRequest(kind: ProtocolKind, from: string, to: string, payload: string): string {
  const requestId = `req_${String(++reqSeq).padStart(6, "0")}`; // req_000001
  pendingRequests.set(requestId, { requestId, kind, from, to, status: "pending", payload, createdAt: Date.now() });
  return requestId;
}

export function getRequest(requestId: string): ProtocolState | undefined {
  return pendingRequests.get(requestId);
}

// Correlate a response to its request — the reference's match_response. The
// guard that matters: the response's contract MUST match the request's kind, so
// a shutdown_response can never accidentally approve a plan_approval. Returns the
// updated state, or an error string the caller can hand back to the model.
export function resolveResponse(requestId: string, kind: ProtocolKind, approved: boolean): { ok: boolean; error?: string; state?: ProtocolState } {
  const state = pendingRequests.get(requestId);
  if (!state) return { ok: false, error: `No pending request "${requestId}".` };
  if (state.kind !== kind) return { ok: false, error: `Request "${requestId}" is a ${state.kind} request, not ${kind} — wrong response type.` };
  if (state.status !== "pending") return { ok: false, error: `Request "${requestId}" was already ${state.status}.` };
  state.status = approved ? "approved" : "rejected";
  return { ok: true, state };
}

// Requests still awaiting an answer for a given recipient — used by the lead's
// view and to surface "you still owe an answer" prompts.
export function openRequestsFor(agent: string): ProtocolState[] {
  return [...pendingRequests.values()].filter((r) => r.to === agent && r.status === "pending");
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
  teammates.set(name, { name, role, status: "running", state: "active", startedAt: Date.now(), done });
}

// Mark a teammate finished. `ok=false` means its loop ended on a non-Done reason.
export function finishTeammate(name: string, ok: boolean): void {
  const t = teammates.get(name);
  if (t) t.status = ok ? "done" : "failed";
}

// How many teammates are still running — at least one running teammate means the
// team isn't disbanded yet.
export function activeTeammateCount(): number {
  return [...teammates.values()].filter((t) => t.status === "running").length;
}

// ---- Day 39: active/idle + shutdown plumbing --------------------------------
// A running teammate flips between actively working a round and idling on its
// inbox. The lead waits while ANY teammate is actively working; once they're all
// idle (or done), the work has converged and the lead can wrap up the team.
export function setTeammateState(name: string, state: Teammate["state"]): void {
  const t = teammates.get(name);
  if (t && t.status === "running") t.state = state;
}
export function anyTeammateBusy(): boolean {
  return [...teammates.values()].some((t) => t.status === "running" && t.state === "active");
}
export function runningTeammates(): string[] {
  return [...teammates.values()].filter((t) => t.status === "running").map((t) => t.name);
}

// The shutdown handshake: the lead opens a shutdown request against a teammate,
// stamping it with the request_id; the teammate sees the flag at its next
// stop-point, replies shutdown_response(approved) with that id, and exits.
export function markShutdown(name: string, requestId: string): void {
  const t = teammates.get(name);
  if (t) t.shutdownRequestId = requestId;
}
export function shutdownRequestId(name: string): string | undefined {
  return teammates.get(name)?.shutdownRequestId;
}

// A snapshot for the /team command: newest first, with live state + inbox depth.
export function listTeam(): { name: string; role: string; status: string; elapsed: number; pending: number }[] {
  return [...teammates.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((t) => ({
      name: t.name,
      role: t.role,
      // While running, show active vs idle (Day 39) — that's the interesting bit.
      status: t.status === "running" ? t.state : t.status,
      elapsed: Math.round((Date.now() - t.startedAt) / 1000),
      pending: inboxCount(t.name),
    }));
}

// Wipe the registry AND the in-flight requests (and let the next touch clear the
// mailbox files). Called on /clear and /resume, and after the lead disbands the
// team — a new conversation starts with no team and no dangling protocols.
export function resetTeam(): void {
  teammates.clear();
  pendingRequests.clear();
  wiped = false; // the next mailbox touch wipes stale files again
}

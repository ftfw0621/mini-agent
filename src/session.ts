import fs from "node:fs"; // session files live on disk
import path from "node:path"; // path joining
import type OpenAI from "openai"; // message types
import { getGoal, type Goal } from "./goal.js"; // the /goal rides along in the session file (Day 41)

// Sessions are project-local: .mini-agent/sessions/<id>.json under the cwd.
// Project-local (not global) because a conversation is about a codebase —
// resuming a refactor of project A from inside project B makes no sense.
// Resolved lazily (a function, not a const) so it always reflects the current
// working directory — and so tests can chdir into a scratch dir.
const sessionsDir = () => path.resolve(".mini-agent", "sessions");
const KEEP_SESSIONS = 20; // how many session files survive pruning

// What one session file contains.
interface SessionFile {
  id: string; // the session id (also the file name)
  startedAt: string; // ISO timestamp of the first save
  savedAt: string; // ISO timestamp of the last save
  model: string; // which model the session ran on (informational)
  messages: OpenAI.ChatCompletionMessageParam[]; // the conversation, WITHOUT the system message
  title?: string; // optional concise title (generated after the first message); falls back to the first prompt
  goal?: Goal; // the /goal at save time (Day 41) — so --resume keeps working toward it
}

// A fresh, filename-safe session id derived from the wall clock.
export function newSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-"); // 2026-06-12T10-30-00-000Z
}

// Persist the conversation. Full snapshot, atomically (tmp + rename): the
// history is not append-only — compaction rewrites it — so a snapshot is the
// only representation that is always correct. Crash mid-write leaves the
// previous snapshot intact.
export function saveSession(id: string, model: string, messages: OpenAI.ChatCompletionMessageParam[], title?: string): void {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true }); // first save creates the directory
  const file = path.join(dir, `${id}.json`); // the real destination
  const existing = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as SessionFile) : null; // to preserve startedAt + title
  const data: SessionFile = {
    id,
    startedAt: existing?.startedAt ?? new Date().toISOString(), // first save stamps it, later saves keep it
    savedAt: new Date().toISOString(), // always refreshed
    model, // informational — resume does not force the same model
    title: title ?? existing?.title, // a generated title sticks across saves
    messages: messages.filter((m) => m.role !== "system"), // the constitution is rebuilt fresh on resume (AGENT.md may have changed)
    goal: getGoal() ?? undefined, // the live goal, snapshotted with the conversation it belongs to
  };
  const tmp = `${file}.tmp`; // write next to the destination (same filesystem → rename is atomic)
  fs.writeFileSync(tmp, JSON.stringify(data)); // the new snapshot
  fs.renameSync(tmp, file); // atomic swap
  prune(); // keep the directory bounded
}

// Overwrite just the title of an existing session. Used when the title model
// finishes AFTER the first save — the next saveSession would otherwise drop it.
export function setSessionTitle(id: string, title: string): void {
  const file = path.join(sessionsDir(), `${id}.json`);
  let s: SessionFile;
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8")) as SessionFile;
  } catch {
    return; // the session hasn't been saved yet — the title will land on the next save
  }
  s.title = title;
  s.savedAt = new Date().toISOString(); // a title is a change; keep the list ordering honest
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s)); // atomic, same as saveSession
  fs.renameSync(tmp, file);
}

// Session files on disk, newest (most recently saved) first. Shared by every
// reader below. Skips tmp files and strangers.
function sessionFilesNewestFirst(): { f: string; mtime: number }[] {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return []; // nothing ever saved here
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json")) // ignore tmp files and strangers
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs })) // newest by modification time
    .sort((a, b) => b.mtime - a.mtime);
}

// Load the most recent session, or null if there is none (or it is unreadable —
// a corrupt session file should not kill the CLI, just start fresh).
export function latestSession(): SessionFile | null {
  const files = sessionFilesNewestFirst();
  if (!files.length) return null; // empty directory
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir(), files[0].f), "utf8")) as SessionFile; // the newest snapshot
  } catch {
    return null; // unreadable — treat as absent, never crash on resume
  }
}

// Load one session by id, or null if missing/corrupt.
export function loadSession(id: string): SessionFile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${id}.json`), "utf8")) as SessionFile;
  } catch {
    return null;
  }
}

// A one-line, human-readable title for a session: the first thing the user
// actually typed, with any @file attachment block stripped off and the text
// flattened to a single trimmed line. This is what makes a session list
// pickable instead of a wall of timestamps. It's the FALLBACK when no concise
// generated title has been stored (see saveSession title + setSessionTitle).
export function sessionTitle(messages: OpenAI.ChatCompletionMessageParam[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  let text = typeof firstUser?.content === "string" ? firstUser.content : "";
  text = text.split("\n\n[Referenced files")[0]; // drop the @file attachment the REPL appended (Day 26)
  text = text.match(/^\[goal\][^\n]*\nObjective: ([^\n]*)/)?.[1] ?? text; // a session started with /goal is named after its objective (Day 41)
  const line = text.replace(/\s+/g, " ").trim(); // flatten to one line
  return line || "(no prompt)";
}

// What the picker shows for each session: enough to recognize it at a glance.
export interface SessionSummary {
  id: string; // the session id (pass to loadSession)
  savedAt: string; // ISO timestamp of the last save
  model: string; // which model it ran on
  messageCount: number; // how much conversation is in it
  title: string; // the first user prompt, one line
}

// Recent sessions, newest first, summarized for a picker. Unreadable files are
// skipped, never fatal.
export function listSessions(limit = 10): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const { f } of sessionFilesNewestFirst()) {
    if (out.length >= limit) break;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), "utf8")) as SessionFile;
      out.push({ id: s.id, savedAt: s.savedAt, model: s.model, messageCount: s.messages.length, title: s.title ?? sessionTitle(s.messages) });
    } catch {
      /* skip a corrupt file */
    }
  }
  return out;
}

// Delete everything beyond the newest KEEP_SESSIONS files. A CLI that quietly
// accumulates unbounded state in every project directory is not industrial.
function prune(): void {
  const dir = sessionsDir();
  for (const { f } of sessionFilesNewestFirst().slice(KEEP_SESSIONS)) fs.rmSync(path.join(dir, f)); // drop the tail beyond KEEP_SESSIONS
}

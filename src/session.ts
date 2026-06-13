import fs from "node:fs"; // session files live on disk
import path from "node:path"; // path joining
import type OpenAI from "openai"; // message types

// Sessions are project-local: .mini-agent/sessions/<id>.json under the cwd.
// Project-local (not global) because a conversation is about a codebase —
// resuming a refactor of project A from inside project B makes no sense.
const SESSIONS_DIR = path.resolve(".mini-agent", "sessions");
const KEEP_SESSIONS = 20; // how many session files survive pruning

// What one session file contains.
interface SessionFile {
  id: string; // the session id (also the file name)
  startedAt: string; // ISO timestamp of the first save
  savedAt: string; // ISO timestamp of the last save
  model: string; // which model the session ran on (informational)
  messages: OpenAI.ChatCompletionMessageParam[]; // the conversation, WITHOUT the system message
}

// A fresh, filename-safe session id derived from the wall clock.
export function newSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-"); // 2026-06-12T10-30-00-000Z
}

// Persist the conversation. Full snapshot, atomically (tmp + rename): the
// history is not append-only — compaction rewrites it — so a snapshot is the
// only representation that is always correct. Crash mid-write leaves the
// previous snapshot intact.
export function saveSession(id: string, model: string, messages: OpenAI.ChatCompletionMessageParam[]): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true }); // first save creates the directory
  const file = path.join(SESSIONS_DIR, `${id}.json`); // the real destination
  const existing = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as SessionFile) : null; // to preserve startedAt
  const data: SessionFile = {
    id,
    startedAt: existing?.startedAt ?? new Date().toISOString(), // first save stamps it, later saves keep it
    savedAt: new Date().toISOString(), // always refreshed
    model, // informational — resume does not force the same model
    messages: messages.filter((m) => m.role !== "system"), // the constitution is rebuilt fresh on resume (AGENT.md may have changed)
  };
  const tmp = `${file}.tmp`; // write next to the destination (same filesystem → rename is atomic)
  fs.writeFileSync(tmp, JSON.stringify(data)); // the new snapshot
  fs.renameSync(tmp, file); // atomic swap
  prune(); // keep the directory bounded
}

// Load the most recent session, or null if there is none (or it is unreadable —
// a corrupt session file should not kill the CLI, just start fresh).
export function latestSession(): SessionFile | null {
  if (!fs.existsSync(SESSIONS_DIR)) return null; // nothing ever saved here
  const files = fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json")) // ignore tmp files and strangers
    .map((f) => ({ f, mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs })) // newest by modification time
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null; // empty directory
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, files[0].f), "utf8")) as SessionFile; // the newest snapshot
  } catch {
    return null; // unreadable — treat as absent, never crash on resume
  }
}

// Delete everything beyond the newest KEEP_SESSIONS files. A CLI that quietly
// accumulates unbounded state in every project directory is not industrial.
function prune(): void {
  const files = fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime); // newest first
  for (const { f } of files.slice(KEEP_SESSIONS)) fs.rmSync(path.join(SESSIONS_DIR, f)); // drop the tail
}

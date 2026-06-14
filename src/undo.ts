import fs from "node:fs"; // read the "before" state and restore it
import path from "node:path"; // only for display shortening

// Undo for file writes. Day 21 lets the human SEE a change before it happens;
// this lets them TAKE IT BACK after it happened. Every write_file / edit_file
// records the file's previous content just before it changes; /undo pops the
// most recent record and puts the file back.
//
// It is content-based, not a git stash: it works whether or not the project is a
// repo, and it is scoped to this session. We store the whole "before" content —
// simple and exact. A bound keeps the history from growing without limit.

export interface Mutation {
  path: string; // absolute path that was changed
  before: string | null; // its content before the change; null = the file did not exist (a fresh create)
}

const MAX_UNDO = 50; // remember at most this many writes — older ones drop off
const stack: Mutation[] = []; // most recent change on top

// Called BY the write/edit tools, just before they touch the disk. Captures the
// current on-disk state so it can be restored later. Never throws — recording is
// best-effort and must not break the write it is shadowing.
export function recordMutation(absPath: string): void {
  let before: string | null = null;
  try {
    if (fs.existsSync(absPath)) before = fs.readFileSync(absPath, "utf8"); // existing file → keep its content
  } catch {
    before = null; // unreadable → treat as "nothing to restore"
  }
  stack.push({ path: absPath, before });
  if (stack.length > MAX_UNDO) stack.shift(); // bound the history (drop the oldest)
}

// How many undos are available — used by the REPL banner / message.
export function undoDepth(): number {
  return stack.length;
}

// Forget all recorded mutations (e.g. on /clear — a fresh conversation should
// not be able to undo writes from the previous one).
export function clearUndo(): void {
  stack.length = 0;
}

// The result of an undo, for the REPL to render (it shows a diff of what was
// put back, reusing Day 21's renderer).
export interface UndoResult {
  path: string; // the file that was restored
  summary: string; // a one-line human description
  before: string | null; // what the file is being restored TO (null = file removed)
  after: string | null; // what it looked like just before the undo (null = it was gone)
}

// Undo the most recent recorded write. Returns null if there is nothing to undo.
// Restores the previous content, or deletes a file that the write had created.
export function undoLast(): UndoResult | null {
  const m = stack.pop();
  if (!m) return null; // empty history

  let after: string | null = null;
  try {
    if (fs.existsSync(m.path)) after = fs.readFileSync(m.path, "utf8"); // current state, for the diff
  } catch {
    after = null;
  }

  const shortPath = path.relative(process.cwd(), m.path) || m.path; // nicer to read than an absolute path
  try {
    if (m.before === null) {
      if (fs.existsSync(m.path)) fs.rmSync(m.path); // the write created this file → undo removes it
      return { path: m.path, summary: `removed ${shortPath} (it had just been created)`, before: null, after };
    }
    fs.writeFileSync(m.path, m.before, "utf8"); // put the old content back
    return { path: m.path, summary: `restored ${shortPath} to its previous content`, before: m.before, after };
  } catch (e) {
    stack.push(m); // restore failed → keep the record so the user can retry
    return { path: m.path, summary: `could not undo ${shortPath}: ${(e as Error).message}`, before: m.before, after };
  }
}

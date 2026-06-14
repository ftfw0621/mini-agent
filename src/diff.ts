import fs from "node:fs"; // read the target file to diff against
import path from "node:path"; // resolve the file path
import chalk from "chalk"; // color the +/- lines (auto-disabled when output isn't a TTY)

// A tiny, dependency-free line diff — so the human approving a write sees exactly
// what will change, not just a file name. A filename alone ("edit_file: cart.js")
// is not enough to say yes to safely; the actual +/- lines are. Line-based LCS:
// readable output, no library, fits the project's "no framework" budget.

export type DiffOp = { kind: " " | "-" | "+"; line: string }; // unchanged / removed / added

// Longest-common-subsequence over lines → an ordered list of ops. Classic DP:
// lcs[i][j] = length of the LCS of a[i:] and b[j:]. Walking it forwards turns the
// table into the smallest set of removals + additions that turns a into b.
export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.length ? oldText.split("\n") : []; // empty string = no lines (not [""])
  const b = newText.length ? newText.split("\n") : [];
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0)); // (n+1)×(m+1), last row/col are zeros
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]); // match extends the subsequence; else take the better side
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ kind: " ", line: a[i++] }), j++; // common line — keep it as context
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ kind: "-", line: a[i++] }); // dropping a[i] keeps more of the LCS → it was removed
    else ops.push({ kind: "+", line: b[j++] }); // otherwise b[j] is an addition
  }
  while (i < n) ops.push({ kind: "-", line: a[i++] }); // leftover old lines were all removed
  while (j < m) ops.push({ kind: "+", line: b[j++] }); // leftover new lines were all added
  return ops;
}

const CONTEXT = 3; // unchanged lines to keep around each change, for readability
const MAX_LINES = 60; // hard cap on rendered lines — a huge diff must not flood the prompt

// Paint one line by its kind. chalk no-ops when colors are off, so the plain
// text is always present (and assertable in tests).
function paint(kind: DiffOp["kind"], text: string): string {
  if (kind === "+") return chalk.green(text);
  if (kind === "-") return chalk.red(text);
  return chalk.dim(text);
}

// Render ops as a compact unified diff: a "+A -B" summary header, the changed
// lines with a few lines of context, and long runs of untouched lines collapsed
// to a "⋮ (N unchanged lines)" marker so the reader sees the change, not the file.
export function renderDiff(oldText: string, newText: string, color = true): string {
  const ops = diffLines(oldText, newText);
  const added = ops.filter((o) => o.kind === "+").length;
  const removed = ops.filter((o) => o.kind === "-").length;

  // Keep any unchanged line within CONTEXT of a change; drop the rest.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.kind === " ") return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) keep[k] = true;
  });

  const out: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (keep[i]) {
      out.push(color ? paint(ops[i].kind, `${ops[i].kind} ${ops[i].line}`) : `${ops[i].kind} ${ops[i].line}`);
      i++;
    } else {
      let skipped = 0;
      while (i < ops.length && !keep[i]) skipped++, i++; // collapse the whole untouched run at once
      const note = `   ⋮ (${skipped} unchanged line${skipped === 1 ? "" : "s"})`;
      out.push(color ? chalk.dim(note) : note);
    }
  }

  const body = out.length > MAX_LINES ? [...out.slice(0, MAX_LINES), `   … (${out.length - MAX_LINES} more diff lines)`] : out;
  const header = `  +${added} -${removed}`;
  return [color ? chalk.dim(header) : header, ...body].join("\n");
}

const MAX_PREVIEW_BYTES = 200_000; // don't read+diff an enormous file just to preview it

// Read a file for diffing, or null if it shouldn't be diffed (missing, too big,
// or binary). A preview must never break a tool call, so every failure is null.
function safeRead(p: string): string | null {
  try {
    if (fs.statSync(p).size > MAX_PREVIEW_BYTES) return null; // too big to preview cheaply
    const text = fs.readFileSync(p, "utf8");
    return text.includes("\0") ? null : text; // a NUL byte means binary — don't diff it
  } catch {
    return null; // unreadable / missing
  }
}

// Build the diff preview shown before a write/edit runs. Returns null when there
// is nothing useful to show (not a write tool, unparseable args, binary file).
// NEVER throws.
export function previewChange(toolName: string, argsJson: string): string | null {
  let args: Record<string, string>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return null; // dispatch will report the JSON error; nothing to preview
  }
  try {
    if (toolName === "write_file") {
      const p = path.resolve(args.path ?? "");
      const exists = fs.existsSync(p);
      const oldText = exists ? safeRead(p) : ""; // new file → empty "before"
      if (oldText === null) return null; // existing but binary/oversized
      return `  ${exists ? "overwrite" : "create"} ${args.path}\n${renderDiff(oldText, String(args.content ?? ""))}`;
    }
    if (toolName === "edit_file") {
      const p = path.resolve(args.path ?? "");
      if (!fs.existsSync(p)) return null; // edit of a missing file → the tool will error
      const oldText = safeRead(p);
      if (oldText === null) return null;
      const occurrences = args.old_string ? oldText.split(args.old_string).length - 1 : 0;
      // The tool only applies a unique match. If it's unique, diff the real
      // before/after; otherwise just show the intended swap (the tool will
      // reject a 0/ambiguous match anyway, but the human still sees the intent).
      const newText = occurrences === 1 ? oldText.split(args.old_string).join(args.new_string ?? "") : null;
      return newText !== null
        ? `  edit ${args.path}\n${renderDiff(oldText, newText)}`
        : `  edit ${args.path}\n${renderDiff(String(args.old_string ?? ""), String(args.new_string ?? ""))}`;
    }
  } catch {
    return null; // anything unexpected → no preview, never a crash
  }
  return null; // not a file-changing tool
}

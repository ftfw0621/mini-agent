import fs from "node:fs"; // read referenced files
import path from "node:path"; // resolve mention paths
import { checkPermission } from "./permissions.js"; // reuse the read_file gate — secret files must never leak in

// @file mentions: let the user pull a file into the conversation just by naming
// it — "explain @src/loop.ts" attaches the file's content so the model sees it
// without a separate read_file round-trip. The point is convenience, but the
// SAME rule still holds: a secret file (.env, *.pem) must never enter the
// context. So every mention is routed through the read_file permission gate
// (Day 4) — if it would deny a read, the mention is refused, not read.

// @ must start the token (line start or after whitespace) so emails (a@b) and
// npm scopes inside words don't trigger. The path runs to the next space; we
// trim trailing sentence punctuation so "see @cart.js." doesn't include the dot.
const MENTION_RE = /(?:^|\s)@(\S+)/g;
const MAX_MENTION_BYTES = 100_000; // a referenced file bigger than this is truncated

export type MentionStatus = "ok" | "denied" | "missing" | "dir";
export interface Mention {
  raw: string; // exactly what the user typed after @
  path: string; // resolved absolute path
  status: MentionStatus; // what we could do with it
  content?: string; // present when status === "ok"
}

// Pull the raw @tokens out of a line (trailing , ; : ! ? ) stripped).
export function findMentions(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(MENTION_RE)) {
    const raw = m[1].replace(/[.,;:!?)\]]+$/, ""); // drop trailing punctuation, keep inner dots (cart.js)
    if (raw) out.push(raw);
  }
  return out;
}

// Resolve one mention to a file we may attach. Never throws.
function resolveMention(raw: string): Mention {
  const abs = path.resolve(raw);
  // The gate decides if a read is allowed; a secret file comes back "deny".
  if (checkPermission("read_file", JSON.stringify({ path: raw })).decision === "deny") {
    return { raw, path: abs, status: "denied" };
  }
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return { raw, path: abs, status: "dir" };
    let content = fs.readFileSync(abs, "utf8");
    if (content.length > MAX_MENTION_BYTES) content = content.slice(0, MAX_MENTION_BYTES) + `\n... (truncated, file is ${content.length} chars)`;
    return { raw, path: abs, status: "ok", content };
  } catch {
    return { raw, path: abs, status: "missing" }; // not a file — probably not a reference at all
  }
}

// Expand a user line: find @mentions, attach the readable ones, and refuse the
// secret ones out loud. Returns the augmented message (file blocks appended) and
// the mention list (for the REPL to summarize). A line with no resolvable
// mention is returned unchanged — @tokens that don't name a real file (an email,
// a stray @) are ignored silently so we don't nag on every "@" in prose.
export function expandMentions(line: string): { augmented: string; mentions: Mention[] } {
  const mentions = findMentions(line).map(resolveMention);
  // Only attach files we actually read, and announce refusals (security-relevant).
  // "missing"/"dir" are dropped silently — likely not file references.
  const attach = mentions.filter((m) => m.status === "ok" || m.status === "denied");
  if (!attach.length) return { augmented: line, mentions };

  const blocks = attach.map((m) =>
    m.status === "ok"
      ? `--- ${m.raw} ---\n${m.content}`
      : `--- ${m.raw} (refused: secret file, not included) ---`,
  );
  const augmented = `${line}\n\n[Referenced files — the user attached these with @mentions]\n${blocks.join("\n\n")}`;
  return { augmented, mentions };
}

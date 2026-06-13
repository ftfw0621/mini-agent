import fs from "node:fs"; // memory lives in a file on disk
import path from "node:path"; // path joining
import type { Tool } from "./tools.js"; // the remember tool is a normal tool

// Long-term memory: facts the agent should carry ACROSS sessions, not just
// within one conversation. Session persistence (Day 12) restores "what we were
// talking about"; this restores "what I should always know about this project"
// — the build command, a gotcha, a naming convention, a decision and its why.
//
// It is one Markdown file, project-local, human-readable and human-editable.
// Not a vector database, not embeddings: a file you can open, read, and fix.
// The agent appends to it with a `remember` tool; the file is injected into the
// system context at the start of every session.
export const MEMORY_PATH = path.resolve(".mini-agent", "MEMORY.md");

// Bounds, because unbounded memory is two bugs waiting to happen: it dilutes
// the model's attention (Ch6: too many rules → worse compliance) and it grows
// the cached prefix forever. When we hit a cap we drop the OLDEST entries —
// recent facts are likelier to still be true.
const MAX_ENTRIES = 30; // at most this many remembered facts
const MAX_BYTES = 8_000; // ...and at most this many bytes total

// The on-disk format is dead simple: one fact per line, "- " bullet. A header
// comment explains it so a human opening the file knows what they're looking at.
const HEADER = "# mini-agent long-term memory\n# One fact per line. Injected into context at session start. Edit freely.\n";

// Read the remembered facts as bullet lines (no header). Returns [] if absent.
export function readMemory(): string[] {
  try {
    return fs
      .readFileSync(MEMORY_PATH, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("- ")) // only the fact lines, skip the header
      .map((l) => l.slice(2).trim())
      .filter(Boolean);
  } catch {
    return []; // no memory file yet — that's fine
  }
}

// Build the block injected into the system message. Empty string when there is
// nothing to remember, so the prefix stays clean for projects that never use it.
export function memoryContext(): string {
  const facts = readMemory();
  if (!facts.length) return "";
  return `\n\nLong-term project memory (things you established in earlier sessions; treat as background, verify against the code before relying on a specific claim):\n${facts.map((f) => `- ${f}`).join("\n")}`;
}

// Append a fact, then enforce the caps. Self-healing by construction: every
// write re-applies the bounds, so the file can never grow past them even if it
// was hand-edited huge. Returns a short status for the tool result.
function addFact(fact: string): string {
  const clean = fact.replace(/\s+/g, " ").trim(); // one line, normalized whitespace
  if (!clean) return "[error] nothing to remember (empty fact).";
  let facts = readMemory();
  if (facts.includes(clean)) return "Already remembered — no change."; // idempotent, don't duplicate
  facts.push(clean);
  // Enforce the count cap first (drop oldest), then the byte cap (drop oldest
  // until it fits). Oldest-first because newer facts are likelier still true.
  if (facts.length > MAX_ENTRIES) facts = facts.slice(facts.length - MAX_ENTRIES);
  let body = facts.map((f) => `- ${f}`).join("\n");
  while (Buffer.byteLength(HEADER + body, "utf8") > MAX_BYTES && facts.length > 1) {
    facts.shift(); // drop the oldest
    body = facts.map((f) => `- ${f}`).join("\n");
  }
  fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
  fs.writeFileSync(MEMORY_PATH, HEADER + body + "\n", "utf8");
  return `Remembered. (${facts.length} fact${facts.length === 1 ? "" : "s"} stored.)`;
}

// The tool the model calls to save something worth keeping. Writing to the
// memory file is the only filesystem effect, so it does not need the heavy
// write-permission prompt — but it is NOT read-only either (it persists), so
// the permission gate still routes it through "ask" by default like any
// unknown tool; users can pre-approve tool:remember in settings.
export const rememberTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "remember",
      description: `Save a durable fact about THIS project to long-term memory (persists across sessions and is shown to you at the start of every future session).
Use it for things that will still be true next time: the build/test command, a non-obvious gotcha, a naming or architectural convention, a decision and its reason.
Do NOT use it for transient state (current task, today's bug) — that belongs in the conversation. Keep each fact to one sentence.`,
      parameters: {
        type: "object",
        properties: { fact: { type: "string", description: "One durable fact, as a single sentence" } },
        required: ["fact"],
      },
    },
  },
  run: (args) => addFact(args.fact ?? ""),
};

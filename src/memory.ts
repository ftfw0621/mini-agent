import fs from "node:fs"; // memory lives in a file on disk
import path from "node:path"; // path joining
import type OpenAI from "openai"; // types only — the extraction call uses the caller's client
import type { Tool } from "./tools.js"; // the remember tool is a normal tool

// Long-term memory: facts the agent should carry ACROSS sessions, not just
// within one conversation. Session persistence (Day 12) restores "what we were
// talking about"; this restores "what I should always know about this project".
//
// One Markdown file, project-local, human-readable and human-editable. Not a
// vector database, not embeddings: a file you can open, read, and fix.
//
// Two ways facts get in: the model calls `remember` explicitly, OR — when
// auto-extract is on — after each turn a cheap model call reads the conversation
// and saves what's worth keeping (especially turns where the USER corrected the
// assistant: 90% the model gets right isn't worth saving, the 10% it got wrong
// and was corrected on is gold). Every fact is TYPED so the model can tell "this
// is who the user is" from "this is a correction" from "this is a project fact".
export const MEMORY_PATH = path.resolve(".mini-agent", "MEMORY.md");

// The four memory types (handbook §17). feedback is the most valuable.
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export interface MemoryEntry {
  type: MemoryType;
  fact: string;
}

// Bounds, because unbounded memory dilutes the model's attention (Ch6: too many
// rules → worse compliance) and grows the cached prefix forever. On overflow we
// drop the OLDEST — recent facts are likelier still true.
const MAX_ENTRIES = 40; // at most this many remembered facts
const MAX_BYTES = 12_000; // ...and at most this many bytes total

const HEADER = "# mini-agent long-term memory\n# One fact per line: - [type] fact. Injected at session start. Edit freely.\n";

// Coerce any string to a valid type, defaulting to "project".
function asType(t: string | undefined): MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(t ?? "") ? (t as MemoryType) : "project";
}

// Parse one bullet's text into a typed entry. "[feedback] foo" → feedback; a
// bare "foo" (legacy / hand-written) → project.
function parseEntry(text: string): MemoryEntry {
  const m = text.match(/^\[(\w+)\]\s*(.*)$/);
  if (m && (MEMORY_TYPES as readonly string[]).includes(m[1])) return { type: m[1] as MemoryType, fact: m[2].trim() };
  return { type: "project", fact: text.trim() };
}

// Read facts WITH their types. The fiddly parsing lives here.
export function readMemoryTyped(): MemoryEntry[] {
  try {
    return fs
      .readFileSync(MEMORY_PATH, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => parseEntry(l.slice(2).trim()))
      .filter((e) => e.fact);
  } catch {
    return []; // no memory file yet — fine
  }
}

// Read just the fact text (no type). Kept for callers that only want the facts.
export function readMemory(): string[] {
  return readMemoryTyped().map((e) => e.fact);
}

// The block injected into the system message, grouped by type so the model can
// weigh "a correction" differently from "a project fact". Empty when there's
// nothing, so the cached prefix stays clean for projects that never use it.
export function memoryContext(): string {
  const entries = readMemoryTyped();
  if (!entries.length) return "";
  const labels: Record<MemoryType, string> = {
    user: "About the user",
    feedback: "Guidance & corrections the user gave you (follow these)",
    project: "Project facts & decisions",
    reference: "References",
  };
  let out = "\n\nLong-term project memory (background from earlier sessions; verify against the code before relying on a specific claim):";
  for (const type of MEMORY_TYPES) {
    const group = entries.filter((e) => e.type === type);
    if (group.length) out += `\n[${labels[type]}]\n${group.map((e) => `- ${e.fact}`).join("\n")}`;
  }
  return out;
}

// Append a typed fact, then enforce the caps. Self-healing: every write re-applies
// the bounds, so the file can never grow past them even if hand-edited huge.
export function addFact(fact: string, type: MemoryType = "project"): string {
  const clean = fact.replace(/\s+/g, " ").trim(); // one line, normalized whitespace
  if (!clean) return "[error] nothing to remember (empty fact).";
  const t = asType(type); // coerce a bad type to "project" so the on-disk format stays parseable
  let entries = readMemoryTyped();
  if (entries.some((e) => e.fact === clean)) return "Already remembered — no change."; // idempotent
  entries.push({ type: t, fact: clean });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES); // drop oldest
  let body = entries.map((e) => `- [${e.type}] ${e.fact}`).join("\n");
  while (Buffer.byteLength(HEADER + body, "utf8") > MAX_BYTES && entries.length > 1) {
    entries.shift(); // still too big — drop the oldest until it fits
    body = entries.map((e) => `- [${e.type}] ${e.fact}`).join("\n");
  }
  fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
  fs.writeFileSync(MEMORY_PATH, HEADER + body + "\n", "utf8");
  return `Remembered (${t}). (${entries.length} fact${entries.length === 1 ? "" : "s"} stored.)`;
}

// The tool the model calls to save something worth keeping.
export const rememberTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "remember",
      description: `Save a durable fact to long-term memory (persists across sessions, shown to you at the start of every future session).
Use it for things still true next time: the build/test command, a gotcha, a convention, a decision and its reason, a user preference, or a correction the user gave you.
Do NOT use it for transient state (current task, today's bug). Keep each fact to one sentence. Pick the right "type".`,
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "One durable fact, as a single sentence" },
          type: { type: "string", enum: [...MEMORY_TYPES], description: "user (who they are/prefs) · feedback (a correction/guidance) · project (a decision/convention/gotcha) · reference (a URL/doc)" },
        },
        required: ["fact"],
      },
    },
  },
  run: (args) => addFact(args.fact ?? "", asType(args.type)),
};

// ---- auto-extract -----------------------------------------------------------
// After a turn, read the conversation and save what's worth keeping. The high-
// frequency write path from §17 — so memory captures itself instead of relying
// on the model to remember to call `remember`.

const EXTRACT_SYSTEM = `You extract DURABLE memories from a slice of a coding-assistant conversation — facts worth carrying into FUTURE sessions.
Output ONLY a JSON array. Each item: {"type": "...", "fact": "one sentence"}. No prose, no markdown fences.
"type" is one of:
- "user": who the user is — role, preferences, how they like to work.
- "feedback": guidance or a CORRECTION the user gave the assistant. These are the MOST valuable — prioritize any turn where the user corrected or redirected the assistant.
- "project": a goal, decision, convention, or non-obvious gotcha about THIS project.
- "reference": a pointer to an external resource (a URL, a doc, a ticket).
Do NOT save: transient task state, the bug currently being fixed, or anything obvious from reading the code. Keep each fact to one sentence.
If nothing is worth saving, output [].`;

// Parse the model's extraction output into typed entries. Lenient: finds the
// JSON array even if wrapped in prose/fences, drops malformed items. Pure.
export function parseExtractedMemories(text: string): MemoryEntry[] {
  const m = text.match(/\[[\s\S]*\]/); // the first […] — tolerate surrounding chatter
  if (!m) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is { type?: string; fact?: unknown } => !!x && typeof x === "object")
    .filter((x) => typeof x.fact === "string" && (x.fact as string).trim())
    .map((x) => ({ type: asType(x.type), fact: String(x.fact).replace(/\s+/g, " ").trim() }));
}

// Build the transcript handed to the extractor: the last few user/assistant
// turns (string content only), each capped, so the extraction stays cheap.
function buildTranscript(messages: OpenAI.ChatCompletionMessageParam[]): string {
  const turns = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12) // recent context is what matters
    .map((m) => `${m.role}: ${String(m.content).split("\n\n[Referenced files")[0].slice(0, 600)}`);
  return turns.join("\n\n");
}

// Run one extraction pass: a single (cheap) model call, parse, save. Returns the
// facts it saved. Never throws — a failed extraction must not break the session.
export async function extractMemories(client: OpenAI, model: string, messages: OpenAI.ChatCompletionMessageParam[]): Promise<MemoryEntry[]> {
  const transcript = buildTranscript(messages);
  if (!transcript.trim()) return [];
  let text = "";
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: transcript },
      ],
      stream: false,
    });
    text = res.choices?.[0]?.message?.content ?? "";
  } catch {
    return []; // network/model error — skip silently, try again next turn
  }
  const extracted = parseExtractedMemories(text);
  for (const e of extracted) addFact(e.fact, e.type); // addFact dedups internally
  return extracted;
}

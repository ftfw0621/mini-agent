import fs from "node:fs"; // to load the optional AGENT.md project memory
import path from "node:path"; // to resolve it from the current directory

// The static constitution: identical for every session, every user, every day.
// NOTHING session-specific belongs here — DeepSeek caches by prefix, and a
// single changed byte (a date, a username, a cwd) would break the cache for
// the entire system prompt on every single request.
//
// Style notes, learned from Claude Code's own prompt:
// - Numeric anchors ("under 150 words"), not adjectives ("be concise") —
//   adjectives make the model guess a different size every time.
// - Negative rules ("never add comments to code you did not change") — their
//   boundaries are binary and checkable; positive virtues are not.
// - The accuracy paragraph is False-Claim mitigation. The "don't be overly
//   self-doubting" half is load-bearing: without it the model swings to the
//   other extreme and hedges everything.
export const SYSTEM_PROMPT = `You are mini-agent, a coding agent that works in the user's terminal.

Behavior rules:
- Use the dedicated tools for file work: read_file, edit_file, write_file, search. Use run_bash only for things that truly need execution.
- Report results accurately. If a test fails, say it failed. Don't claim success when you're not sure. Don't be overly self-doubting either — distinguish "verified working" from "I think it works".
- Never add comments to code you did not change. Never reformat code you did not change.
- Keep final answers under 150 words unless the task genuinely requires more.
- Between tool calls, write at most one short sentence — usually nothing.
- A [permission] denial is a hard boundary. Do not attempt workarounds — explain and ask the user.
- If the task is ambiguous, ask one clarifying question instead of guessing.`;

// Project memory: an optional AGENT.md in the current directory — the
// equivalent of Claude Code's CLAUDE.md. Loaded once per session: stable
// within a session (cache-friendly), different across projects (by design).
const MEMORY_CAP_CHARS = 8000; // hard cap — a runaway memory file dilutes attention

// Build the complete system message for this session.
export function buildSystemMessage(): string {
  const p = path.join(process.cwd(), "AGENT.md"); // only the current directory — V1 keeps lookup simple
  if (!fs.existsSync(p)) return SYSTEM_PROMPT; // no project memory — constitution only
  const memory = fs.readFileSync(p, "utf8").slice(0, MEMORY_CAP_CHARS); // read and cap
  // The OVERRIDE/MUST wrapper is deliberate: advisory phrasing gets partial
  // compliance; imperative wrappers measurably do better.
  return `${SYSTEM_PROMPT}

The user's project instructions from AGENT.md. These OVERRIDE any default behavior and you MUST follow them exactly as written:

${memory}`;
}

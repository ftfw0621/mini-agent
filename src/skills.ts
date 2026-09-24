import fs from "node:fs"; // discover and read SKILL.md files
import os from "node:os"; // the global skills dir
import path from "node:path"; // path resolution
import type OpenAI from "openai"; // message shapes for the listing / body injection
import { CONFIG } from "./config.js"; // the context window sizes the listing budget
import { registerExternalTool, tools, unregisterExternalTool, type Tool } from "./tools.js"; // a skill is exposed to the model as a tool

// Skills: reusable procedures written as plain Markdown, executed by the MODEL,
// not by code. A skill is a folder with a SKILL.md — YAML-ish frontmatter (what
// it is, when to use it) + a Markdown body (the steps). The bar to add one is
// "can you write Markdown".
//
// Progressive disclosure (the key idea): the model only ever sees a one-line
// LISTING of each skill (name + when-to-use) until it decides to invoke one —
// only then is the full body loaded. So a hundred skills cost almost no context.
//
// The wiring follows Claude Code message for message:
//   - The listing is NOT in the tool description. It arrives as a user message
//     wrapped in <system-reminder>, and only the DELTA — skills the model hasn't
//     been told about yet — is sent. The `skill` tool's own description stays
//     static, so adding a skill never rewrites the tool manual.
//   - Invoking the tool returns just "Launching skill: <name>". The body follows
//     as a SEPARATE user message right after the round's tool results.
//   - The user's /skill <name> produces the same pair Claude Code does: a
//     <command-name> message, then the body.
//   - Edits take effect without a restart: the skill folders are re-checked
//     before every model call, and a new or changed skill is listed again.
//
// Not ported (the industrial parts): forked-context skills, !`cmd` expansion,
// allowed-tools as real permission grants, nested .claude/skills discovery.

export interface Skill {
  name: string; // unique id, also how the model invokes it
  description: string; // what it does
  whenToUse: string; // the trigger — what the model matches against
  allowedTools: string[]; // the tools the skill should use (least privilege; advisory here)
  disableModelInvocation: boolean; // true → only the user can trigger it (/skill name), the model can't
  argumentHint: string; // e.g. "<ticket-id>", shown in completion
  body: string; // the Markdown instructions
  path: string; // where it came from (the SKILL.md)
  dir: string; // the skill's folder — its scripts and references live here
}

// Project skills win over global ones with the same name.
function skillDirs(): string[] {
  return [path.resolve(".mini-agent", "skills"), path.join(os.homedir(), ".config", "mini-agent", "skills")];
}

// Parse one SKILL.md into a Skill. Pure — no filesystem — so the (fiddly)
// frontmatter parsing is unit-testable. A tiny YAML subset: `key: value` lines.
export function parseSkill(raw: string, fallbackName: string, filePath = ""): Skill {
  const fm: Record<string, string> = {};
  let body = raw.trim();
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/); // frontmatter between --- fences
  if (m) {
    body = m[2].trim();
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, ""); // strip surrounding quotes
      if (k) fm[k] = v;
    }
  }
  // No description? Claude Code falls back to the body's first line — something beats nothing in the listing.
  const firstLine = body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() ?? "";
  return {
    name: fm.name || fallbackName,
    description: fm.description || firstLine,
    whenToUse: fm.when_to_use || fm.whenToUse || "",
    allowedTools: (fm["allowed-tools"] || fm.allowedTools || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    disableModelInvocation: /^true$/i.test(fm.disableModelInvocation || fm["disable-model-invocation"] || ""),
    argumentHint: fm["argument-hint"] || "",
    body,
    path: filePath,
    dir: filePath ? path.dirname(filePath) : "",
  };
}

// Discover skills under the skill dirs (project first, then global). A bad file
// is skipped, never fatal. `dirs` is injectable for tests.
export function loadSkills(dirs: string[] = skillDirs()): Skill[] {
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // dir doesn't exist — fine
    }
    for (const entry of entries) {
      const file = path.join(dir, entry, "SKILL.md");
      try {
        const skill = parseSkill(fs.readFileSync(file, "utf8"), entry, file);
        if (seen.has(skill.name)) continue; // first wins → project overrides global
        seen.add(skill.name);
        out.push(skill);
      } catch {
        /* not a skill folder — skip */
      }
    }
  }
  return out;
}

// ---- hot reload -------------------------------------------------------------------
// Claude Code runs a chokidar watcher over its skill dirs. We get the same
// effect with no watcher at all: before every model call (and whenever the UI
// asks), stat the SKILL.md files and compare a fingerprint — every path with its
// mtime and size. A few readdir + stat calls per round is nothing next to a
// model call, and there is no timer to leak, debounce, or race.
let cache: { key: string; fingerprint: string; skills: Skill[] } | undefined;

function fingerprint(dirs: string[]): string {
  const parts: string[] = [];
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      try {
        const st = fs.statSync(path.join(dir, entry, "SKILL.md"));
        parts.push(`${dir}/${entry}:${st.mtimeMs}:${st.size}`);
      } catch {
        /* no SKILL.md here */
      }
    }
  }
  return parts.join("|");
}

// The live skill set: reloaded from disk only when a SKILL.md was added,
// edited, or removed since the last call. `dirs` is injectable for tests.
export function currentSkills(dirs: string[] = skillDirs()): Skill[] {
  const key = dirs.join("\n");
  const fp = fingerprint(dirs);
  if (!cache || cache.key !== key || cache.fingerprint !== fp) cache = { key, fingerprint: fp, skills: loadSkills(dirs) };
  return cache.skills;
}

export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const n = name.trim().replace(/^\//, "").toLowerCase(); // "/deploy" and "deploy" both work, like Claude Code
  return skills.find((s) => s.name.toLowerCase() === n);
}

// ---- the listing, as a <system-reminder> ------------------------------------------
export const wrapInSystemReminder = (content: string): string => `<system-reminder>\n${content}\n</system-reminder>`;

const LISTING_HEADER = "The following skills are available for use with the skill tool:"; // Claude Code's wording, our tool name
const MAX_ENTRY = 250; // cap each skill's line (Claude Code: MAX_LISTING_DESC_CHARS)
const MIN_DESC = 20; // below this, a truncated description is noise — list the bare name

// One line per skill: "- name: description - when to use", as Claude Code formats it.
function listingEntry(s: Skill, maxDesc = MAX_ENTRY): string {
  const desc = (s.whenToUse ? `${s.description} - ${s.whenToUse}` : s.description).replace(/\s+/g, " ").trim();
  if (maxDesc < MIN_DESC) return `- ${s.name}`;
  return `- ${s.name}: ${desc.length > maxDesc ? desc.slice(0, maxDesc - 1) + "…" : desc}`;
}

// The listing lines for a set of skills, fit into a character budget: 1% of the
// context window at ~4 chars/token (Claude Code's formula). Over budget, every
// description is shortened evenly rather than dropping skills off the end — a
// skill the model never hears about can never be used.
export function skillListing(skills: Skill[], budget = Math.floor(CONFIG.contextWindow * 4 * 0.01)): string[] {
  let lines = skills.map((s) => listingEntry(s));
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total > budget && skills.length) {
    const nameCost = skills.reduce((n, s) => n + s.name.length + 5, 0); // "- " + name + ": " + "\n"
    const maxDesc = Math.floor((budget - nameCost) / skills.length);
    lines = skills.map((s) => listingEntry(s, maxDesc));
  }
  return lines;
}

// Which listing lines has THIS conversation already received? Read it back
// from the history itself instead of keeping a side table: /clear, --resume,
// and compaction all just work — whatever the model can still see counts as
// sent, and nothing else does. (Claude Code keeps a per-agent "sent names" set
// and resets it on reload; deriving it from history gives the same answer and
// also re-lists after compaction drops the old reminder.)
function sentListingLines(messages: OpenAI.ChatCompletionMessageParam[]): Set<string> {
  const sent = new Set<string>();
  const prefix = wrapInSystemReminder(LISTING_HEADER).split("\n").slice(0, 2).join("\n");
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content !== "string" || !m.content.startsWith(prefix)) continue;
    for (const line of m.content.split("\n")) if (line.startsWith("- ")) sent.add(line);
  }
  return sent;
}

// The reminder to send before the next model call, or null if the model is up
// to date. Only new or changed lines go out (the delta) — the first call of a
// conversation gets the whole listing, an edited skill gets its fresh line.
export function skillListingReminder(messages: OpenAI.ChatCompletionMessageParam[], skills: Skill[]): string | null {
  const sent = sentListingLines(messages);
  const fresh = skillListing(skills.filter((s) => !s.disableModelInvocation)).filter((l) => !sent.has(l));
  return fresh.length ? wrapInSystemReminder(`${LISTING_HEADER}\n\n${fresh.join("\n")}`) : null;
}

// ---- the body, as its own user message ----------------------------------------------
// Argument substitution, Claude Code's order: $ARGUMENTS[n] / $n (shell-style
// split), then $ARGUMENTS whole. A body with no placeholder still gets the
// arguments — appended, so they are never silently dropped.
export function substituteArguments(body: string, args: string): string {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  let out = body
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, i) => parts[Number(i)] ?? "")
    .replace(/\$(\d+)(?!\d)/g, (_m, i) => parts[Number(i)] ?? "")
    .replace(/\$ARGUMENTS/g, args);
  if (out === body && args.trim()) out += `\n\nARGUMENTS: ${args}`;
  return out;
}

// What the model reads once a skill is invoked (by it or by the user):
// "Base directory for this skill: …" so relative paths in the body resolve,
// then the body with arguments filled in.
export function skillBody(s: Skill, args = ""): string {
  const body = substituteArguments(s.body, args).replaceAll("${CLAUDE_SKILL_DIR}", s.dir).replaceAll("${SKILL_DIR}", s.dir); // a copied Claude Code skill keeps working
  const tools = s.allowedTools.length ? `\n\n[This skill should use only these tools: ${s.allowedTools.join(", ")}. Other actions still go through the normal permission gate.]` : "";
  return `Base directory for this skill: ${s.dir}\n\n${body}${tools}`;
}

// The user typed /skill <name> [args]: the two messages Claude Code produces —
// a <command-name> marker (so the model knows the skill is ALREADY loaded and
// must not call the tool again), then the body.
export function userSkillMessages(s: Skill, args: string): [string, string] {
  const argsTag = args.trim() ? `\n<command-args>${args.trim()}</command-args>` : "";
  return [`<command-message>${s.name}</command-message>\n<command-name>/${s.name}</command-name>${argsTag}`, skillBody(s, args)];
}

// ---- the skill tool -----------------------------------------------------------------
const LAUNCHED = "Launching skill: "; // the tool result that tells the loop a body must follow

// The tool's manual is static — what skills exist arrives through the listing
// reminders, so a new skill never changes the tool list.
export const SKILL_TOOL_DESCRIPTION = `Execute a skill within the main conversation.

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

How to invoke:
- Use this tool with the skill name and optional arguments
- Example: skill: "pdf" — invoke the pdf skill
- Example: skill: "commit", args: "-m 'Fix bug'" — invoke with arguments

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, invoke it BEFORE generating any other response about the task
- Do not invoke a skill that is already running
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded — follow the instructions directly instead of calling this tool again`;

export function buildSkillTool(getSkills: () => Skill[] = currentSkills): Tool {
  return {
    definition: {
      type: "function",
      function: {
        name: "skill",
        description: SKILL_TOOL_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            skill: { type: "string", description: 'The skill name. E.g., "commit", "review-pr", or "pdf"' },
            args: { type: "string", description: "Optional arguments for the skill" },
          },
          required: ["skill"],
        },
      },
    },
    run: (args) => {
      const skills = getSkills();
      const s = findSkill(skills, args.skill ?? "");
      if (!s) return `[error] Unknown skill: ${args.skill}. Available: ${skills.filter((x) => !x.disableModelInvocation).map((x) => x.name).join(", ") || "none"}.`;
      if (s.disableModelInvocation) return `[error] Skill ${s.name} cannot be used with the skill tool due to disable-model-invocation — only the user can run it.`;
      return `${LAUNCHED}${s.name}`; // the body follows as its own message (skillBodyMessages)
    },
  };
}

// After a round's tool results are in: one body message per skill the model
// launched. They MUST come after all of the round's tool messages — the API
// requires every tool result of an assistant turn before any other message.
export function skillBodyMessages(
  calls: { id: string; name: string; args: string }[],
  messages: OpenAI.ChatCompletionMessageParam[],
  skills: Skill[] = currentSkills(),
): string[] {
  const out: string[] = [];
  for (const call of calls) {
    if (call.name !== "skill") continue;
    const result = messages.find((m) => m.role === "tool" && m.tool_call_id === call.id);
    if (!result || typeof result.content !== "string" || !result.content.startsWith(LAUNCHED)) continue; // refused, errored, or never ran
    let args: Record<string, string> = {};
    try {
      args = JSON.parse(call.args);
    } catch {
      continue;
    }
    const s = findSkill(skills, args.skill ?? "");
    if (s) out.push(skillBody(s, args.args ?? ""));
  }
  return out;
}

// Keep the tool list in step with the skill set: the `skill` tool exists while
// at least one model-invocable skill does. Called before every model call, so
// the first skill dropped into a folder mid-session brings the tool with it.
export function syncSkillTool(skills: Skill[]): void {
  const wanted = skills.some((s) => !s.disableModelInvocation);
  if (wanted && !tools.skill) registerExternalTool(buildSkillTool());
  if (!wanted && tools.skill) unregisterExternalTool("skill");
}

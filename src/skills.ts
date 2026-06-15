import fs from "node:fs"; // discover and read SKILL.md files
import os from "node:os"; // the global skills dir
import path from "node:path"; // path resolution
import type { Tool } from "./tools.js"; // a skill is exposed to the model as a tool

// Skills: reusable procedures written as plain Markdown, executed by the MODEL,
// not by code. A skill is a folder with a SKILL.md — YAML-ish frontmatter (what
// it is, when to use it) + a Markdown body (the steps). The bar to add one is
// "can you write Markdown"; editing it takes effect immediately, no release.
//
// Progressive disclosure (the key idea): the model only ever sees a one-line
// LISTING of each skill (name + when-to-use) until it decides to invoke one —
// only then is the full body loaded. So a hundred skills cost almost no context.
//
// This is the core of the handbook's §18 — not the full industrial version
// (no skillify auto-distill, no worktree batch, no plugin trust contracts).

export interface Skill {
  name: string; // unique id, also how the model invokes it
  description: string; // what it does
  whenToUse: string; // the trigger — this is what the model matches against
  allowedTools: string[]; // the tools the skill should use (least privilege; advisory here)
  disableModelInvocation: boolean; // true → only the user can trigger it (/skill name), the model can't
  body: string; // the Markdown instructions
  path: string; // where it came from
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
  return {
    name: fm.name || fallbackName,
    description: fm.description || "",
    whenToUse: fm.when_to_use || fm.whenToUse || fm.description || "",
    allowedTools: (fm["allowed-tools"] || fm.allowedTools || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    disableModelInvocation: /^true$/i.test(fm.disableModelInvocation || fm["disable-model-invocation"] || ""),
    body,
    path: filePath,
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

export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const n = name.trim().toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === n);
}

const MAX_DESC = 250; // cap each skill's listing line (handbook MAX_LISTING_DESC_CHARS)
const LIST_BUDGET = 8000; // cap the whole listing (handbook DEFAULT_CHAR_BUDGET)

// The one-line-per-skill listing the model sees (name + when-to-use), budget
// capped. This is the "progressive disclosure" surface: enough to decide whether
// to invoke, not the full body.
export function skillListing(skills: Skill[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const s of skills) {
    const desc = (s.whenToUse || s.description).replace(/\s+/g, " ").slice(0, MAX_DESC);
    const line = `- ${s.name}: ${desc}`;
    if (used + line.length > LIST_BUDGET) break; // out of budget — stop listing
    used += line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

// What gets handed back when a skill is invoked: the body, plus a reminder of
// its allowed tools (least-privilege is advisory here — the permission gate
// still governs every actual call).
export function skillInstructions(s: Skill): string {
  const tools = s.allowedTools.length ? `\n\n[This skill should use only these tools: ${s.allowedTools.join(", ")}. Other actions still go through the normal permission gate.]` : "";
  return `# Skill: ${s.name}\n\nFollow these steps:\n\n${s.body}${tools}`;
}

// Build the `skill` tool from the model-invocable skills. The tool's description
// IS the listing, so the model learns what skills exist and when to use them;
// calling it with a name returns that skill's full instructions.
export function buildSkillTool(skills: Skill[]): Tool {
  const invokable = skills.filter((s) => !s.disableModelInvocation);
  const listing = skillListing(invokable) || "(none)";
  return {
    definition: {
      type: "function",
      function: {
        name: "skill",
        description: `Load and follow a reusable skill — a saved, named procedure. Call this when the user's request matches one of the skills below; it returns step-by-step instructions you then carry out yourself.
Available skills:
${listing}
Pass the exact skill name. If nothing matches, do not call this — just answer normally.`,
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "The exact skill name to load" } },
          required: ["name"],
        },
      },
    },
    run: (args) => {
      const s = findSkill(skills, args.name ?? "");
      if (!s) return `[error] No skill named "${args.name}". Available: ${invokable.map((x) => x.name).join(", ") || "none"}.`;
      if (s.disableModelInvocation) return `[error] Skill "${s.name}" can only be invoked by the user, not by you.`;
      return skillInstructions(s);
    },
  };
}

import fs from "node:fs"; // create skill folders to load
import os from "node:os"; // temp location
import path from "node:path"; // join paths
import { parseSkill, loadSkills, findSkill, skillListing, skillInstructions, buildSkillTool } from "../src/skills.js"; // unit under test
import { check, checkContains, finish } from "./helpers.js"; // assertions

// ---- parseSkill: frontmatter + body ----------------------------------------------------
{
  const raw = `---
name: changelog
description: Update the changelog
when_to_use: When the user asks to add a changelog entry
allowed-tools: Read, edit_file
disableModelInvocation: true
---
1. Read CHANGELOG.md
2. Add the entry at the top`;
  const s = parseSkill(raw, "fallback");
  check("name from frontmatter", s.name === "changelog");
  check("when_to_use parsed", s.whenToUse === "When the user asks to add a changelog entry");
  check("allowed-tools split", JSON.stringify(s.allowedTools) === JSON.stringify(["Read", "edit_file"]));
  check("disableModelInvocation parsed", s.disableModelInvocation === true);
  checkContains("body excludes frontmatter", s.body, "Read CHANGELOG.md");
  check("body really excludes the fence", !s.body.includes("when_to_use"));
}
check("missing frontmatter → fallback name, whole text is body", parseSkill("just steps", "myskill").name === "myskill");
check("when_to_use falls back to description", parseSkill("---\ndescription: hi\n---\nbody", "x").whenToUse === "hi");
check("disableModelInvocation defaults false", parseSkill("---\nname: a\n---\nb", "a").disableModelInvocation === false);

// ---- loadSkills: discovery (project dir injected) --------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-skills-"));
const writeSkill = (name: string, content: string) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), content);
};
writeSkill("greet", "---\nname: greet\nwhen_to_use: say hello\n---\nSay hi to the user.");
writeSkill("deploy", "---\nname: deploy\nwhen_to_use: ship to prod\ndisableModelInvocation: true\n---\nRun the deploy steps.");
fs.mkdirSync(path.join(dir, "not-a-skill")); // no SKILL.md — must be skipped

const skills = loadSkills([dir]);
check("loads the two valid skills, skips the empty dir", skills.length === 2);
check("finds a skill by name (case-insensitive)", findSkill(skills, "GREET")?.name === "greet");
check("missing skill → undefined", findSkill(skills, "nope") === undefined);

// ---- listing only mentions name + when-to-use -----------------------------------------
const listing = skillListing(skills);
checkContains("listing has the skill name", listing, "greet");
checkContains("listing has the trigger", listing, "say hello");
check("listing does not include the body", !listing.includes("Say hi to the user"));

// ---- instructions return the body -----------------------------------------------------
const inst = skillInstructions(findSkill(skills, "greet")!);
checkContains("instructions include the body", inst, "Say hi to the user");

// ---- the skill tool exposes only model-invocable skills -------------------------------
const tool = buildSkillTool(skills);
check("tool is named skill", tool.definition.function.name === "skill");
checkContains("tool description lists the invocable skill", tool.definition.function.description ?? "", "greet");
check("tool description hides the user-only skill", !(tool.definition.function.description ?? "").includes("deploy"));
checkContains("invoking a skill returns its instructions", String(await tool.run({ name: "greet" })), "Say hi");
checkContains("invoking a user-only skill via the tool is refused", String(await tool.run({ name: "deploy" })), "only be invoked by the user");
checkContains("invoking an unknown skill errors", String(await tool.run({ name: "ghost" })), "No skill named");

fs.rmSync(dir, { recursive: true, force: true });
finish();

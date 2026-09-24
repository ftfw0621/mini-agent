import fs from "node:fs"; // create skill folders to load
import os from "node:os"; // temp location
import path from "node:path"; // join paths
import type OpenAI from "openai"; // message shapes
import { parseSkill, loadSkills, allSkills, skillMode, setSkillMode, nextSkillMode, skillLocked, skillPanelRows, skillListingTokens, currentSkills, findSkill, skillListing, skillListingReminder, skillBody, skillBodyMessages, substituteArguments, userSkillMessages, buildSkillTool } from "../src/skills.js"; // unit under test
import { runLoop, TerminateReason } from "../src/loop.js"; // the end-to-end wiring
import { CONFIG } from "../src/config.js"; // hooks off for the loop run
import { tools } from "../src/tools.js"; // is the skill tool registered?
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
check("description falls back to the body's first line (Claude Code)", parseSkill("---\nname: x\n---\n# Tidy up\nsteps", "x").description === "Tidy up");
check("disableModelInvocation defaults false", parseSkill("---\nname: a\n---\nb", "a").disableModelInvocation === false);

// ---- loadSkills: discovery (project dir injected) --------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-skills-"));
const writeSkill = (name: string, content: string) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), content);
};
writeSkill("greet", "---\nname: greet\ndescription: Greet the user\nwhen_to_use: say hello\n---\nSay hi to the user.");
writeSkill("deploy", "---\nname: deploy\nwhen_to_use: ship to prod\ndisableModelInvocation: true\n---\nRun the deploy steps.");
fs.mkdirSync(path.join(dir, "not-a-skill")); // no SKILL.md — must be skipped

const skills = loadSkills([dir]);
check("loads the two valid skills, skips the empty dir", skills.length === 2);
check("finds a skill by name (case-insensitive)", findSkill(skills, "GREET")?.name === "greet");
check("missing skill → undefined", findSkill(skills, "nope") === undefined);

// ---- listing only mentions name + when-to-use -----------------------------------------
const listing = skillListing(skills).join("\n");
checkContains("listing has the skill name", listing, "greet");
checkContains("listing has the trigger", listing, "say hello");
check("listing does not include the body", !listing.includes("Say hi to the user"));
check("over budget: descriptions shrink, no skill is dropped", skillListing(skills, 30).length === 2);

// ---- the listing is a <system-reminder> user message, sent as a delta -------------------
const history: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: "hi" }];
const first = skillListingReminder(history, skills);
checkContains("listing is wrapped in system-reminder", first ?? "", "<system-reminder>\nThe following skills are available for use with the skill tool:");
check("listing hides the user-only skill", !(first ?? "").includes("deploy"));
history.push({ role: "user", content: first! });
check("already-listed skills are not re-sent", skillListingReminder(history, skills) === null);
const more = [...skills, parseSkill("---\nname: lint\ndescription: Run the linter\n---\nnpm run lint", "lint")];
const delta = skillListingReminder(history, more) ?? "";
check("a new skill is sent alone (delta)", delta.includes("- lint: Run the linter") && !delta.includes("greet"));
const edited = skills.map((x) => (x.name === "greet" ? { ...x, whenToUse: "say hello warmly" } : x));
checkContains("an edited skill's new line is re-sent", skillListingReminder(history, edited) ?? "", "say hello warmly");
check("after /clear (empty history) the full listing goes out again", (skillListingReminder([], skills) ?? "").includes("greet"));

// ---- body + arguments -----------------------------------------------------------------
const greet = findSkill(skills, "greet")!;
check("findSkill accepts a leading slash", findSkill(skills, "/greet") === greet);
checkContains("body starts with the base directory", skillBody(greet), `Base directory for this skill: ${path.join(dir, "greet")}`);
checkContains("body includes the instructions", skillBody(greet), "Say hi to the user");
check("$ARGUMENTS is substituted", substituteArguments("deploy $ARGUMENTS now", "v2 prod") === "deploy v2 prod now");
check("$0 / $ARGUMENTS[1] pick single arguments", substituteArguments("$0 then $ARGUMENTS[1]", "a b") === "a then b");
checkContains("no placeholder → arguments appended", substituteArguments("steps", "x y"), "\n\nARGUMENTS: x y");
const [marker, userBody] = userSkillMessages(greet, "Bob");
check("user invocation sends the <command-name> marker", marker === "<command-message>greet</command-message>\n<command-name>/greet</command-name>\n<command-args>Bob</command-args>");
checkContains("...then the body", userBody, "Say hi to the user");

// ---- the skill tool: static manual, "Launching skill" result ----------------------------
const tool = buildSkillTool(() => skills);
check("tool is named skill", tool.definition.function.name === "skill");
check("tool manual is static — no skill names in it", !(tool.definition.function.description ?? "").includes("greet"));
check("invoking a skill returns only the launch line", String(await tool.run({ skill: "greet" })) === "Launching skill: greet");
checkContains("invoking a user-only skill via the tool is refused", String(await tool.run({ skill: "deploy" })), "disable-model-invocation");
checkContains("invoking an unknown skill errors", String(await tool.run({ skill: "ghost" })), "Unknown skill: ghost");
{
  const calls = [{ id: "a", name: "skill", args: JSON.stringify({ skill: "greet", args: "Bob" }) }, { id: "b", name: "skill", args: JSON.stringify({ skill: "deploy" }) }];
  const msgs: OpenAI.ChatCompletionMessageParam[] = [{ role: "tool", tool_call_id: "a", content: "Launching skill: greet" }, { role: "tool", tool_call_id: "b", content: "[error] refused" }];
  const bodies = skillBodyMessages(calls, msgs, skills);
  check("a body follows only a successful launch", bodies.length === 1 && bodies[0].includes("Say hi to the user") && bodies[0].includes("ARGUMENTS: Bob"));
}

// ---- /skills: on · user-only · off --------------------------------------------------------
{
  const before = { ...CONFIG.skillOverrides };
  const g = findSkill(allSkills([dir]), "greet")!;
  const d = findSkill(allSkills([dir]), "deploy")!;
  check("a skill is on by default", skillMode(g) === "on");
  check("an author-pinned skill is locked user-only", skillLocked(d) && skillMode(d) === "user-only");
  check("cycle order: on → user-only → off → on", nextSkillMode("on") === "user-only" && nextSkillMode("user-only") === "off" && nextSkillMode("off") === "on");
  setSkillMode("greet", "user-only", false);
  const hidden = findSkill(currentSkills([dir]), "greet");
  check("user-only keeps it runnable by the user but hides it from the model", hidden?.disableModelInvocation === true);
  check("user-only drops it from the model's listing", !(skillListingReminder([], currentSkills([dir])) ?? "").includes("- greet"));
  setSkillMode("greet", "off", false);
  check("off removes it from the skills in effect", findSkill(currentSkills([dir]), "greet") === undefined);
  check("off still shows in the manager", findSkill(allSkills([dir]), "greet") !== undefined);
  setSkillMode("greet", "on", false);
  check("on stores nothing (the default)", !("greet" in CONFIG.skillOverrides) && findSkill(currentSkills([dir]), "greet")?.disableModelInvocation === false);
  check("manager search matches name or description", skillPanelRows(allSkills([dir]), "hello", "name").length === 0 && skillPanelRows(allSkills([dir]), "gree", "name")[0]?.name === "greet");
  check("manager sorts by name", skillPanelRows(allSkills([dir]), "", "name").map((x) => x.name).join() === "deploy,greet");
  check("listing cost is a positive token estimate", skillListingTokens(g) > 0);
  CONFIG.skillOverrides = before;
}

// ---- hot reload: currentSkills picks up adds, edits, removals --------------------------
check("currentSkills sees the starting set", currentSkills([dir]).length === 2);
writeSkill("lint", "---\nname: lint\ndescription: Run the linter\n---\nnpm run lint");
check("a new SKILL.md is picked up without a restart", findSkill(currentSkills([dir]), "lint") !== undefined);
writeSkill("lint", "---\nname: lint\ndescription: Run the linter and fix everything\n---\nnpm run lint -- --fix");
check("an edited SKILL.md is re-read", findSkill(currentSkills([dir]), "lint")?.description === "Run the linter and fix everything");
fs.rmSync(path.join(dir, "lint"), { recursive: true });
check("a removed skill disappears", findSkill(currentSkills([dir]), "lint") === undefined);

fs.rmSync(dir, { recursive: true, force: true });

// ---- end to end through runLoop: reminder before the call, body after the result ------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-skills-home-"));
  const cwd = process.cwd();
  const homeBefore = process.env.HOME;
  const hooksBefore = CONFIG.hooks;
  process.env.HOME = home; // no real global skills leak in
  process.chdir(home); // ...and no real project skills either
  CONFIG.hooks = {};
  const skillDir = path.join(home, ".mini-agent", "skills", "greet");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: greet\ndescription: Greet people\n---\nSay hi to $ARGUMENTS.");
  const requests: OpenAI.ChatCompletionMessageParam[][] = [];
  let round = 0;
  const client = { chat: { completions: { create: async (params: { messages: OpenAI.ChatCompletionMessageParam[] }) => {
    requests.push(structuredClone(params.messages));
    const r = round++;
    if (r === 0) fs.mkdirSync(path.join(home, ".mini-agent", "skills", "wave"), { recursive: true }), fs.writeFileSync(path.join(home, ".mini-agent", "skills", "wave", "SKILL.md"), "---\nname: wave\ndescription: Wave at people\n---\nWave.");
    return (async function* () {
      if (r === 0) yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "s1", function: { name: "skill", arguments: JSON.stringify({ skill: "greet", args: "Ada" }) } }] } }] };
      else yield { choices: [{ delta: { content: "Hi Ada!" } }] };
    })();
  } } } };
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: "sys" }, { role: "user", content: "say hi to Ada" }];
  const result = await runLoop(messages, { client: client as never, model: "fake", quiet: true, signal: new AbortController().signal, isInterrupted: () => false, confirm: async () => true });
  const [r0, r1] = requests;
  check("loop finishes", result.reason === TerminateReason.Done && round === 2);
  check("skill tool is registered once a skill exists", "skill" in tools);
  check("first call: listing arrives as a system-reminder user message after the prompt", r0.at(-1)?.role === "user" && String(r0.at(-1)?.content).includes("- greet: Greet people"));
  const toolIdx = r1.findIndex((m) => m.role === "tool" && m.tool_call_id === "s1");
  check("tool result is just the launch line", r1[toolIdx]?.content === "Launching skill: greet");
  checkContains("body follows the tool result as a user message", String(r1[toolIdx + 1]?.role === "user" ? r1[toolIdx + 1].content : ""), "Say hi to Ada.");
  const wave = r1.slice(toolIdx + 2).find((m) => m.role === "user" && String(m.content).startsWith("<system-reminder>"));
  check("a skill added mid-turn is listed on the next call, alone", !!wave && String(wave.content).includes("- wave:") && !String(wave.content).includes("- greet:"));
  process.chdir(cwd);
  process.env.HOME = homeBefore;
  CONFIG.hooks = hooksBefore;
  fs.rmSync(home, { recursive: true, force: true });
}
finish();

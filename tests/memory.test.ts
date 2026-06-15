import fs from "node:fs"; // inspect the memory file
import os from "node:os"; // run in a temp cwd so we don't touch the real .mini-agent
import path from "node:path"; // path joining
import { check, checkContains, finish } from "./helpers.js"; // assertions

// memory.ts writes to ./.mini-agent/MEMORY.md relative to cwd, so run the whole
// suite inside a throwaway directory. (MEMORY_PATH is resolved at import time,
// so we chdir BEFORE importing memory.ts — done via a dynamic import below.)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-test-mem-"));
process.chdir(dir);
const { rememberTool, readMemory, readMemoryTyped, memoryContext, addFact, parseExtractedMemories, extractMemories, MEMORY_PATH } = await import("../src/memory.js");

// ---- empty state ----------------------------------------------------------------------
check("no memory file → no facts", readMemory().length === 0);
check("no memory → empty context block", memoryContext() === "");

// ---- the remember tool persists a fact -------------------------------------------------
const r1 = await rememberTool.run({ fact: "the build command is npm run build" });
checkContains("remember confirms", r1, "Remembered");
check("fact is on disk", fs.readFileSync(MEMORY_PATH, "utf8").includes("the build command is npm run build"));
check("readMemory sees it", readMemory().includes("the build command is npm run build"));

// ---- it survives a 'reload' (fresh read from disk) ------------------------------------
check("context block now includes the fact", memoryContext().includes("the build command is npm run build"));

// ---- dedup: remembering the same thing twice is a no-op -------------------------------
await rememberTool.run({ fact: "the build command is npm run build" });
check("no duplicate entry", readMemory().filter((f) => f.includes("build command")).length === 1);

// ---- whitespace normalization + empty rejected ---------------------------------------
await rememberTool.run({ fact: "  tabs\tand   spaces\n collapse  " });
check("whitespace collapsed to one line", readMemory().some((f) => f === "tabs and spaces collapse"));
checkContains("empty fact rejected", await rememberTool.run({ fact: "   " }), "[error]");

// ---- the count cap drops the OLDEST -----------------------------------------------------
for (let i = 0; i < 50; i++) await rememberTool.run({ fact: `fact number ${i}` });
const facts = readMemory();
check("count capped at 40", facts.length <= 40, String(facts.length));
check("oldest dropped (fact 0 gone)", !facts.includes("fact number 0"));
check("newest kept (fact 49 present)", facts.includes("fact number 49"));

// ---- self-healing: a hand-edited huge file is shrunk on next write --------------------
fs.writeFileSync(MEMORY_PATH, "# header\n" + Array.from({ length: 500 }, (_, i) => `- bloat line ${i}`).join("\n") + "\n");
check("hand-edited file is over the cap before a write", readMemory().length > 40);
await rememberTool.run({ fact: "a fresh fact after bloat" });
check("next write heals the count cap", readMemory().length <= 40, String(readMemory().length));
check("byte cap enforced", Buffer.byteLength(fs.readFileSync(MEMORY_PATH, "utf8"), "utf8") <= 12200);
check("the fresh fact made it in", readMemory().includes("a fresh fact after bloat"));

// ---- typed memories (Day 34) ----------------------------------------------------------
fs.rmSync(MEMORY_PATH, { force: true }); // clean slate
addFact("the user prefers spaces over tabs", "user");
addFact("always run pants fmt before committing", "feedback");
addFact("the build command is pnpm build", "project");
{
  const typed = readMemoryTyped();
  check("type is parsed back", typed.find((e) => e.fact.includes("pants fmt"))?.type === "feedback");
  check("readMemory still returns plain fact text (no prefix)", readMemory().includes("the build command is pnpm build"));
}
{
  const ctx = memoryContext();
  checkContains("context groups feedback under a heading", ctx, "Guidance & corrections");
  checkContains("context includes the user fact", ctx, "prefers spaces over tabs");
}
// a bare (legacy) line parses as "project"
fs.writeFileSync(MEMORY_PATH, "# h\n- a legacy untyped fact\n");
check("legacy untyped line → project type", readMemoryTyped()[0].type === "project");
check("an unknown type tag falls back to project", (addFact("x", "bogus" as never), readMemoryTyped().find((e) => e.fact === "x")?.type) === "project");

// ---- parseExtractedMemories -----------------------------------------------------------
check("parses a clean JSON array", parseExtractedMemories('[{"type":"feedback","fact":"do X"}]').length === 1);
check("tolerates surrounding prose / fences", parseExtractedMemories('Here:\n```json\n[{"type":"user","fact":"likes Vim"}]\n```').length === 1);
check("drops items with no fact", parseExtractedMemories('[{"type":"user"},{"fact":"keep me"}]').length === 1);
check("unknown type → project", parseExtractedMemories('[{"type":"weird","fact":"f"}]')[0].type === "project");
check("non-array → empty", parseExtractedMemories("not json at all").length === 0);
check("empty array → empty", parseExtractedMemories("[]").length === 0);

// ---- extractMemories end-to-end with a fake client ------------------------------------
fs.rmSync(MEMORY_PATH, { force: true });
const fakeClient = {
  chat: { completions: { create: async () => ({ choices: [{ message: { content: '[{"type":"feedback","fact":"the user corrected the import order"}]' } }] }) } },
} as never;
const saved = await extractMemories(fakeClient, "m", [
  { role: "user", content: "use spaces not tabs" },
  { role: "assistant", content: "fixed" },
]);
check("extraction saved the fact", saved.length === 1 && saved[0].type === "feedback");
check("the extracted fact is on disk", readMemory().some((f) => f.includes("corrected the import order")));
check("extraction with an empty transcript saves nothing", (await extractMemories(fakeClient, "m", [])).length === 0);

finish();

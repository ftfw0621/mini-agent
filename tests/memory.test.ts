import fs from "node:fs"; // inspect the memory file
import os from "node:os"; // run in a temp cwd so we don't touch the real .mini-agent
import path from "node:path"; // path joining
import { check, checkContains, finish } from "./helpers.js"; // assertions

// memory.ts writes to ./.mini-agent/MEMORY.md relative to cwd, so run the whole
// suite inside a throwaway directory. (MEMORY_PATH is resolved at import time,
// so we chdir BEFORE importing memory.ts — done via a dynamic import below.)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-test-mem-"));
process.chdir(dir);
const { rememberTool, readMemory, memoryContext, MEMORY_PATH } = await import("../src/memory.js");

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
for (let i = 0; i < 40; i++) await rememberTool.run({ fact: `fact number ${i}` });
const facts = readMemory();
check("count capped at 30", facts.length <= 30, String(facts.length));
check("oldest dropped (fact 0 gone)", !facts.includes("fact number 0"));
check("newest kept (fact 39 present)", facts.includes("fact number 39"));

// ---- self-healing: a hand-edited huge file is shrunk on next write --------------------
fs.writeFileSync(MEMORY_PATH, "# header\n" + Array.from({ length: 500 }, (_, i) => `- bloat line ${i}`).join("\n") + "\n");
check("hand-edited file is over the cap before a write", readMemory().length > 30);
await rememberTool.run({ fact: "a fresh fact after bloat" });
check("next write heals the count cap", readMemory().length <= 30, String(readMemory().length));
check("byte cap enforced", Buffer.byteLength(fs.readFileSync(MEMORY_PATH, "utf8"), "utf8") <= 8200);
check("the fresh fact made it in", readMemory().includes("a fresh fact after bloat"));

finish();

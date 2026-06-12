import fs from "node:fs"; // fixture files
import os from "node:os"; // temp directory
import path from "node:path"; // path joining
import { dispatch } from "../src/tools.js"; // the unit under test
import { checkContains, check, finish } from "./helpers.js"; // assertions

// A scratch file in a fresh temp dir — every run starts clean.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-test-tools-"));
const f = path.join(dir, "sandbox.txt");
fs.writeFileSync(f, "aaa\nbbb\naaa\n"); // two duplicate lines on purpose

// ---- read-before-edit ----------------------------------------------------------
checkContains("edit before read blocked", dispatch("edit_file", JSON.stringify({ path: f, old_string: "bbb", new_string: "xxx" })), "have not read");
checkContains("overwrite before read blocked", dispatch("write_file", JSON.stringify({ path: f, content: "new" })), "already exists but you have not read");
dispatch("read_file", JSON.stringify({ path: f })); // unlock the file by reading it

// ---- old_string discipline -------------------------------------------------------
checkContains("non-unique old_string rejected", dispatch("edit_file", JSON.stringify({ path: f, old_string: "aaa", new_string: "xxx" })), "appears 2 times");
checkContains("missing old_string rejected", dispatch("edit_file", JSON.stringify({ path: f, old_string: "zzz", new_string: "xxx" })), "not found");
checkContains("unique edit succeeds", dispatch("edit_file", JSON.stringify({ path: f, old_string: "bbb", new_string: "BBB" })), "1 replacement made");
checkContains("edit really applied", fs.readFileSync(f, "utf8"), "BBB");

// ---- search ----------------------------------------------------------------------
const srcDir = path.resolve(import.meta.dirname, "../src"); // search our own source tree
checkContains("search finds constant", dispatch("search", JSON.stringify({ pattern: "TOOL_RESULT_LIMIT", path: srcDir })), "tools.ts:");
const globHits = dispatch("search", JSON.stringify({ pattern: "tool-calling", path: path.resolve(import.meta.dirname, ".."), file_glob: "*.md" }));
checkContains("search glob filter", globHits, "README.md:");
check("glob excludes non-md", !globHits.includes(".ts:"), "a .ts file leaked through the *.md glob");
checkContains("invalid regex error", dispatch("search", JSON.stringify({ pattern: "[" })), "Invalid regex");

// ---- dispatch resilience ----------------------------------------------------------
checkContains("unknown tool error", dispatch("nope", "{}"), "Unknown tool");
checkContains("bad json error", dispatch("read_file", "{oops"), "not valid JSON");

// ---- the String.replace $ trap ------------------------------------------------------
fs.writeFileSync(f, "const x = 1;\n"); // reset the fixture
dispatch("read_file", JSON.stringify({ path: f })); // re-read (content changed on disk)
dispatch("edit_file", JSON.stringify({ path: f, old_string: "const x = 1;", new_string: "const re = `$&-$'`;" }));
checkContains("dollar signs preserved", fs.readFileSync(f, "utf8"), "const re = `$&-$'`;");

finish();

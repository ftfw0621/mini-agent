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
checkContains("edit before read blocked", await dispatch("edit_file", JSON.stringify({ path: f, old_string: "bbb", new_string: "xxx" })), "have not read");
checkContains("overwrite before read blocked", await dispatch("write_file", JSON.stringify({ path: f, content: "new" })), "already exists but you have not read");
await dispatch("read_file", JSON.stringify({ path: f })); // unlock the file by reading it

// ---- old_string discipline -------------------------------------------------------
checkContains("non-unique old_string rejected", await dispatch("edit_file", JSON.stringify({ path: f, old_string: "aaa", new_string: "xxx" })), "appears 2 times");
checkContains("missing old_string rejected", await dispatch("edit_file", JSON.stringify({ path: f, old_string: "zzz", new_string: "xxx" })), "not found");
checkContains("unique edit succeeds", await dispatch("edit_file", JSON.stringify({ path: f, old_string: "bbb", new_string: "BBB" })), "1 replacement made");
checkContains("edit really applied", fs.readFileSync(f, "utf8"), "BBB");

// ---- search ----------------------------------------------------------------------
const srcDir = path.resolve(import.meta.dirname, "../src"); // search our own source tree
checkContains("search finds constant", await dispatch("search", JSON.stringify({ pattern: "TOOL_RESULT_LIMIT", path: srcDir })), "tools.ts:");
const globHits = await dispatch("search", JSON.stringify({ pattern: "tool-calling", path: path.resolve(import.meta.dirname, ".."), file_glob: "*.md" }));
checkContains("search glob filter", globHits, "README.md:");
check("glob excludes non-md", !globHits.includes(".ts:"), "a .ts file leaked through the *.md glob");
checkContains("invalid regex error", await dispatch("search", JSON.stringify({ pattern: "[" })), "Invalid regex");

// ---- dispatch resilience ----------------------------------------------------------
checkContains("unknown tool error", await dispatch("nope", "{}"), "Unknown tool");
checkContains("bad json error", await dispatch("read_file", "{oops"), "not valid JSON");

// ---- the String.replace $ trap ------------------------------------------------------
fs.writeFileSync(f, "const x = 1;\n"); // reset the fixture
await dispatch("read_file", JSON.stringify({ path: f })); // re-read (content changed on disk)
await dispatch("edit_file", JSON.stringify({ path: f, old_string: "const x = 1;", new_string: "const re = `$&-$'`;" }));
checkContains("dollar signs preserved", fs.readFileSync(f, "utf8"), "const re = `$&-$'`;");

// ---- async run_bash (Day 13) --------------------------------------------------------
checkContains("run_bash returns output", await dispatch("run_bash", JSON.stringify({ command: "echo hi-from-bash" })), "hi-from-bash");
checkContains("non-zero exit surfaces error", await dispatch("run_bash", JSON.stringify({ command: "ls /no/such/xyz" })), "exited with code");
checkContains("huge output spills to a file", await dispatch("run_bash", JSON.stringify({ command: "yes ABCDEFGHIJ | head -n 4000" })), "use read_file");

// Abort kills a long command immediately instead of waiting out the timeout.
const ctrl = new AbortController();
const t0 = Date.now();
setTimeout(() => ctrl.abort(), 200); // simulate Ctrl+C
const aborted = await dispatch("run_bash", JSON.stringify({ command: "sleep 10" }), ctrl.signal);
check("abort kills fast", aborted.includes("interrupted") && Date.now() - t0 < 3000, `${Date.now() - t0}ms: ${aborted}`);

// run_bash is async: the event loop keeps running while a command is in flight.
let tickedDuringRun = false;
const inFlight = dispatch("run_bash", JSON.stringify({ command: "sleep 0.4" }));
setTimeout(() => (tickedDuringRun = true), 100); // would never fire under a blocking execSync
await inFlight;
check("event loop stays responsive during a command", tickedDuringRun, "a timer did not fire while run_bash ran — the loop was blocked");

finish();

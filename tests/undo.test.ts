import fs from "node:fs"; // create/inspect files the tools change
import os from "node:os"; // a scratch directory
import path from "node:path"; // join scratch paths
import { recordMutation, undoLast, undoDepth, clearUndo } from "../src/undo.js"; // unit under test
import { dispatch } from "../src/tools.js"; // end-to-end: a real write then /undo's restore
import { check, checkContains, finish } from "./helpers.js"; // assertions

// A fresh scratch dir so the write tools' read-before-write rules are easy to satisfy.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-undo-"));
const file = path.join(dir, "note.txt");

// ---- recordMutation + undoLast: restore previous content --------------------------------
fs.writeFileSync(file, "version one\n");
recordMutation(file); // snapshot before changing
fs.writeFileSync(file, "version two\n"); // the "change"
check("one mutation recorded", undoDepth() === 1);
const r1 = undoLast();
check("undo reports the file", r1?.path === file);
check("content restored to previous", fs.readFileSync(file, "utf8") === "version one\n");
check("stack is empty after undo", undoDepth() === 0);
check("undo with empty stack returns null", undoLast() === null);

// ---- a freshly CREATED file is removed by undo ------------------------------------------
const created = path.join(dir, "fresh.txt");
recordMutation(created); // nothing on disk yet → before = null
fs.writeFileSync(created, "brand new\n");
const r2 = undoLast();
check("undoing a create deletes the file", !fs.existsSync(created));
checkContains("summary says it was created", r2?.summary ?? "", "created");

// ---- LIFO order: undo peels back most-recent first --------------------------------------
fs.writeFileSync(file, "A\n");
recordMutation(file);
fs.writeFileSync(file, "B\n");
recordMutation(file);
fs.writeFileSync(file, "C\n");
undoLast(); // C -> B
check("first undo restores the most recent", fs.readFileSync(file, "utf8") === "B\n");
undoLast(); // B -> A
check("second undo peels back one more", fs.readFileSync(file, "utf8") === "A\n");
clearUndo();
check("clearUndo empties the history", undoDepth() === 0);

// ---- end-to-end through the real edit_file tool -----------------------------------------
fs.writeFileSync(file, "const x = 1;\n");
await dispatch("read_file", JSON.stringify({ path: file })); // satisfy read-before-edit
const edited = await dispatch("edit_file", JSON.stringify({ path: file, old_string: "const x = 1;", new_string: "const x = 2;" }));
checkContains("the edit applied", edited, "1 replacement");
check("file now holds the edit", fs.readFileSync(file, "utf8") === "const x = 2;\n");
check("the real edit was recorded for undo", undoDepth() === 1);
const r3 = undoLast();
check("undo reverts the real edit on disk", fs.readFileSync(file, "utf8") === "const x = 1;\n");
checkContains("undo exposes before/after for the diff", `${r3?.before}|${r3?.after}`, "const x = 1;");

fs.rmSync(dir, { recursive: true, force: true }); // clean up
finish();

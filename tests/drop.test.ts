import fs from "node:fs"; // create real files to drop
import os from "node:os"; // temp location
import path from "node:path"; // join paths
import { EventEmitter } from "node:events"; // a fake stdin to drive the editor
import { normalizeDroppedPaths } from "../src/drop.js"; // unit under test
import { editLine } from "../src/editor.js"; // confirm the paste transform is wired into the editor
import { check, finish } from "./helpers.js"; // assertions

// A drop is recognized only for EXISTING absolute paths, so make some real files.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-drop-"));
const plain = path.join(dir, "notes.txt");
const spaced = path.join(dir, "my file.txt");
const second = path.join(dir, "data.json");
fs.writeFileSync(plain, "x");
fs.writeFileSync(spaced, "x");
fs.writeFileSync(second, "x");

// ---- a single dropped file: backslash-escaped, trailing space (macOS Terminal) ----
const escaped = spaced.replace(/ /g, "\\ ") + " "; // /tmp/.../my\ file.txt␣
const r1 = normalizeDroppedPaths(escaped);
check("an escaped path is unescaped to its absolute form", r1.includes(spaced), `${r1}`);
check("a path with spaces comes back quoted", r1.trim() === `'${spaced}'`, r1);
check("a successful drop ends with a trailing space (ready to type)", r1.endsWith(" "));

// a plain path with no spaces needs no quoting
check("a no-space path is left unquoted", normalizeDroppedPaths(plain + " ").trim() === plain, normalizeDroppedPaths(plain));

// ---- multiple dropped files ------------------------------------------------------
const multi = `${plain} ${spaced.replace(/ /g, "\\ ")} ${second} `;
const rm = normalizeDroppedPaths(multi);
check("all dropped paths are present", rm.includes(plain) && rm.includes(spaced) && rm.includes(second), rm);
check("only the spaced one is quoted", rm.includes(`'${spaced}'`) && !rm.includes(`'${plain}'`), rm);

// ---- single-quoted drop (iTerm style) --------------------------------------------
check("a single-quoted path is unwrapped + kept absolute", normalizeDroppedPaths(`'${spaced}' `).trim() === `'${spaced}'`, normalizeDroppedPaths(`'${spaced}'`));

// ---- a leading ~ is expanded to home ---------------------------------------------
const homeFile = path.join(os.homedir(), ".mini-agent-drop-probe");
fs.writeFileSync(homeFile, "x");
try {
  check("a ~ path is expanded to an absolute home path", normalizeDroppedPaths("~/.mini-agent-drop-probe ").trim() === homeFile, normalizeDroppedPaths("~/.mini-agent-drop-probe"));
} finally {
  fs.rmSync(homeFile, { force: true });
}

// ---- NOT a drop: ordinary text and non-existent / relative paths are untouched ----
check("ordinary pasted prose is returned unchanged", normalizeDroppedPaths("hello there, how are you") === "hello there, how are you");
check("a non-existent absolute path is left alone", normalizeDroppedPaths("/no/such/file/here.txt") === "/no/such/file/here.txt");
check("a relative path is left alone (drags are absolute)", normalizeDroppedPaths("notes.txt") === "notes.txt");
check("a mix of a real file and prose is left alone", normalizeDroppedPaths(`${plain} and some words`) === `${plain} and some words`);
check("empty input is returned unchanged", normalizeDroppedPaths("") === "");

// ---- the editor actually applies the transform on a "dropped" paste --------------
// Drive editLine through a fake TTY: emit a paste keypress (the dropped path), then
// Enter, and confirm the submitted line is the normalized absolute path.
{
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: () => boolean }).write = () => true; // swallow the editor's repaint codes
  try {
    const s = new EventEmitter() as unknown as { isTTY: boolean; setRawMode: () => void; resume: () => void; pause: () => void };
    s.isTTY = true;
    s.setRawMode = () => {};
    s.resume = () => {};
    s.pause = () => {};
    const input = s as unknown as NodeJS.ReadStream;
    const rlStub = { pause() {}, resume() {} } as unknown as import("node:readline").Interface;
    const p = editLine(rlStub, { prompt: "> ", input, transformPaste: normalizeDroppedPaths });
    (input as unknown as EventEmitter).emit("keypress", plain + " ", {}); // a dropped absolute path arrives as one paste
    (input as unknown as EventEmitter).emit("keypress", "", { name: "return" }); // submit
    const res = await p;
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
    check("editLine runs a dropped paste through transformPaste", res.type === "line" && res.value.trim() === plain, JSON.stringify(res));
  } finally {
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
  }
}

fs.rmSync(dir, { recursive: true, force: true });
finish();

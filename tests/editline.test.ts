import { EventEmitter } from "node:events"; // a fake stdin to drive the editor
import { editLine } from "../src/editor.js"; // unit under test (the raw-mode driver)
import { sentMessage } from "../src/ui.js"; // the "sent message" echo styler used by the main prompt
import { check, checkContains, finish } from "./helpers.js"; // assertions

// Drive editLine through a fake TTY: type some chars, press Enter, and inspect
// both the resolved line and what got written to the screen. chalk is disabled
// under the test runner, so sentMessage/prompts come through as plain text.
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""); // drop cursor/clear ANSI

async function drive(opts: { echo?: (t: string) => string }, keys: Array<[string, object]>): Promise<{ value: string; screen: string }> {
  const origWrite = process.stdout.write.bind(process.stdout);
  let raw = "";
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((raw += s), true);
  try {
    const s = new EventEmitter() as unknown as { isTTY: boolean; setRawMode: () => void; resume: () => void; pause: () => void };
    s.isTTY = true;
    s.setRawMode = () => {};
    s.resume = () => {};
    s.pause = () => {};
    const input = s as unknown as NodeJS.ReadStream;
    const rlStub = { pause() {}, resume() {} } as unknown as import("node:readline").Interface;
    const p = editLine(rlStub, { prompt: "P> ", input, echo: opts.echo });
    for (const [str, key] of keys) (input as unknown as EventEmitter).emit("keypress", str, key);
    const res = await p;
    return { value: res.type === "line" ? res.value : `(${res.type})`, screen: strip(raw) };
  } finally {
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
  }
}

// Type "hi there" then Enter.
const typed: Array<[string, object]> = [..."hi there"].map((c) => [c, { name: c }] as [string, object]);
typed.push(["", { name: "return" }]);

// ---- with an echo styler (the main REPL prompt): the submitted message is ------------
// re-rendered as a "> …" sent line, and the input box (prompt + text) is gone.
const withEcho = await drive({ echo: sentMessage }, typed);
check("editLine returns the typed line", withEcho.value === "hi there", JSON.stringify(withEcho.value));
checkContains("the submitted message is echoed as a sent line", withEcho.screen, "> hi there");
check("the bright prompt is NOT left on the committed line", !withEcho.screen.trimEnd().endsWith("P> hi there"), JSON.stringify(withEcho.screen.slice(-40)));

// ---- without echo (a sub-prompt): the typed text stays under its prompt --------------
const noEcho = await drive({}, typed);
check("editLine still returns the typed line", noEcho.value === "hi there");
checkContains("the typed text stays under the prompt", noEcho.screen, "P> hi there");
check("no sent-style echo is added", !noEcho.screen.includes("> hi there") || noEcho.screen.includes("P> hi there"), JSON.stringify(noEcho.screen.slice(-40)));

// ---- an empty submit with echo leaves nothing (no stray "> ") ------------------------
const emptyEcho = await drive({ echo: sentMessage }, [["", { name: "return" }]]);
check("empty submit returns empty", emptyEcho.value === "");
check("empty submit echoes nothing", !emptyEcho.screen.includes("> \n") && !/>\s*$/.test(emptyEcho.screen.trim()) || emptyEcho.screen.trim() === "P>" , "empty echo should be blank");

finish();

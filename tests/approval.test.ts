import { EventEmitter } from "node:events"; // a fake stdin to drive the menu without a real terminal
import { renderMenu } from "../src/ui.js"; // pure menu drawing
import { promptSelect } from "../src/menu.js"; // the interactive selector
import { checkPermission } from "../src/permissions.js"; // verify the "don't ask again" grant
import { CONFIG } from "../src/config.js"; // inject the session grant
import { check, checkContains, finish } from "./helpers.js"; // assertions

// ---- renderMenu: the highlighted, numbered option --------------------------------------
checkContains("selected option gets the chevron", renderMenu(["Yes", "No"], 0), "❯ 1. Yes");
checkContains("options are numbered", renderMenu(["Yes", "No"], 0), "2. No");
check("unselected option has no chevron", !renderMenu(["Yes", "No"], 0).includes("❯ 2. No"));
checkContains("selection can be the second row", renderMenu(["Yes", "No"], 1), "❯ 2. No");

// ---- promptSelect: arrow-key navigation (driven by a fake TTY) --------------------------
function fakeStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as { isTTY: boolean; setRawMode: (b: boolean) => void };
  s.isTTY = true;
  s.setRawMode = () => {}; // a fake stream can't really go raw — no-op
  return s as unknown as NodeJS.ReadStream;
}
const rlStub = { pause() {}, resume() {} } as unknown as import("node:readline").Interface;
const key = (input: NodeJS.ReadStream, k: object) => (input as unknown as EventEmitter).emit("keypress", "", k);

{
  const input = fakeStdin();
  const p = promptSelect(rlStub, ["Yes", "Maybe", "No"], input);
  key(input, { name: "down" }); // → Maybe
  key(input, { name: "down" }); // → No
  key(input, { name: "return" });
  check("down, down, enter selects index 2", (await p) === 2);
}
{
  const input = fakeStdin();
  const p = promptSelect(rlStub, ["Yes", "No"], input);
  key(input, { name: "up" }); // wraps from top to bottom
  key(input, { name: "return" });
  check("up wraps to the last option", (await p) === 1);
}
{
  const input = fakeStdin();
  const p = promptSelect(rlStub, ["Yes", "No"], input);
  key(input, { name: "escape" });
  check("escape cancels with -1", (await p) === -1);
}
{
  const input = fakeStdin();
  const p = promptSelect(rlStub, ["Yes", "No"], input);
  key(input, { ctrl: true, name: "c" });
  check("ctrl-c cancels with -1", (await p) === -1);
}
{
  const notTty = new EventEmitter() as unknown as { isTTY: boolean; setRawMode: () => void };
  notTty.isTTY = false;
  notTty.setRawMode = () => {};
  check("a non-TTY stream returns -1 (caller falls back to typing)", (await promptSelect(rlStub, ["Yes", "No"], notTty as unknown as NodeJS.ReadStream)) === -1);
}

// ---- "don't ask again for run_bash" upgrades ask→allow, but deny still stands -----------
const ask = JSON.stringify({ command: "make build" }); // unrecognized → ask
const deny = JSON.stringify({ command: "rm -rf /" }); // hard deny
check("unrecognized bash asks by default", checkPermission("run_bash", ask).decision === "ask");
CONFIG.permissions.allow.push("tool:run_bash"); // the session grant from choosing "don't ask again"
check("session grant upgrades ask → allow", checkPermission("run_bash", ask).decision === "allow");
check("a hard deny still denies even with the grant", checkPermission("run_bash", deny).decision === "deny");
CONFIG.permissions.allow.length = 0; // clean up for any later suite

finish();

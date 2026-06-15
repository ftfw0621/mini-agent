import readline from "node:readline"; // raw-mode keypress events + the interface to pause
import { renderMenu, MENU_HINT } from "./ui.js"; // the pure drawing + the footer hint

// An arrow-key selection menu. The whole point: an approval is one keystroke
// (↑/↓ then Enter), not "type y, then N, then realize you meant the other".
// Selecting costs the user less than typing.
//
// Coordinating with the session's readline (which owns stdin) is the tricky
// part: we pause it, switch stdin to raw mode, read keypresses ourselves, then
// hand stdin back exactly as we found it. The `input` parameter is injected so
// tests can drive it with a fake stream instead of a real terminal.
//
// Returns the chosen index, or -1 if cancelled (Esc / Ctrl+C) or not a TTY —
// callers treat -1 as "no" (fail closed for an approval).
export function promptSelect(
  rl: readline.Interface, // the session's line reader, paused while we own the keys
  options: string[], // the choices, top to bottom
  input: NodeJS.ReadStream = process.stdin, // injectable for tests
): Promise<number> {
  return new Promise((resolve) => {
    if (!input.isTTY) return resolve(-1); // no interactive selection without a terminal — caller falls back

    let selected = 0;
    let done = false;

    // Redraw the menu in place: move the cursor back up over the previous
    // render (options + the one footer line), clear downward, reprint. The
    // question above the menu stays put.
    const lineCount = options.length + 1; // options, plus the hint footer
    const draw = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${lineCount}A`); // up to the menu's top
      process.stdout.write(`\x1b[J${renderMenu(options, selected)}\n${MENU_HINT}\n`); // clear down, repaint + hint
    };

    const finish = (result: number) => {
      if (done) return;
      done = true;
      input.off("keypress", onKey); // stop listening
      try {
        input.setRawMode(false); // hand the terminal back
      } catch {
        /* not all streams support it; ignore */
      }
      rl.resume(); // the line reader takes over again
      resolve(result);
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean } | undefined) => {
      if (!key || done) return;
      switch (key.name) {
        case "up":
        case "k":
          selected = (selected - 1 + options.length) % options.length; // wrap around the top
          draw(false);
          break;
        case "down":
        case "j":
          selected = (selected + 1) % options.length; // wrap around the bottom
          draw(false);
          break;
        case "return":
        case "enter":
          finish(selected); // commit the choice
          break;
        case "escape":
          finish(-1); // bail
          break;
        default:
          if (key.ctrl && key.name === "c") finish(-1); // Ctrl+C in raw mode arrives as a keypress, not a signal
      }
    };

    try {
      rl.pause(); // stop the line reader from eating our keystrokes
      if (input === process.stdin) readline.emitKeypressEvents(input); // turn raw bytes into named keys (real stdin only)
      input.setRawMode(true); // keys arrive immediately, no Enter needed
      input.on("keypress", onKey);
      draw(true); // first paint
    } catch {
      finish(-1); // anything unexpected in setup → cancel, caller falls back to typing
    }
  });
}

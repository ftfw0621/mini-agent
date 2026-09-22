import readline from "node:readline"; // raw-mode keypress events + the interface to pause
import chalk from "chalk";
import { reduceEditor, truncateToWidth, type KeyEvent } from "./editor.js";
import { renderMenu, MENU_HINT } from "./ui.js"; // the pure drawing + the footer hint
import { initFormState, reduceForm, renderForm, collectAnswers, type FormQuestion, type FormAnswer } from "./form.js"; // the multi-question form

export type PromptFollowUp = (text: string) => boolean | Promise<boolean>;

// Navigation owns arrows; printable text belongs to this editor. Sending a
// follow-up cancels the pending choice, never implicitly approves it.
function promptDraft(submit: PromptFollowUp | undefined, redraw: () => void, cancel: () => void) {
  let state = { buffer: "", cursor: 0 };
  let sending = false;
  let error = "";
  return {
    render: () => submit ? `\n${truncateToWidth(`Follow-up ❯ ${state.buffer.slice(0, state.cursor)}${chalk.inverse(state.buffer[state.cursor] ?? " ")}${state.buffer.slice(state.cursor + 1)}`, Math.max(10, (process.stdout.columns || 80) - 1))}\n${truncateToWidth(error || "Type a follow-up · Enter sends text; empty input selects", Math.max(10, (process.stdout.columns || 80) - 1))}` : "",
    handle(str: string, key: KeyEvent): boolean {
      if (sending) return true;
      if (!submit || ["up", "down", "tab", "escape"].includes(key.name ?? "") || (key.ctrl && key.name === "c")) return false;
      const next = reduceEditor(state, str, key);
      if (next.action === "submit" && state.buffer.trim()) {
        sending = true;
        void Promise.resolve().then(() => submit(state.buffer.trim())).then((accepted) => { if (accepted) cancel(); else redraw(); })
          .catch(() => { error = "Could not submit follow-up; draft retained."; redraw(); }).finally(() => { sending = false; });
        return true;
      }
      if (next.action === "edit") { state = next.state; error = ""; redraw(); return true; }
      return next.action !== "submit";
    },
  };
}

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
  onFollowUp?: PromptFollowUp,
): Promise<number> {
  return new Promise((resolve) => {
    if (!input.isTTY) return resolve(-1); // no interactive selection without a terminal — caller falls back

    let selected = 0;
    let done = false;
    const wasRaw = input.isRaw === true; // the session's readline keeps stdin raw — restore THIS, don't force false

    // Redraw the menu in place: move the cursor back up over the previous
    // render (options + the one footer line), clear downward, reprint. The
    // question above the menu stays put.
    const lineCount = options.length + 1 + (onFollowUp ? 2 : 0);
    const draw = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${lineCount}A`); // up to the menu's top
      process.stdout.write(`\x1b[J${renderMenu(options, selected)}\n${MENU_HINT}${draft.render()}\n`);
    };

    const finish = (result: number) => {
      if (done) return;
      done = true;
      input.off("keypress", onKey); // stop listening
      try {
        input.setRawMode(wasRaw); // restore the prior mode — forcing false breaks the live readline → it closes → the REPL exits
      } catch {
        /* not all streams support it; ignore */
      }
      rl.resume(); // the line reader takes over again
      resolve(result);
    };

    const draft = promptDraft(onFollowUp, () => draw(false), () => finish(-1));
    const onKey = (str: string, key: KeyEvent | undefined) => {
      if (!key || done) return;
      if (draft.handle(str, key)) return;
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
      rl.pause(); // stop the line reader from turning our keystrokes into lines
      if (input === process.stdin) readline.emitKeypressEvents(input); // turn raw bytes into named keys (real stdin only)
      input.setRawMode(true); // keys arrive immediately, no Enter needed
      input.resume(); // CRUCIAL: rl.pause() paused the stream — resume it or no keypresses reach us (menu hangs)
      input.on("keypress", onKey);
      draw(true); // first paint
    } catch {
      finish(-1); // anything unexpected in setup → cancel, caller falls back to typing
    }
  });
}

// The multi-question form (Day 30): the agent asks several questions at once,
// the user answers each and submits, and we hand back organized answers. Same
// raw-mode borrow/return dance as promptSelect; the state machine is in form.ts.
// Returns the answers, or null if cancelled / not a TTY.
export function promptForm(
  rl: readline.Interface,
  questions: FormQuestion[],
  input: NodeJS.ReadStream = process.stdin,
  onFollowUp?: PromptFollowUp,
): Promise<FormAnswer[] | null> {
  return new Promise((resolve) => {
    if (!input.isTTY || !questions.length) return resolve(null); // no form without a terminal or questions

    let state = initFormState(questions);
    let done = false;
    const wasRaw = input.isRaw === true; // restore this on exit, not false (see promptSelect)
    const lineCount = renderForm(questions, state).split("\n").length + (onFollowUp ? 2 : 0);

    const draw = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${lineCount}A`); // up over the whole form
      process.stdout.write(`\x1b[J${renderForm(questions, state)}${draft.render()}\n`);
    };

    const finish = (result: FormAnswer[] | null) => {
      if (done) return;
      done = true;
      input.off("keypress", onKey);
      try {
        input.setRawMode(wasRaw); // restore prior mode; forcing false breaks the live readline → REPL exits
      } catch {
        /* ignore */
      }
      rl.resume();
      resolve(result);
    };

    const draft = promptDraft(onFollowUp, () => draw(false), () => finish(null));
    const onKey = (str: string, key: KeyEvent | undefined) => {
      if (!key || done) return;
      if (draft.handle(str, key)) return;
      if (key.name === "up" || key.name === "k") {
        state = reduceForm(questions, state, "up").state;
        draw(false);
      } else if (key.name === "down" || key.name === "j" || key.name === "tab") {
        state = reduceForm(questions, state, "down").state;
        draw(false);
      } else if (key.name === "return" || key.name === "enter" || key.name === "space") {
        const next = reduceForm(questions, state, "select");
        state = next.state;
        if (next.done) finish(collectAnswers(questions, state)); // submitted with all answered
        else draw(false);
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish(null); // cancel
      }
    };

    try {
      rl.pause();
      if (input === process.stdin) readline.emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume(); // resume the stream rl.pause() paused, or no keypresses reach the form
      input.on("keypress", onKey);
      draw(true);
    } catch {
      finish(null);
    }
  });
}

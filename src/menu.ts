import readline from "node:readline"; // raw-mode keypress events + the interface to pause
import chalk from "chalk";
import { reduceEditor, truncateToWidth, type KeyEvent } from "./editor.js";
import { renderMenu, MENU_HINT } from "./ui.js"; // the pure drawing + the footer hint
import { initFormState, reduceForm, renderForm, collectAnswers, onTypedRow, type FormQuestion, type FormAnswer, type FormAction } from "./form.js"; // the multi-question form

export type PromptFollowUp = (text: string) => boolean | Promise<boolean>;

// Navigation owns arrows; printable text belongs to this editor. Sending a
// follow-up cancels the pending choice, never implicitly approves it.
function promptDraft(submit: PromptFollowUp | undefined, redraw: () => void, cancel: () => void) {
  let state = { buffer: "", cursor: 0 };
  let sending = false;
  let error = "";
  return {
    hasText: () => state.buffer.length > 0,
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
// Keys: ↑/↓ rows, ←/→ or Tab questions, Enter chooses, Esc cancels. On a "Type
// something" row the typed keys edit the answer; anywhere else they start a
// follow-up, which (like promptSelect) cancels the form when sent.
// Returns the answers, "chat" (talk instead of answering), or null if
// cancelled / not a TTY.
export function promptForm(
  rl: readline.Interface,
  questions: FormQuestion[],
  input: NodeJS.ReadStream = process.stdin,
  onFollowUp?: PromptFollowUp,
): Promise<FormAnswer[] | "chat" | null> {
  return new Promise((resolve) => {
    if (!input.isTTY || !questions.length) return resolve(null); // no form without a terminal or questions

    let state = initFormState(questions);
    let answer = { buffer: "", cursor: 0 }; // the "Type something" editor
    let done = false;
    const wasRaw = input.isRaw === true; // restore this on exit, not false (see promptSelect)
    let lineCount = 0; // tabs differ in height: redraw over whatever the last frame was

    const draw = (first: boolean) => {
      const typing = onTypedRow(questions, state);
      const frame = `${renderForm(questions, state, typing ? answer.buffer : undefined)}${typing ? "" : draft.render()}`;
      if (!first) process.stdout.write(`\x1b[${lineCount}A`); // up over the previous frame
      process.stdout.write(`\x1b[J${frame}\n`);
      lineCount = frame.split("\n").length;
    };

    const finish = (result: FormAnswer[] | "chat" | null) => {
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

    // Apply one action. The answer editor travels with it while on a typed row,
    // and follows the cursor: loaded on arrival, cleared on departure.
    const act = (action: FormAction) => {
      const typing = onTypedRow(questions, state);
      const next = reduceForm(questions, state, action, typing ? answer.buffer : undefined);
      const arriving = onTypedRow(questions, next.state) && (!typing || next.state.tab !== state.tab || next.state.cursor !== state.cursor);
      state = next.state;
      if (next.outcome === "submit") return finish(collectAnswers(questions, state));
      if (next.outcome === "chat") return finish("chat");
      if (next.outcome === "cancel") return finish(null);
      if (arriving) { const text = state.typed[state.tab]; answer = { buffer: text, cursor: text.length }; }
      else if (!onTypedRow(questions, state)) answer = { buffer: "", cursor: 0 };
      draw(false);
    };

    const draft = promptDraft(onFollowUp, () => draw(false), () => finish(null));
    const onKey = (str: string, key: KeyEvent | undefined) => {
      if (!key || done) return;
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return act("escape");
      const typing = onTypedRow(questions, state);
      if (key.name === "up") return act("up");
      if (key.name === "down") return act("down");
      if (key.name === "tab") return act(key.shift ? "left" : "right");
      // ←/→ switch questions, unless there is text to move the caret through.
      if ((key.name === "left" || key.name === "right") && !(typing ? answer.buffer : draft.hasText())) return act(key.name);
      if (key.name === "return" || key.name === "enter") {
        if (typing || !draft.handle(str, key)) act("enter"); // a drafted follow-up is sent by its own editor
        return;
      }
      if (typing) {
        const next = reduceEditor(answer, str, key);
        if (next.action === "edit") { answer = next.state; draw(false); }
        return;
      }
      if (draft.handle(str, key)) return;
      if (key.name === "space") act("enter"); // space toggles / chooses too
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

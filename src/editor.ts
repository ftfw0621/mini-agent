import readline from "node:readline"; // raw-mode keypress decoding + the interface we pause

// Our own line editor — readline can't keep a status bar pinned BELOW the input
// because it assumes it owns the last line on screen, so a wrapped input shoves
// the footer out of place. Here we own the whole input block: prompt + the
// (possibly wrapped) input + the footer. On every keystroke we recompute the
// block and repaint ALL of it, then place the cursor by math — so the footer is
// never misaligned, no matter how the input wraps.
//
// The core is split into pure functions (reduceEditor / layout / displayWidth)
// so the editing logic and the wrapping math are testable without a terminal.
// The driver (editLine) is the thin raw-mode shell, same borrow/return dance as
// menu.ts: pause the session readline, take stdin raw, restore it exactly.

export interface KeyEvent {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}
export interface EditorState {
  buffer: string; // the text typed so far
  cursor: number; // caret position, a code-unit index into buffer (0..length)
}
// What a keystroke means to the caller. "edit" = buffer/cursor changed, repaint.
export type EditAction = "edit" | "submit" | "cancel" | "eof" | "histPrev" | "histNext" | "tab" | "reveal" | "none";

// ---- pure editing logic -----------------------------------------------------
// Map a keypress onto a new state + an action. Emacs-style bindings, the ones a
// terminal user expects. Everything printable (letters, digits, punctuation,
// pasted text, CJK) falls through to insertion at the cursor.
export function reduceEditor(s: EditorState, str: string | undefined, key: KeyEvent): { state: EditorState; action: EditAction } {
  const { buffer, cursor } = s;
  const name = key?.name;
  if (key?.ctrl) {
    switch (name) {
      case "c":
        return { state: s, action: "cancel" }; // Ctrl+C → caller decides (at the prompt: quit)
      case "d":
        return buffer.length === 0 ? { state: s, action: "eof" } : forwardDelete(s); // Ctrl+D empty → EOF, else delete
      case "a":
        return { state: { buffer, cursor: 0 }, action: "edit" }; // start of line
      case "e":
        return { state: { buffer, cursor: buffer.length }, action: "edit" }; // end of line
      case "u":
        return { state: { buffer: buffer.slice(cursor), cursor: 0 }, action: "edit" }; // kill to start
      case "k":
        return { state: { buffer: buffer.slice(0, cursor), cursor }, action: "edit" }; // kill to end
      case "w":
        return killWordBack(s); // kill the word before the cursor
      case "b":
        return { state: { buffer, cursor: Math.max(0, cursor - 1) }, action: "edit" }; // back one char
      case "f":
        return { state: { buffer, cursor: Math.min(buffer.length, cursor + 1) }, action: "edit" }; // forward one char
      case "r":
        return { state: s, action: "reveal" }; // Ctrl+R → reveal the model's collapsed thinking
      default:
        return { state: s, action: "none" };
    }
  }
  switch (name) {
    case "return":
    case "enter":
      return { state: s, action: "submit" };
    case "backspace":
      return cursor > 0
        ? { state: { buffer: buffer.slice(0, cursor - 1) + buffer.slice(cursor), cursor: cursor - 1 }, action: "edit" }
        : { state: s, action: "none" };
    case "delete":
      return forwardDelete(s);
    case "left":
      return { state: { buffer, cursor: Math.max(0, cursor - 1) }, action: "edit" };
    case "right":
      return { state: { buffer, cursor: Math.min(buffer.length, cursor + 1) }, action: "edit" };
    case "home":
      return { state: { buffer, cursor: 0 }, action: "edit" };
    case "end":
      return { state: { buffer, cursor: buffer.length }, action: "edit" };
    case "up":
      return { state: s, action: "histPrev" };
    case "down":
      return { state: s, action: "histNext" };
    case "escape":
      return { state: { buffer: "", cursor: 0 }, action: "edit" }; // Esc clears the line
    case "tab":
      return { state: s, action: "tab" };
    default:
      // Printable insertion. A paste arrives as a multi-char string; insert it whole.
      if (str && !key?.meta && isPrintable(str)) {
        return { state: { buffer: buffer.slice(0, cursor) + str + buffer.slice(cursor), cursor: cursor + str.length }, action: "edit" };
      }
      return { state: s, action: "none" };
  }
}

function forwardDelete(s: EditorState): { state: EditorState; action: EditAction } {
  const { buffer, cursor } = s;
  return cursor < buffer.length ? { state: { buffer: buffer.slice(0, cursor) + buffer.slice(cursor + 1), cursor }, action: "edit" } : { state: s, action: "none" };
}

function killWordBack(s: EditorState): { state: EditorState; action: EditAction } {
  const { buffer, cursor } = s;
  let i = cursor;
  while (i > 0 && /\s/.test(buffer[i - 1])) i--; // skip trailing spaces
  while (i > 0 && !/\s/.test(buffer[i - 1])) i--; // then the word
  return { state: { buffer: buffer.slice(0, i) + buffer.slice(cursor), cursor: i }, action: "edit" };
}

function isPrintable(str: string): boolean {
  return [...str].every((c) => c >= " " && c !== "\x7f"); // no control chars (incl. lone newlines/DEL)
}

// ---- width + wrapping math --------------------------------------------------
const ANSI = /\x1b\[[0-9;]*m/g; // SGR color codes — they take zero display columns

// Display width of a string, ANSI-aware and CJK-aware (full-width glyphs are 2
// columns; String.length would miscount them and break wrapping/cursor math).
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, "")) w += charWidth(ch.codePointAt(0)!);
  return w;
}
function charWidth(cp: number): number {
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f || // Hangul Jamo
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK … Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
      (cp >= 0x20000 && cp <= 0x3fffd)) // CJK extension B+
  )
    return 2;
  return 1;
}

// Clip a (possibly ANSI-styled) string to a display width: keep escape codes
// (zero width) intact, never split a wide glyph. This stops a long status footer
// from wrapping — a wrapped footer row occupies TWO physical rows, which would
// desync the editor's row math and drop the caret a line too low (and then every
// repaint clears from the wrong row, stacking a fresh prompt each keystroke).
export function truncateToWidth(s: string, width: number): string {
  let w = 0;
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i)); // an SGR colour code — copy it, it has no width
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > width) return out + "\x1b[0m"; // would overflow → stop, closing any open colour
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out;
}

// Wrap the input across the terminal width and find where the cursor lands.
// Row 0 begins after the prompt (promptW columns); continuation rows start at 0.
// Returns the buffer text per row (the driver prepends the prompt to row 0) plus
// the cursor's (row, col) — so a wrapped line keeps the caret exactly right.
export function layout(buffer: string, cursor: number, promptW: number, cols: number): { rows: string[]; cursorRow: number; cursorCol: number } {
  const width = Math.max(2, cols);
  const rows: string[] = [""];
  let row = 0;
  let col = promptW;
  let cursorRow = 0;
  let cursorCol = promptW;
  let set = false;
  let cu = 0; // code-unit offset, to match `cursor`
  for (const ch of buffer) {
    if (!set && cu === cursor) {
      cursorRow = row;
      cursorCol = col;
      set = true;
    }
    const w = charWidth(ch.codePointAt(0)!);
    if (col + w > width) {
      row++;
      col = 0;
      rows[row] = "";
    }
    rows[row] += ch;
    col += w;
    cu += ch.length;
  }
  if (!set) {
    cursorRow = row;
    cursorCol = col; // cursor at the very end
  }
  if (cursorCol >= width) {
    // caret sat exactly at the right edge — it belongs at the start of the next row
    cursorRow++;
    cursorCol = 0;
    if (rows.length <= cursorRow) rows.push("");
  }
  return { rows, cursorRow, cursorCol };
}

// ---- the raw-mode driver ----------------------------------------------------
export type EditResult = { type: "line"; value: string } | { type: "cancel" } | { type: "eof" };
interface Pausable {
  pause: () => void;
  resume: () => void;
}
export interface EditOptions {
  prompt: string; // the styled "❯ " (display width measured ANSI-aware)
  footer?: string; // a status block pinned under the input (newline-separated rows)
  history?: string[]; // past entries for ↑/↓ recall (not mutated)
  initial?: string; // pre-filled text
  onTab?: () => void; // Tab handler (e.g. toggle a collapsed block), then we repaint
  onReveal?: () => void; // Ctrl+R handler (reveal the model's collapsed thinking), then we repaint
  transformPaste?: (raw: string) => string; // rewrite a multi-char paste before insertion (e.g. drag-and-drop → absolute paths)
  input?: NodeJS.ReadStream; // injectable for tests
}

// Read one line with the full editor + pinned footer. Resolves with the line, or
// cancel (Ctrl+C) / eof (Ctrl+D on an empty line) for the caller to interpret.
export function editLine(rl: Pausable, opts: EditOptions): Promise<EditResult> {
  return new Promise((resolve) => {
    const input = opts.input ?? process.stdin;
    const out = process.stdout;
    if (!input.isTTY) return resolve({ type: "eof" }); // caller guards, but be safe
    const promptW = displayWidth(opts.prompt);
    const footerRows = opts.footer ? opts.footer.split("\n") : [];
    const history = opts.history ?? [];
    let hi = history.length; // history cursor; == length means "the live draft"
    let draft = "";
    let state: EditorState = { buffer: opts.initial ?? "", cursor: (opts.initial ?? "").length };
    let done = false;
    let first = true;
    let prevCursorRow = 0; // where the caret sits within the block, to climb back next repaint
    const wasRaw = input.isRaw === true; // restore THIS on exit (forcing false would close the live readline)
    const cols = () => out.columns || 80;
    // The session's readline keeps its OWN 'keypress' handler on stdin. Once
    // readline has been activated (after the first resume), that handler fires on
    // every key alongside ours and fights us for the cursor — the line stacks
    // instead of redrawing in place. Detach the other keypress listeners while we
    // own the input, and restore them exactly on exit (menu/confirm still need them).
    let otherKeypress: ((...a: unknown[]) => void)[] = [];

    // Repaint the whole block in place: climb to its top, clear downward, reprint
    // input rows + footer, then drop the caret onto its computed (row, col).
    const draw = () => {
      const { rows, cursorRow, cursorCol } = layout(state.buffer, state.cursor, promptW, cols());
      if (!first) {
        if (prevCursorRow > 0) out.write(`\x1b[${prevCursorRow}A`); // up to the block's top row
        out.write("\r");
      }
      out.write("\x1b[0J"); // clear from the top of the block to end of screen
      const inputRows = rows.map((r, i) => (i === 0 ? opts.prompt + r : r));
      // Truncate each footer row so it can't wrap — otherwise its extra physical
      // row throws off the cursor math below (caret lands low → prompts stack).
      const fr = footerRows.map((f) => truncateToWidth(f, Math.max(1, cols() - 1)));
      const all = [...inputRows, ...fr];
      out.write(all.join("\r\n"));
      const lastRow = all.length - 1; // every row is now exactly one physical line
      if (lastRow > cursorRow) out.write(`\x1b[${lastRow - cursorRow}A`); // up from the last footer row
      out.write("\r");
      if (cursorCol > 0) out.write(`\x1b[${cursorCol}C`); // right to the caret column
      prevCursorRow = cursorRow;
      first = false;
    };

    const finish = (result: EditResult) => {
      if (done) return;
      done = true;
      input.off("keypress", onKey);
      for (const l of otherKeypress) input.on("keypress", l); // give readline its keypress handler back
      // Leave the typed command on screen, drop the footer, land on a fresh line.
      const { rows } = layout(state.buffer, state.cursor, promptW, cols());
      if (prevCursorRow > 0) out.write(`\x1b[${prevCursorRow}A`);
      out.write("\r\x1b[0J");
      const inputRows = rows.map((r, i) => (i === 0 ? opts.prompt + r : r));
      out.write(inputRows.join("\r\n") + "\r\n");
      try {
        input.setRawMode(wasRaw); // hand stdin back exactly as we found it
      } catch {
        /* not all streams support it */
      }
      rl.resume();
      resolve(result);
    };

    const onKey = (str: string | undefined, key: KeyEvent | undefined) => {
      if (done) return;
      // A drag-and-drop (or any paste) arrives as one multi-char string. Give the
      // caller a chance to rewrite it — e.g. turn dropped file paths into clean
      // absolute paths — before it lands in the buffer. No-op for normal text.
      if (str && str.length > 1 && !key?.ctrl && !key?.meta && opts.transformPaste) {
        str = opts.transformPaste(str);
      }
      const next = reduceEditor(state, str, key || {});
      state = next.state;
      switch (next.action) {
        case "submit":
          return finish({ type: "line", value: state.buffer });
        case "cancel":
          return finish({ type: "cancel" });
        case "eof":
          return finish({ type: "eof" });
        case "histPrev":
          if (hi > 0) {
            if (hi === history.length) draft = state.buffer; // stash the live draft on the way up
            hi--;
            state = { buffer: history[hi], cursor: history[hi].length };
          }
          return draw();
        case "histNext":
          if (hi < history.length) {
            hi++;
            const b = hi === history.length ? draft : history[hi];
            state = { buffer: b, cursor: b.length };
          }
          return draw();
        case "tab":
          opts.onTab?.(); // may print above us (e.g. expand a collapsed block) and scroll
          first = true; // so the next paint lands fresh at the cursor, not a stale climb-up
          return draw();
        case "reveal":
          opts.onReveal?.(); // print the model's collapsed thinking above us, then repaint
          first = true; // the next paint lands fresh, not a stale climb-up
          return draw();
        case "edit":
          return draw();
        case "none":
          return;
      }
    };

    try {
      rl.pause(); // stop the session reader from turning our keystrokes into lines
      if (input === process.stdin) readline.emitKeypressEvents(input); // decode raw bytes into named keys
      otherKeypress = input.listeners("keypress") as ((...a: unknown[]) => void)[]; // readline's handler(s)…
      for (const l of otherKeypress) input.off("keypress", l); // …detached so only we drive the cursor
      input.setRawMode(true);
      input.resume(); // rl.pause() also paused the stream — resume it or no keys arrive
      input.on("keypress", onKey);
      draw();
    } catch {
      finish({ type: "eof" }); // setup failed (non-TTY etc.) → behave like EOF
    }
  });
}

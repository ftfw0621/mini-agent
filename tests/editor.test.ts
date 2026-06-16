import { reduceEditor, layout, displayWidth, truncateToWidth, type EditorState } from "../src/editor.js"; // unit under test
import { check, finish } from "./helpers.js"; // assertions

const st = (buffer: string, cursor: number): EditorState => ({ buffer, cursor });
// Drive one key; assert the resulting buffer/cursor/action.
function key(s: EditorState, str: string | undefined, k: Record<string, unknown>) {
  return reduceEditor(s, str, k);
}

// ---- insertion -------------------------------------------------------------
let r = key(st("", 0), "a", { name: "a" });
check("insert into empty", r.state.buffer === "a" && r.state.cursor === 1 && r.action === "edit", JSON.stringify(r));
r = key(st("ac", 1), "b", { name: "b" });
check("insert in the middle", r.state.buffer === "abc" && r.state.cursor === 2, JSON.stringify(r));
r = key(st("hi", 2), " ", { name: "space" });
check("space inserts a space", r.state.buffer === "hi " && r.state.cursor === 3, JSON.stringify(r));
r = key(st("", 0), "你好", { name: undefined });
check("paste/CJK inserts whole string", r.state.buffer === "你好" && r.state.cursor === 2, JSON.stringify(r));

// ---- delete / backspace ----------------------------------------------------
r = key(st("abc", 2), undefined, { name: "backspace" });
check("backspace removes the char before the cursor", r.state.buffer === "ac" && r.state.cursor === 1, JSON.stringify(r));
r = key(st("abc", 0), undefined, { name: "backspace" });
check("backspace at col 0 is a no-op", r.state.buffer === "abc" && r.action === "none", JSON.stringify(r));
r = key(st("abc", 1), undefined, { name: "delete" });
check("delete removes the char at the cursor", r.state.buffer === "ac" && r.state.cursor === 1, JSON.stringify(r));

// ---- cursor movement -------------------------------------------------------
check("left moves back", key(st("abc", 2), undefined, { name: "left" }).state.cursor === 1);
check("left clamps at 0", key(st("abc", 0), undefined, { name: "left" }).state.cursor === 0);
check("right moves forward", key(st("abc", 1), undefined, { name: "right" }).state.cursor === 2);
check("right clamps at end", key(st("abc", 3), undefined, { name: "right" }).state.cursor === 3);
check("home jumps to 0", key(st("abc", 3), undefined, { name: "home" }).state.cursor === 0);
check("end jumps to length", key(st("abc", 0), undefined, { name: "end" }).state.cursor === 3);

// ---- emacs-style control bindings -----------------------------------------
check("ctrl+a → start", key(st("abc", 2), undefined, { name: "a", ctrl: true }).state.cursor === 0);
check("ctrl+e → end", key(st("abc", 0), undefined, { name: "e", ctrl: true }).state.cursor === 3);
r = key(st("hello", 3), undefined, { name: "u", ctrl: true });
check("ctrl+u kills to start", r.state.buffer === "lo" && r.state.cursor === 0, JSON.stringify(r));
r = key(st("hello", 3), undefined, { name: "k", ctrl: true });
check("ctrl+k kills to end", r.state.buffer === "hel" && r.state.cursor === 3, JSON.stringify(r));
r = key(st("foo bar baz", 11), undefined, { name: "w", ctrl: true });
check("ctrl+w kills the previous word", r.state.buffer === "foo bar " && r.state.cursor === 8, JSON.stringify(r));

// ---- actions ---------------------------------------------------------------
check("Enter submits", key(st("hi", 2), "\r", { name: "return" }).action === "submit");
check("Ctrl+C cancels", key(st("hi", 2), undefined, { name: "c", ctrl: true }).action === "cancel");
check("Ctrl+D on empty is EOF", key(st("", 0), undefined, { name: "d", ctrl: true }).action === "eof");
check("Ctrl+D with text forward-deletes", key(st("ab", 0), undefined, { name: "d", ctrl: true }).state.buffer === "b");
r = key(st("typed", 5), undefined, { name: "escape" });
check("Esc clears the line", r.state.buffer === "" && r.state.cursor === 0, JSON.stringify(r));
check("Up → history prev", key(st("", 0), undefined, { name: "up" }).action === "histPrev");
check("Down → history next", key(st("", 0), undefined, { name: "down" }).action === "histNext");
check("Tab → tab action", key(st("", 0), "\t", { name: "tab" }).action === "tab");
check("an unknown control key is ignored", key(st("a", 1), undefined, { name: "f5" }).action === "none");

// ---- displayWidth ----------------------------------------------------------
check("ascii width", displayWidth("abc") === 3);
check("CJK is double width", displayWidth("中文") === 4);
check("ANSI codes take no columns", displayWidth("\x1b[36mhi\x1b[39m") === 2);

// ---- layout (wrapping + cursor) -------------------------------------------
let L = layout("hello", 5, 2, 80);
check("no-wrap: one row", L.rows.length === 1 && L.rows[0] === "hello", JSON.stringify(L));
check("no-wrap: cursor at end accounts for prompt width", L.cursorRow === 0 && L.cursorCol === 7, JSON.stringify(L));
L = layout("hello", 2, 2, 80);
check("no-wrap: cursor in the middle", L.cursorRow === 0 && L.cursorCol === 4, JSON.stringify(L));

L = layout("abcdefghij", 10, 2, 10); // width 10, prompt 2 → row0 holds 8 chars
check("wrap: splits into two rows", L.rows.length === 2 && L.rows[0] === "abcdefgh" && L.rows[1] === "ij", JSON.stringify(L));
check("wrap: cursor follows onto row 1", L.cursorRow === 1 && L.cursorCol === 2, JSON.stringify(L));

L = layout("中文字", 3, 0, 4); // each CJK is 2 wide, width 4 → 2 per row
check("wrap: CJK respects double width", L.rows[0] === "中文" && L.rows[1] === "字", JSON.stringify(L));

// ---- truncateToWidth (stops the footer from wrapping) ----------------------
check("short string is unchanged", truncateToWidth("hello", 10) === "hello");
check("ascii is clipped to width", displayWidth(truncateToWidth("hello world", 5)) <= 5);
check("CJK clip respects double width", displayWidth(truncateToWidth("你好世界", 5)) <= 5);
const styled = truncateToWidth("\x1b[36m[deepseek-v4-pro] · 📁 dir · ⏱ 2m42s\x1b[39m", 12);
check("styled status clipped to width", displayWidth(styled) <= 12, `width=${displayWidth(styled)}`);
check("clip keeps ANSI codes (zero width) and never exceeds", displayWidth(truncateToWidth("\x1b[33m$0.0099\x1b[39m abcdefgh", 7)) <= 7);

finish();

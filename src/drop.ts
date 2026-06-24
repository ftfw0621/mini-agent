// Drag-and-drop a file onto the terminal and it pastes the file's path into the
// input — but as a SHELL token: backslash-escaped spaces (/Users/me/my\ file.txt)
// or wrapped in quotes, and usually with a trailing space. That's noisy to read
// and clumsy to hand to the agent. This turns a dropped path (or several) into
// clean ABSOLUTE paths, so the user never types a long path by hand.
//
// It is deliberately conservative: it only rewrites text that is, after
// unescaping, one or more EXISTING ABSOLUTE paths (that's exactly what a terminal
// drag produces). Anything else — ordinary pasted prose, a relative snippet — is
// returned untouched, so this can run on every paste without surprising anyone.
import fs from "node:fs"; // confirm the tokens are real paths (the drag signal)
import os from "node:os"; // expand a leading ~
import path from "node:path"; // resolve + normalize to absolute

// Terminals with "bracketed paste" wrap the text in these markers; strip them so
// a drop still parses if the mode happens to be on.
const BRACKET_PASTE = /\x1b\[20[01]~/g;

// Split a dropped string into path tokens, honoring the escaping a terminal adds:
// backslash escapes (\<space>, \( …) and single/double quotes. Whitespace OUTSIDE
// a quote/escape separates tokens (so several dropped files become several paths).
function splitTokens(raw: string): string[] {
  const s = raw.replace(BRACKET_PASTE, "").trim();
  const tokens: string[] = [];
  let cur = "";
  let started = false; // did the current token get any character? (distinguishes "" from absent)
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { cur += s[i + 1]; i += 2; started = true; continue; } // \x → literal x
    if (c === "'") { // single quotes: everything literal until the next '
      i++;
      while (i < s.length && s[i] !== "'") cur += s[i++];
      i++; started = true; continue;
    }
    if (c === '"') { // double quotes: backslash still escapes inside
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) { cur += s[i + 1]; i += 2; } else cur += s[i++];
      }
      i++; started = true; continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { // a separator between tokens
      if (started) { tokens.push(cur); cur = ""; started = false; }
      i++; continue;
    }
    cur += c; i++; started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

// A drop produces ABSOLUTE paths (macOS/Linux terminals). Treat a leading ~ as
// home. Anything not absolute-ish is not a drop — we leave it alone.
const looksAbsolute = (t: string): boolean => t.startsWith("/") || t === "~" || t.startsWith("~/");
const expandTilde = (t: string): string => (t === "~" || t.startsWith("~/") ? os.homedir() + t.slice(1) : t);

// Quote a path that contains whitespace so several dropped paths stay separable
// (and the whole thing survives being read as shell-ish tokens later). Prefer
// single quotes; fall back to double if the path itself contains a single quote.
function quoteIfNeeded(p: string): string {
  if (!/\s/.test(p)) return p;
  return p.includes("'") ? `"${p}"` : `'${p}'`;
}

// The entry point: given a pasted string, return clean absolute path(s) if it is
// a drop, otherwise the original text unchanged. A successful normalization ends
// with a single trailing space, so the cursor lands ready to type the question.
export function normalizeDroppedPaths(raw: string): string {
  if (!raw) return raw;
  const tokens = splitTokens(raw);
  if (!tokens.length) return raw;
  const abs: string[] = [];
  for (const t of tokens) {
    if (!looksAbsolute(t)) return raw; // not a dragged absolute path → leave the paste as-is
    const resolved = path.resolve(expandTilde(t)); // normalize (//, .., trailing /) → canonical absolute
    if (!fs.existsSync(resolved)) return raw; // a path that doesn't exist isn't a real drop
    abs.push(resolved);
  }
  return abs.map(quoteIfNeeded).join(" ") + " ";
}

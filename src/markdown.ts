import { Marked, type Tokens } from "marked"; // the parser
import { markedTerminal } from "marked-terminal"; // the ANSI renderer
import Table from "cli-table3"; // box-drawing table (borders + padding)
import wrapAnsi from "wrap-ansi"; // ANSI- and CJK-aware line wrapping
import chalk from "chalk"; // our one color source — keep the theme consistent with ui.ts
import { displayWidth } from "./editor.js"; // CJK-/ANSI-aware display width (shared with the line editor)

// Why a library here, not hand-rolled? Markdown→terminal is a solved, fiddly
// problem (CJK-aware table widths, nested lists, code fences, link rewriting).
// The agent's *core* is hand-written on purpose; this is pure presentation, so
// we lean on `marked` + `marked-terminal` and spend our effort on the streaming
// glue instead. The model speaks markdown; without this the screen shows raw
// `##`, `**`, and `|---|` — exactly the ugliness this module removes.

// ---- responsive tables ------------------------------------------------------
// marked-terminal's `width` does NOT size tables — a wide table overflows and the
// terminal hard-wraps it into garbage. So we render tables ourselves: shrink the
// columns to fit the window, wrap each cell (CJK-aware, no truncation), and let
// cli-table3 draw the box. This is what makes a table adapt to the window size.

// Per-column CONTENT widths that fit `maxWidth` once borders/padding are paid for.
// Start from each column's natural width, then repeatedly shave the widest until
// the row fits — so narrow columns keep their size and the roomy ones give first.
function tableColumnWidths(header: string[], rows: string[][], maxWidth: number): number[] {
  const n = header.length;
  const natural = header.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ""))));
  const budget = maxWidth - (n + 1) - 2 * n; // n+1 borders, 2 cols of padding per column
  const widths = natural.slice();
  const MIN = 4; // never shrink a column below this many content columns
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= MIN) break; // can't shrink further — let it overflow rather than vanish
    widths[widest]--;
  }
  return widths;
}

// Draw one table, wrapped to fit `maxWidth`. Cells are pre-wrapped with wrap-ansi
// (which counts CJK as 2 and keeps ANSI styles intact across line breaks), then
// handed to cli-table3 with wordWrap OFF — cli-table3's own wrap mis-measures CJK.
function renderTable(header: string[], rows: string[][], maxWidth: number): string {
  const content = tableColumnWidths(header, rows, maxWidth);
  const wrapRow = (cells: string[]): string[] => cells.map((c, i) => wrapAnsi(c ?? "", content[i], { hard: true, trim: false }));
  const t = new Table({
    head: wrapRow(header),
    colWidths: content.map((w) => w + 2), // cli-table3 widths include the 2 padding columns
    wordWrap: false, // we already wrapped — cli-table3 would mis-wrap CJK
    style: { head: [], border: [] }, // no extra colour; keep the dim theme from the caller
  });
  for (const r of rows) t.push(wrapRow(r));
  return t.toString();
}

// The terminal theme, matched to ui.ts (cyan headers, yellow code, dim borders).
function renderer(width: number) {
  return markedTerminal({
    width, // wrap paragraphs/tables to this many columns
    reflowText: true, // re-wrap long paragraphs to `width` instead of one long line
    tab: 2, // list indentation
    showSectionPrefix: false, // drop the literal "## " in front of headings
    firstHeading: chalk.cyan.bold,
    heading: chalk.cyan.bold,
    code: chalk.yellow, // fenced code block
    codespan: chalk.cyan, // `inline code`
    blockquote: chalk.gray.italic,
    strong: chalk.bold,
    em: chalk.italic,
    del: chalk.dim.strikethrough,
    link: chalk.cyan.underline,
    href: chalk.cyan.underline,
    paragraph: (s: string) => s,
  });
}

// Render a complete markdown string to ANSI. Pure (width injectable), so tests
// can assert on the output without a real terminal. A fresh Marked per call
// keeps width overridable and avoids leaking global parser state.
export function renderMarkdown(md: string, width = termWidth()): string {
  const w = Math.max(20, width);
  const m = new Marked();
  m.use(renderer(w));
  // Override the table renderer AFTER marked-terminal so ours wins: render each
  // cell's inline markdown to ANSI (parseInline), then lay the table out to fit w.
  m.use({
    renderer: {
      table(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Table): string {
        const header = token.header.map((c) => this.parser.parseInline(c.tokens));
        const rows = token.rows.map((r) => r.map((c) => this.parser.parseInline(c.tokens)));
        return renderTable(header, rows, w) + "\n";
      },
    },
  });
  const out = m.parse(md, { async: false }) as string;
  return out.replace(/\s+$/g, ""); // trim the trailing blank lines marked-terminal adds
}

function termWidth(): number {
  return (process.stdout.columns || 80) - 4; // leave room for our 2-col gutter + margin
}

// ---- streaming glue ---------------------------------------------------------
// marked renders a WHOLE document; the model streams tokens. The bridge: buffer
// text and flush one markdown *block* at a time, where a block ends at a blank
// line that is NOT inside a ``` fence. So a paragraph, heading, list, or table
// renders the moment it's complete — you keep the live "it's typing" feel, but
// every block lands fully formatted (a table needs all its rows to align).
export class MarkdownStream {
  private buf = ""; // text not yet flushed
  private firstLine = true; // the very first printed line gets the ⏺ prefix
  constructor(
    private write: (s: string) => void, // where rendered lines go (stdout in prod)
    private opts: { firstPrefix?: string; indent?: string } = {},
  ) {}

  // Feed streamed tokens; flushes any blocks that are now complete.
  push(chunk: string): void {
    this.buf += chunk;
    for (let i = this.boundary(); i >= 0; i = this.boundary()) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i).replace(/^\n+/, ""); // drop the blank-line separator
      if (block.trim()) this.emit(block);
    }
  }

  // End of answer: render whatever's left as the final block.
  end(): void {
    if (this.buf.trim()) this.emit(this.buf);
    this.buf = "";
  }

  // Index of the first blank-line boundary that sits OUTSIDE a code fence, or -1.
  // Counting fence markers before the candidate tells us if we're inside one.
  private boundary(): number {
    for (let from = 0; ; ) {
      const i = this.buf.indexOf("\n\n", from);
      if (i < 0) return -1;
      const fences = (this.buf.slice(0, i).match(/^[ \t]*(```|~~~)/gm) || []).length;
      if (fences % 2 === 0) return i; // even number of fences → not inside one
      from = i + 2; // this blank line is inside a fence; keep looking
    }
  }

  // Render one block and print it, with a left gutter so wrapped lines align
  // under the ⏺ marker (first physical line uses firstPrefix, the rest indent).
  private emit(md: string): void {
    const indent = this.opts.indent ?? "  ";
    const rendered = renderMarkdown(md, (process.stdout.columns || 80) - indent.length - 1);
    const out = rendered.split("\n").map((ln) => {
      const prefix = this.firstLine ? (this.opts.firstPrefix ?? indent) : indent;
      this.firstLine = false;
      return prefix + ln;
    });
    this.write(out.join("\n") + "\n");
  }
}

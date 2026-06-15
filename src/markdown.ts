import { Marked } from "marked"; // the parser
import { markedTerminal } from "marked-terminal"; // the ANSI renderer
import chalk from "chalk"; // our one color source — keep the theme consistent with ui.ts

// Why a library here, not hand-rolled? Markdown→terminal is a solved, fiddly
// problem (CJK-aware table widths, nested lists, code fences, link rewriting).
// The agent's *core* is hand-written on purpose; this is pure presentation, so
// we lean on `marked` + `marked-terminal` and spend our effort on the streaming
// glue instead. The model speaks markdown; without this the screen shows raw
// `##`, `**`, and `|---|` — exactly the ugliness this module removes.

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
  const m = new Marked();
  m.use(renderer(Math.max(20, width)));
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

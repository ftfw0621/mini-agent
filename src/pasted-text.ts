export interface PastedText { label: string; text: string }

// Terminal-independent storage for folded text. Labels are presentation only:
// expand exactly once before hooks, permission context or model submission.
// Keep entries for the session so recalling an earlier draft never loses text.
export class PastedTextStore {
  private entries = new Map<string, PastedText>();
  private sequence = 0;

  fold(text: string): string {
    const lines = text.split(/\r\n|\r|\n/).length;
    if (lines < 4 && text.length < 1000) return text;
    const size = lines > 1 ? `${lines - 1} lines` : `${Array.from(text).length} chars`;
    const label = `[Pasted text #${++this.sequence} +${size}]`;
    this.entries.set(label, { label, text });
    return label;
  }

  expand(input: string): string {
    return input.replace(/\[Pasted text #\d+ \+\d+ (?:lines|chars)\]/g, (label) => this.entries.get(label)?.text ?? label);
  }

  // A capsule is one editing unit: arrows jump over it and Backspace removes
  // it whole, including when a mouse/other editor leaves the caret inside it.
  at(input: string, cursor: number, direction: "left" | "right"): { start: number; end: number } | undefined {
    for (const match of input.matchAll(/\[Pasted text #\d+ \+\d+ (?:lines|chars)\]/g)) {
      if (!this.entries.has(match[0])) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (direction === "left" ? start < cursor && cursor <= end : start <= cursor && cursor < end) return { start, end };
    }
    return undefined;
  }
}

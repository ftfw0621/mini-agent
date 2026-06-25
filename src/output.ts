import ora, { type Ora } from "ora"; // the "thinking…" spinner the default sink drives
import { MarkdownStream } from "./markdown.js"; // the default sink renders the streamed answer as terminal markdown
import { mark } from "./ui.js"; // the ⏺ answer marker, kept consistent with the rest of the UI

// ---- the loop's output seam -------------------------------------------------
// The agent loop used to write to process.stdout DIRECTLY — ora spinners, a
// MarkdownStream for the streamed answer, and ~two dozen console.log narration
// lines. That is fine for the readline REPL, which owns the terminal. It is
// fatal for an Ink REPL: Ink redraws a live region every frame, so any stray
// write into that region corrupts it. (And the one way to avoid the clash —
// unmount Ink during a turn — makes the input box vanish while the answer
// streams, the one thing we set out NOT to do.)
//
// So the loop now talks to a LoopOutput sink instead of stdout. The DEFAULT
// sink below reproduces the old behaviour byte-for-byte, so `npm start` (the
// readline REPL) is unchanged. The Ink REPL passes its OWN sink that turns each
// of these calls into React state, so the same events render inside Ink's tree.
//
// Everything here takes already-formatted strings (chalk colours baked in): the
// loop decides WHAT to say and HOW it looks; the sink only decides WHERE it goes.

// A handle on one live spinner. A fresh one is made per model call (so concurrent
// teammates/sub-agents don't clobber a single shared spinner), matching the old
// `ora(...).start()` per streamModelCall.
export interface OutputSpinner {
  set(text: string): void; // update the displayed text — a no-op once stopped
  stop(): void; // stop and clear it
  readonly spinning: boolean; // still animating? (the loop checks before stopping/updating)
}

// A handle on one streamed answer. Tokens arrive a few characters at a time; the
// sink decides how/when to paint them (the default buffers a markdown block and
// flushes it whole, exactly like before).
export interface AnswerSink {
  push(token: string): void; // a chunk of streamed answer text
  end(): void; // the answer is complete — flush whatever is buffered
}

// Where the loop's user-visible output goes. Default → stdout (below); Ink → React state.
export interface LoopOutput {
  spinner(text: string): OutputSpinner; // a fresh spinner, already started, showing `text`
  reasoning(line: string): void; // the one-line "💭 thought for Ns …" indicator (after the trace is stashed for Ctrl+R)
  answer(): AnswerSink; // a fresh streamed-answer renderer for this turn
  note(line: string): void; // a single line of narration / progress / error (the old console.log sites)
}

// ---- the default sink: stdout, identical to the pre-sink behaviour -----------

class StdoutSpinner implements OutputSpinner {
  private readonly s: Ora;
  constructor(text: string) {
    // discardStdin:false — ora would otherwise swallow Ctrl+C while spinning.
    this.s = ora({ text, discardStdin: false }).start();
  }
  set(text: string): void {
    if (this.s.isSpinning) this.s.text = text;
  }
  stop(): void {
    if (this.s.isSpinning) this.s.stop();
  }
  get spinning(): boolean {
    return this.s.isSpinning;
  }
}

// The sink the readline REPL (and every non-Ink caller) gets when it passes no
// `output`. Each method is the exact line the loop used to run inline.
export const STDOUT_OUTPUT: LoopOutput = {
  spinner: (text) => new StdoutSpinner(text),
  reasoning: (line) => process.stdout.write(line + "\n"),
  answer: () => {
    // Lazily build the MarkdownStream on the first token (so a tool-only or
    // empty turn prints nothing), then end with a single trailing newline —
    // exactly the old `if (printedPrefix) process.stdout.write("\n")`.
    let md: MarkdownStream | null = null;
    let printed = false;
    return {
      push(token: string): void {
        if (!md) md = new MarkdownStream((s) => process.stdout.write(s), { firstPrefix: "\n" + mark.answer, indent: "  " });
        printed = true;
        md.push(token);
      },
      end(): void {
        if (md) md.end();
        if (printed) process.stdout.write("\n");
      },
    };
  },
  note: (line) => console.log(line),
};

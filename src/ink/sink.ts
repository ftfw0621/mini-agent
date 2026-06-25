import type { LoopOutput } from "../output.js"; // the seam the loop writes through

// The Ink side of the output seam. Where the stdout sink (src/output.ts) writes
// to process.stdout, this sink turns each call into React state, so the agent
// loop's narration renders INSIDE Ink's tree — above the pinned input box, which
// is the whole point of the rewrite. The loop never knows the difference: it
// calls spinner()/reasoning()/answer()/note() exactly the same way.

// One committed line of conversation, destined for the <Static> scrollback.
// `user` is your prompt, `answer` is a finished reply (rendered as markdown),
// `note` is any already-formatted narration line (tool tally, "💭 thought…",
// retries, team/sub-agent progress) — its chalk colours are baked in already.
export type Item = { kind: "user"; text: string } | { kind: "answer"; text: string } | { kind: "note"; text: string };

// The React state mutators the sink needs. The App owns the state and passes
// these in; they are stable (useState setters), so the sink is built once.
export interface InkSinkApi {
  setStatus: (text: string | null) => void; // the live spinner line (dynamic region) — null hides it
  setLive: (text: string | null) => void; // the streaming answer (dynamic region) — null hides it
  pushItem: (item: Item) => void; // commit a line to the scrollback (<Static>)
}

// Build a LoopOutput backed by Ink state. Pure glue: every method maps a loop
// event to a state change.
export function makeInkSink(api: InkSinkApi): LoopOutput {
  return {
    // A spinner becomes the single "status" line below the conversation. A fresh
    // handle per model call (the loop makes one per round); `active` mirrors
    // ora's isSpinning so the loop's `spinner?.spinning` checks behave the same.
    spinner(text) {
      api.setStatus(text);
      let active = true;
      return {
        set: (t) => {
          if (active) api.setStatus(t);
        },
        stop: () => {
          if (active) {
            active = false;
            api.setStatus(null);
          }
        },
        get spinning() {
          return active;
        },
      };
    },
    // The "💭 thought for Ns" indicator is just a committed line.
    reasoning: (line) => api.pushItem({ kind: "note", text: line }),
    // The streamed answer accumulates in the dynamic region as raw text (live,
    // "it's typing"), then commits as ONE markdown-rendered item when it ends —
    // partial markdown mid-stream renders badly, so we format only once it's whole.
    //
    // THROTTLED on purpose: a fast stream delivers tokens dozens of times a
    // second, and Ink erases+redraws the whole live region on every state change
    // — repainting a multi-line block that often is what makes a long answer
    // "shake" violently. So we coalesce a burst of tokens into ONE setLive every
    // ~90ms (≈11 fps, smooth but cheap). The final, complete answer still commits
    // to <Static> on end(), so nothing is lost or under-rendered.
    answer() {
      let buf = "";
      let timer: ReturnType<typeof setTimeout> | null = null;
      api.setLive("");
      return {
        push: (tok) => {
          buf += tok;
          if (!timer) timer = setTimeout(() => { timer = null; api.setLive(buf); }, 90); // leading-edge throttle: schedule one repaint, ignore the burst until it fires
        },
        end: () => {
          if (timer) { clearTimeout(timer); timer = null; } // drop the pending repaint — we're committing now
          api.setLive(null); // clear the live preview first, then commit (no flicker/duplicate)
          if (buf.trim()) api.pushItem({ kind: "answer", text: buf });
        },
      };
    },
    // Generic narration — already chalk-formatted by the loop; just commit it.
    note: (line) => api.pushItem({ kind: "note", text: line }),
  };
}

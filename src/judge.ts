import OpenAI from "openai"; // the judge is just another model call
import { emit } from "./telemetry.js"; // observe the judge's decisions

// An OPTIONAL second layer over the rule-based permission gate. The rules
// (permissions.ts) own deny and the obvious allows; whatever they mark "ask"
// is the ambiguous middle — an unfamiliar-but-maybe-harmless command like
// `ffmpeg ...`. Asking the human about every one of those is approval fatigue.
//
// The judge looks ONLY at those "ask" verdicts and answers one question: is
// this clearly safe? If yes, we skip the prompt; if no (or it is unsure, or it
// errors), we keep asking. Two invariants make this safe to add:
//   1. The judge NEVER sees a deny — deny always wins, the rules decide it.
//   2. The judge can only DOWNGRADE ask→allow for the clearly safe. It can
//      never create an allow the rules denied, and any doubt stays "ask".
// In other words: the judge reduces friction, it never reduces safety.

// The judge prompt is deliberately blunt and asks for a single rigid token, so
// parsing is unambiguous. "Err on the side of NO" is the load-bearing line.
const JUDGE_SYSTEM = `You are a security classifier for a coding agent. You are shown ONE shell command that the agent wants to run. Decide whether it is CLEARLY SAFE to run without asking a human.

CLEARLY SAFE = read-only or trivially reversible, no data loss, no network exfiltration, no privilege change, no writes outside the project, no credential access.
NOT clearly safe = anything that deletes, overwrites, installs, pushes, sends data out, changes permissions, or that you are unsure about.

Err strongly on the side of NO. When in doubt, answer no.
Respond with EXACTLY one line and nothing else: <safe>yes</safe> or <safe>no</safe>`;

const JUDGE_MAX_TOKENS = 16; // we only need one tiny tagged token — keep it cheap and fast
const MAX_CONSECUTIVE_JUDGE_ERRORS = 3; // after this many failures, disable the judge for the session

// Parse the judge's reply. PURE function (no I/O) so the safety logic is unit
// testable without the network. Fail closed: anything that is not an
// unambiguous "yes" means "ask".
export function interpretJudgeOutput(text: string): "allow" | "ask" {
  const m = text.toLowerCase().match(/<safe>\s*(yes|no)\s*<\/safe>/); // strict tag, nothing else trusted
  if (!m) return "ask"; // no clean verdict → ask (fail closed)
  return m[1] === "yes" ? "allow" : "ask"; // only a clear yes downgrades
}

// Tracks the judge's health across a session so a flaky/misconfigured judge
// degrades gracefully to "always ask" instead of silently failing on every call.
export class Judge {
  private consecutiveErrors = 0; // resets on any successful classification
  private disabled = false; // tripped after too many consecutive errors

  constructor(
    private client: OpenAI, // same client as the loop
    private model: string, // the judge model (often the main model; could be a cheaper one)
  ) {}

  // Classify one "ask" command. Returns "allow" only when the judge is
  // confident it is safe; "ask" in every other case (unsure, error, disabled).
  async classify(command: string): Promise<"allow" | "ask"> {
    if (this.disabled) return "ask"; // circuit breaker tripped — back to asking
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: JUDGE_MAX_TOKENS, // tiny — this must be cheap
        temperature: 0, // deterministic classification
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: `Command:\n${command}` }, // ONLY the command — no chat history to be injected through
        ],
      });
      this.consecutiveErrors = 0; // a clean call resets the breaker
      const verdict = interpretJudgeOutput(res.choices[0]?.message?.content ?? "");
      emit("agent_judge_verdict", { verdict }); // allow / ask, for tuning
      return verdict;
    } catch {
      // A judge that errors must never accidentally allow something. Count the
      // failure, and after a few in a row, stop trying (degrade to asking).
      this.consecutiveErrors++;
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_JUDGE_ERRORS) {
        this.disabled = true;
        emit("agent_judge_disabled", {}); // we gave up on the judge this session
      }
      return "ask"; // fail closed
    }
  }
}

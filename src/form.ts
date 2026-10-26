import chalk from "chalk"; // rendering only

// A multi-question form: the agent asks several multiple-choice questions at
// once, the user answers each and submits, and the answers come back organized.
// "Let the user choose, don't make them type" taken to its conclusion — instead
// of the model asking in prose and the user writing a paragraph back, it pops a
// structured form and collects clean, unambiguous selections.
//
// The layout is Claude Code's AskUserQuestion: one TAB per question in a bar
// along the top (← ☐ Branch ☒ Output ✔ Submit →), numbered options with a dim
// description under each, checkboxes for a multi-select question, a "Type
// something" row for an answer that is not on the list, "Chat about this" to
// talk instead of pick, and a final Submit tab that reviews every answer.
//
// The state machine and rendering are PURE and live here, so every transition is
// unit-testable; the keyboard drivers (menu.ts for readline, the Ink app) are
// thin shells on top. Typed text lives in the driver's own line editor and
// arrives with each action, so the form never edits text itself.

export interface FormOption {
  label: string; // the choice, short
  description?: string; // what picking it means, shown dim under the label
}

export interface FormQuestion {
  question: string; // the prompt
  header?: string; // the tab label, a word or two ("Branch"); defaults to Q1, Q2…
  options: FormOption[];
  multiSelect?: boolean; // checkboxes: any number of options, then Next/Submit
}

export interface FormAnswer {
  question: string;
  answer: string; // the chosen label(s), comma-separated, or the typed answer
}

// What the user did with the form: submitted it, chose to chat about it
// instead, or cancelled (Esc / the review tab's Cancel).
export type FormOutcome = "submit" | "chat" | "cancel";

export interface FormState {
  tab: number; // the question on screen; questions.length = the review tab
  cursor: number; // the row within that tab
  picked: number[][]; // per question: chosen option indexes; options.length stands for the typed answer
  typed: string[]; // per question: the typed answer ("" = none yet)
}

export type FormAction = "up" | "down" | "left" | "right" | "enter" | "escape";

// The rows of a tab, top to bottom. A question tab: its options, the typed
// answer, Next/Submit when multi-select, then Chat. The review tab: Submit and
// Cancel.
export type FormRow =
  | { kind: "option"; index: number }
  | { kind: "typed" }
  | { kind: "next" }
  | { kind: "chat" }
  | { kind: "submit" }
  | { kind: "cancel" };

export function formRows(questions: FormQuestion[], tab: number): FormRow[] {
  const q = questions[tab];
  if (!q) return [{ kind: "submit" }, { kind: "cancel" }];
  return [
    ...q.options.map((_, index): FormRow => ({ kind: "option", index })),
    { kind: "typed" },
    ...(q.multiSelect ? [{ kind: "next" } as FormRow] : []),
    { kind: "chat" },
  ];
}

export function initFormState(questions: FormQuestion[]): FormState {
  return { tab: 0, cursor: 0, picked: questions.map(() => []), typed: questions.map(() => "") };
}

// Is the cursor on a "Type something" row? The drivers route typed keys into
// their line editor there (and load / clear it as the cursor arrives / leaves).
export function onTypedRow(questions: FormQuestion[], state: FormState): boolean {
  return formRows(questions, state.tab)[state.cursor]?.kind === "typed";
}

const answered = (state: FormState, q: number): boolean => state.picked[q].length > 0;

// Land on a tab with the cursor on its first chosen option, or at the top.
function goToTab(state: FormState, tab: number): FormState {
  return { ...state, tab, cursor: Math.max(0, state.picked[tab]?.[0] ?? 0) };
}

// The one transition function. `text` is what the driver's editor holds while
// the cursor is on a "Type something" row; it is stored as that question's
// typed answer before the action runs, so leaving the row keeps it. Returns the
// next state, and an `outcome` when the form is finished.
export function reduceForm(questions: FormQuestion[], state: FormState, action: FormAction, text?: string): { state: FormState; outcome?: FormOutcome } {
  const single = questions.length === 1; // no tabs, no review: picking submits
  let s: FormState = { ...state, picked: state.picked.map((p) => p.slice()), typed: state.typed.slice() };
  const q = questions[s.tab];
  const typedIndex = q?.options.length ?? -1;
  if (q && text !== undefined && onTypedRow(questions, s)) {
    s.typed[s.tab] = text.trim();
    // A multi-select typed answer counts as checked exactly while it has text.
    if (q.multiSelect) s.picked[s.tab] = s.picked[s.tab].filter((i) => i !== typedIndex).concat(s.typed[s.tab] ? [typedIndex] : []);
  }
  const rows = formRows(questions, s.tab);
  const advance = (): { state: FormState; outcome?: FormOutcome } =>
    single ? (answered(s, 0) ? { state: s, outcome: "submit" } : { state: s }) : { state: goToTab(s, s.tab + 1) };

  switch (action) {
    case "up":
      return { state: { ...s, cursor: Math.max(0, s.cursor - 1) } };
    case "down":
      return { state: { ...s, cursor: Math.min(rows.length - 1, s.cursor + 1) } };
    case "left":
    case "right":
      if (single) return { state: s };
      return { state: goToTab(s, Math.min(questions.length, Math.max(0, s.tab + (action === "left" ? -1 : 1)))) };
    case "escape":
      return { state: s, outcome: "cancel" };
  }

  // enter
  const row = rows[s.cursor];
  switch (row?.kind) {
    case "option":
      if (q.multiSelect) {
        const on = s.picked[s.tab].includes(row.index);
        s.picked[s.tab] = on ? s.picked[s.tab].filter((i) => i !== row.index) : [...s.picked[s.tab], row.index].sort((a, b) => a - b);
        return { state: s };
      }
      s.picked[s.tab] = [row.index];
      return advance();
    case "typed":
      if (!s.typed[s.tab]) return { state: s }; // nothing typed yet
      if (q.multiSelect) return { state: { ...s, cursor: s.cursor + 1 } }; // checked by having text; move on to Next/Submit
      s.picked[s.tab] = [typedIndex];
      return advance();
    case "next":
      return advance();
    case "chat":
      return { state: s, outcome: "chat" };
    case "submit": {
      const gap = questions.findIndex((_, i) => !answered(s, i));
      return gap < 0 ? { state: s, outcome: "submit" } : { state: goToTab(s, gap) }; // jump to what is still open
    }
    case "cancel":
      return { state: s, outcome: "cancel" };
  }
  return { state: s };
}

// One question's answer: chosen labels in option order, the typed answer last.
function answerText(q: FormQuestion, state: FormState, i: number): string {
  return state.picked[i].map((p) => (p === q.options.length ? state.typed[i] : q.options[p]?.label ?? "")).filter(Boolean).join(", ");
}

// Turn a completed form into question→answer pairs for the model.
export function collectAnswers(questions: FormQuestion[], state: FormState): FormAnswer[] {
  return questions.map((q, i) => ({ question: q.question, answer: answerText(q, state, i) || "(unanswered)" }));
}

// The footer: what the keys do right now.
export function formHint(questions: FormQuestion[], state: FormState): string {
  if (onTypedRow(questions, state)) return "Type your answer · Enter to use it · ↑/↓ to move · Esc to cancel";
  return `Enter to select · ↑/↓ to move${questions.length > 1 ? " · ←/→ or Tab to switch questions" : ""} · Esc to cancel`;
}

// Render the current tab. `live` is the driver's editor text, shown on the
// "Type something" row while the cursor is on it.
export function renderForm(questions: FormQuestion[], state: FormState, live?: string): string {
  const lines: string[] = [];
  if (questions.length > 1) {
    const tabs = questions.map((q, i) => {
      const label = ` ${answered(state, i) ? "☒" : "☐"} ${q.header || `Q${i + 1}`} `;
      return i === state.tab ? chalk.inverse(label) : label;
    });
    const submit = state.tab === questions.length ? chalk.inverse(" ✔ Submit ") : " ✔ Submit ";
    lines.push(`${chalk.dim("←")}${[...tabs, submit].join("")}${chalk.dim("→")}`, "");
  }

  const rows = formRows(questions, state.tab);
  const mark = (i: number, text: string) => (i === state.cursor ? chalk.cyan(`❯ ${text}`) : `  ${text}`);
  const q = questions[state.tab];
  if (!q) {
    // The review tab: every question with its answer, then Submit / Cancel.
    lines.push(chalk.bold("Review your answers"), "");
    questions.forEach((qq, i) => {
      const answer = answerText(qq, state, i);
      lines.push(` ● ${qq.question}`, answer ? chalk.green(`   → ${answer}`) : chalk.yellow("   → (not answered)"));
    });
    lines.push("", chalk.dim("Ready to submit your answers?"), "");
    rows.forEach((row, i) => lines.push(mark(i, `${i + 1}. ${row.kind === "submit" ? "Submit answers" : "Cancel"}`)));
  } else {
    lines.push(chalk.bold(q.question), "");
    const typedIndex = q.options.length;
    rows.forEach((row, i) => {
      const box = (on: boolean) => (q.multiSelect ? (on ? chalk.green("[✔] ") : "[ ] ") : "");
      if (row.kind === "option") {
        const option = q.options[row.index];
        const on = state.picked[state.tab].includes(row.index);
        const label = !q.multiSelect && on ? chalk.green(`${option.label} ✔`) : option.label;
        lines.push(mark(i, `${row.index + 1}. ${box(on)}${label}`));
        if (option.description) lines.push(chalk.dim(`     ${q.multiSelect ? "    " : ""}${option.description}`));
      } else if (row.kind === "typed") {
        const text = i === state.cursor && live !== undefined ? live : state.typed[state.tab];
        const on = state.picked[state.tab].includes(typedIndex);
        const shown = text ? (!q.multiSelect && on ? chalk.green(`${text} ✔`) : text) : chalk.dim("Type something");
        lines.push(mark(i, `${typedIndex + 1}. ${box(on)}${shown}`));
      } else if (row.kind === "next") {
        lines.push(mark(i, `   ${questions.length > 1 && state.tab < questions.length - 1 ? "Next" : "Submit"}`));
      } else if (row.kind === "chat") {
        lines.push(chalk.dim("  ─────"), mark(i, `${typedIndex + 2}. Chat about this`));
      }
    });
  }
  lines.push("", chalk.dim(formHint(questions, state)));
  return lines.join("\n");
}

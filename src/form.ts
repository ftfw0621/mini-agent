import chalk from "chalk"; // rendering only

// A multi-question form: the agent asks several multiple-choice questions at
// once, the user answers each and submits, and the answers come back organized.
// "Let the user choose, don't make them type" taken to its conclusion — instead
// of the model asking in prose and the user writing a paragraph back, it pops a
// structured form and collects clean, unambiguous selections.
//
// The state machine and rendering are PURE and live here, so every transition is
// unit-testable; the raw-mode keyboard driver (menu.ts) is a thin shell on top.

export interface FormQuestion {
  question: string; // the prompt
  options: string[]; // the choices (single-select per question)
}

export interface FormState {
  cursor: number; // flat index over [all option rows…, submit row]
  selections: number[]; // selections[q] = chosen option index, or -1 if unanswered
}

export type FormAction = "up" | "down" | "select";

export interface FormAnswer {
  question: string;
  answer: string;
}

// The rows are a flat list: every option of every question, then one submit row.
// rowCount = total options + 1. The cursor walks this flat list.
export function formRowCount(questions: FormQuestion[]): number {
  return questions.reduce((n, q) => n + q.options.length, 0) + 1; // +1 for "Submit"
}

// Map a flat cursor to either a question/option, or the submit row.
export function rowAt(questions: FormQuestion[], cursor: number): { q: number; opt: number } | { submit: true } {
  let i = cursor;
  for (let q = 0; q < questions.length; q++) {
    if (i < questions[q].options.length) return { q, opt: i };
    i -= questions[q].options.length;
  }
  return { submit: true };
}

// The flat cursor position of a question's first option — used to jump the
// cursor to the first unanswered question when the user tries to submit early.
function cursorForQuestion(questions: FormQuestion[], q: number): number {
  let c = 0;
  for (let i = 0; i < q; i++) c += questions[i].options.length;
  return c;
}

export function initFormState(questions: FormQuestion[]): FormState {
  return { cursor: 0, selections: questions.map(() => -1) }; // nothing chosen yet
}

// The one transition function. Returns the next state, and `done: true` only
// when the user submits with every question answered.
export function reduceForm(questions: FormQuestion[], state: FormState, action: FormAction): { state: FormState; done?: boolean } {
  const rows = formRowCount(questions);
  if (action === "up") return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
  if (action === "down") return { state: { ...state, cursor: Math.min(rows - 1, state.cursor + 1) } };

  // select (Enter / Space)
  const row = rowAt(questions, state.cursor);
  if ("submit" in row) {
    const firstUnanswered = state.selections.findIndex((s) => s < 0);
    if (firstUnanswered < 0) return { state, done: true }; // all answered → submit for real
    return { state: { ...state, cursor: cursorForQuestion(questions, firstUnanswered) } }; // nudge to the gap
  }
  const selections = state.selections.slice();
  selections[row.q] = row.opt; // set this question's answer (single-select)
  return { state: { ...state, selections } };
}

// Turn a completed form into question→answer pairs for the model.
export function collectAnswers(questions: FormQuestion[], state: FormState): FormAnswer[] {
  return questions.map((q, i) => ({ question: q.question, answer: q.options[state.selections[i]] ?? "(unanswered)" }));
}

const FORM_HINT = chalk.dim("↑↓ to move · Enter to choose / submit · Esc to cancel");

// Render the whole form: each question with radio-style options, the cursor on
// one row, then a submit row. Line count is constant for a given question set
// (selections don't add/remove lines), which is what lets the driver redraw in
// place by moving the cursor up a fixed number of lines.
export function renderForm(questions: FormQuestion[], state: FormState): string {
  const lines: string[] = ["The agent needs your input:", ""];
  let flat = 0;
  questions.forEach((q, qi) => {
    lines.push(chalk.bold(`${qi + 1}. ${q.question}`));
    q.options.forEach((opt, oi) => {
      const onCursor = state.cursor === flat;
      const chosen = state.selections[qi] === oi;
      const text = `${chosen ? "●" : "○"} ${opt}`; // filled radio = chosen
      lines.push(onCursor ? chalk.cyan.bold(`❯ ${text}`) : chosen ? chalk.cyan(`  ${text}`) : chalk.dim(`  ${text}`));
      flat++;
    });
    lines.push("");
  });
  const onSubmit = state.cursor === flat; // the submit row is last
  const allAnswered = state.selections.every((s) => s >= 0);
  const submitText = allAnswered ? "▶ Submit answers" : "▶ Submit answers (answer every question first)";
  lines.push(onSubmit ? chalk.green.bold(`❯ ${submitText}`) : chalk.dim(`  ${submitText}`));
  lines.push("");
  lines.push(FORM_HINT);
  return lines.join("\n");
}

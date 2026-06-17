import chalk from "chalk"; // the one color source — match ui.ts's vocabulary

// The agent's own scratch plan. Why a whole tool for a checklist? Because a long
// task fills the context with tool output, and the model drifts — it forgets the
// third of five things you asked for. A todo list is the model's working memory
// of intent: it writes the plan down, then ticks items off as it goes, so the
// ORIGINAL goal survives a screen full of file reads. Crucially this adds
// PLANNING, not new powers — todo_write changes nothing on disk; it only makes
// the model's intent visible (to you) and durable (to itself).

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface Todo {
  content: string; // the step, phrased as an action ("Add the retry budget")
  status: TodoStatus;
}

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];

// ---- pure: validate the model's argument into a clean Todo[] ----------------
// The model's arguments are probabilistic, so be strict and return a precise
// repair message (errors are text the model can act on) rather than trusting it.
// Rule worth enforcing: AT MOST ONE in_progress — "do one thing at a time" is the
// whole discipline a plan buys you; many-in-progress is just a relabeled backlog.
export function parseTodos(raw: unknown): { todos?: Todo[]; error?: string } {
  if (!Array.isArray(raw)) return { error: "`todos` must be an array of { content, status }" };
  const todos: Todo[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    if (typeof item !== "object" || item === null) return { error: `todo #${i + 1} must be an object with content + status` };
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) return { error: `todo #${i + 1} is missing non-empty "content"` };
    if (!STATUSES.includes(item.status as TodoStatus)) return { error: `todo #${i + 1} has bad status "${String(item.status)}" — use pending | in_progress | completed` };
    todos.push({ content, status: item.status as TodoStatus });
  }
  if (todos.filter((t) => t.status === "in_progress").length > 1) return { error: "only one todo may be in_progress at a time — finish or re-queue the others" };
  return { todos };
}

// ---- pure: render the checklist for the terminal ----------------------------
// Glyphs over words: a column of ✓ / ▶ / ○ scans at a glance. The in-progress
// item is the loud one (that's where attention belongs); done items fade.
export function renderTodos(todos: Todo[]): string {
  if (!todos.length) return chalk.dim("  (no todos)");
  return todos
    .map((t) => {
      if (t.status === "completed") return chalk.green("  ✓ ") + chalk.dim.strikethrough(t.content);
      if (t.status === "in_progress") return chalk.cyan.bold("  ▶ ") + chalk.bold(t.content);
      return chalk.dim("  ○ " + t.content);
    })
    .join("\n");
}

// ---- pure: a one-line confirmation for the MODEL (cheap, no ANSI) -----------
// The pretty list goes to the screen; the model only needs the tally + what it
// said it's doing now, so we don't burn tokens echoing its own plan back at it.
export function summarizeTodos(todos: Todo[]): string {
  const done = todos.filter((t) => t.status === "completed").length;
  const doing = todos.find((t) => t.status === "in_progress");
  const pending = todos.filter((t) => t.status === "pending").length;
  const head = `Plan saved — ${done} done, ${doing ? 1 : 0} in progress, ${pending} pending.`;
  if (doing) return `${head} Now: ${doing.content}`;
  if (todos.length && done === todos.length) return `${head} All items complete.`;
  return head;
}

// ---- session state + the nag --------------------------------------------------
// The current plan lives for the session (in process memory, like Claude Code's).
let current: Todo[] = [];
let staleRounds = 0; // tool-rounds since the plan was last touched

export function setTodos(todos: Todo[]): void {
  current = todos;
  staleRounds = 0; // an update is a fresh signal — restart the patience clock
}
export function getTodos(): Todo[] {
  return current;
}
export function clearTodos(): void {
  current = [];
  staleRounds = 0; // /clear and session switches wipe the plan too
}

// Call once per tool-round. If there's an unfinished plan the model has stopped
// touching, return a reminder to inject (else null). This is the "nag": without
// it the model writes a plan once and never looks back — the list goes stale and
// stops meaning anything. We re-arm after firing, so it nudges every N rounds,
// not every round (which would be noise).
export const NAG_AFTER_ROUNDS = 3;
export function todoNag(): string | null {
  const unfinished = current.some((t) => t.status !== "completed");
  if (!current.length || !unfinished) return null; // no plan, or all done → nothing to nag about
  staleRounds++;
  if (staleRounds < NAG_AFTER_ROUNDS) return null;
  staleRounds = 0; // re-arm
  return "[plan reminder] Your todo list still has unfinished items but you haven't updated it in a few steps. If you've made progress, call todo_write to mark items completed / move the next one to in_progress; if the plan changed, rewrite it. Don't lose the original goal.";
}

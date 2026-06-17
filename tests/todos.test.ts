import { parseTodos, renderTodos, summarizeTodos, setTodos, getTodos, clearTodos, todoNag, NAG_AFTER_ROUNDS, type Todo } from "../src/todos.js"; // unit under test
import { check, checkContains, finish } from "./helpers.js"; // assertions

// ---- parseTodos: strict validation ------------------------------------------
const ok = parseTodos([
  { content: "Read the file", status: "completed" },
  { content: "Fix the bug", status: "in_progress" },
  { content: "Run tests", status: "pending" },
]);
check("valid list parses", !ok.error && ok.todos?.length === 3, JSON.stringify(ok));
check("content is trimmed + status kept", ok.todos?.[1].content === "Fix the bug" && ok.todos?.[1].status === "in_progress");

check("non-array is rejected", !!parseTodos("nope").error);
check("missing content is rejected", !!parseTodos([{ status: "pending" }]).error);
check("empty content is rejected", !!parseTodos([{ content: "   ", status: "pending" }]).error);
check("bad status is rejected", !!parseTodos([{ content: "x", status: "doing" }]).error);
check("two in_progress is rejected", !!parseTodos([{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }]).error);
check("empty array is allowed (clears the plan)", parseTodos([]).error === undefined && parseTodos([]).todos?.length === 0);

// ---- renderTodos: a scannable checklist -------------------------------------
const list: Todo[] = [
  { content: "done thing", status: "completed" },
  { content: "current thing", status: "in_progress" },
  { content: "later thing", status: "pending" },
];
const rendered = renderTodos(list);
checkContains("completed shows a check", rendered, "✓");
checkContains("in_progress shows an arrow", rendered, "▶");
checkContains("pending shows a circle", rendered, "○");
checkContains("content is shown", rendered, "current thing");
checkContains("empty list renders a placeholder", renderTodos([]), "no todos");

// ---- summarizeTodos: the cheap line for the model ---------------------------
const sum = summarizeTodos(list);
checkContains("summary counts the done items", sum, "1 done");
checkContains("summary names the in-progress item", sum, "current thing");
checkContains("all-done summary says so", summarizeTodos([{ content: "x", status: "completed" }]), "All items complete");

// ---- state + the nag --------------------------------------------------------
clearTodos();
check("no plan → no nag", todoNag() === null);

setTodos([{ content: "step", status: "pending" }]); // an unfinished plan
let fired: string | null = null;
for (let i = 0; i < NAG_AFTER_ROUNDS - 1; i++) check(`quiet for round ${i + 1}`, todoNag() === null);
fired = todoNag(); // the NAG_AFTER_ROUNDS-th round
check("nag fires after N quiet rounds", typeof fired === "string" && fired.includes("[plan reminder]"), String(fired));
check("nag re-arms (quiet again right after)", todoNag() === null);

setTodos([{ content: "step", status: "pending" }]); // updating the plan resets the clock
check("an update resets the nag clock", todoNag() === null);

clearTodos();
setTodos([{ content: "step", status: "completed" }]); // a finished plan
for (let i = 0; i < NAG_AFTER_ROUNDS + 1; i++) check(`completed plan never nags (round ${i + 1})`, todoNag() === null);

check("getTodos returns the live list", getTodos().length === 1 && getTodos()[0].status === "completed");
clearTodos();
check("clearTodos empties the plan", getTodos().length === 0);

finish();

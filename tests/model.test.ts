import { formatModelChoices } from "../src/ui.js"; // unit under test (the pure half of /model)
import { check, checkContains, finish } from "./helpers.js"; // assertions

// The picker mechanics (arrow nav, Esc) are covered by the Day 29 menu tests;
// here we just verify the model list is labeled correctly — the one in use is
// marked "(current)", the rest are plain.
const models = ["deepseek-chat", "deepseek-reasoner", "deepseek-coder"];

const labels = formatModelChoices(models, "deepseek-chat");
check("keeps every model", labels.length === 3);
checkContains("marks the current model", labels[0], "deepseek-chat  (current)");
check("does not mark the others", labels[1] === "deepseek-reasoner" && labels[2] === "deepseek-coder");

// A current model that isn't in the list (e.g. set via /model <name>) → nothing marked.
const none = formatModelChoices(models, "some-other-model");
check("no match → no '(current)' marker", none.every((l) => !l.includes("(current)")));

// Empty list stays empty (endpoint didn't implement /models).
check("empty list → empty labels", formatModelChoices([], "x").length === 0);

finish();

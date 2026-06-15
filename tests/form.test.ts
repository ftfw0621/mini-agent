import { EventEmitter } from "node:events"; // fake stdin for the interactive form
import { formRowCount, rowAt, initFormState, reduceForm, collectAnswers, renderForm, type FormQuestion } from "../src/form.js"; // pure form logic
import { promptForm } from "../src/menu.js"; // the interactive driver
import { check, checkContains, finish } from "./helpers.js"; // assertions

const QS: FormQuestion[] = [
  { question: "Which database?", options: ["Postgres", "SQLite"] },
  { question: "Auth method?", options: ["JWT", "Sessions", "OAuth"] },
];

// ---- flat row model --------------------------------------------------------------------
check("row count = all options + submit", formRowCount(QS) === 2 + 3 + 1);
check("cursor 0 is question 0 option 0", JSON.stringify(rowAt(QS, 0)) === JSON.stringify({ q: 0, opt: 0 }));
check("cursor 2 is question 1 option 0", JSON.stringify(rowAt(QS, 2)) === JSON.stringify({ q: 1, opt: 0 }));
check("last cursor is the submit row", "submit" in rowAt(QS, 5));

// ---- the reducer -----------------------------------------------------------------------
let s = initFormState(QS);
check("starts unanswered", s.selections.every((x) => x === -1) && s.cursor === 0);
s = reduceForm(QS, s, "down").state;
check("down moves the cursor", s.cursor === 1);
s = reduceForm(QS, s, "up").state;
s = reduceForm(QS, s, "up").state;
check("up clamps at the top", s.cursor === 0);
s = reduceForm(QS, s, "select").state; // choose Postgres for Q0
check("select records the answer", s.selections[0] === 0);
{
  // try to submit with Q1 still unanswered → no done, cursor jumps to Q1
  const atSubmit = { cursor: 5, selections: [0, -1] };
  const r = reduceForm(QS, atSubmit, "select");
  check("early submit does not finish", !r.done);
  check("early submit jumps to the first unanswered question", r.state.cursor === 2);
}
{
  // submit with everything answered → done
  const r = reduceForm(QS, { cursor: 6, selections: [1, 2] }, "select");
  check("submit with all answered finishes", r.done === true);
}

// ---- collected answers -----------------------------------------------------------------
const answers = collectAnswers(QS, { cursor: 0, selections: [0, 1] });
check("answers pair questions with chosen options", answers[0].answer === "Postgres" && answers[1].answer === "Sessions");

// ---- rendering -------------------------------------------------------------------------
const view = renderForm(QS, { cursor: 0, selections: [-1, -1] });
checkContains("render shows the question", view, "Which database?");
checkContains("render marks the cursor row", view, "❯");
checkContains("render has a submit row", view, "Submit answers");

// ---- end to end through promptForm (fake TTY) ------------------------------------------
function fakeStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as { isTTY: boolean; setRawMode: () => void; resume: () => void };
  s.isTTY = true;
  s.setRawMode = () => {};
  s.resume = () => {};
  return s as unknown as NodeJS.ReadStream;
}
const rlStub = { pause() {}, resume() {} } as unknown as import("node:readline").Interface;
const press = (input: NodeJS.ReadStream, k: object) => (input as unknown as EventEmitter).emit("keypress", "", k);

{
  const input = fakeStdin();
  const p = promptForm(rlStub, QS, input);
  press(input, { name: "return" }); // Q0 → Postgres (cursor 0)
  press(input, { name: "down" }); // → SQLite row
  press(input, { name: "down" }); // → Q1 JWT
  press(input, { name: "down" }); // → Q1 Sessions
  press(input, { name: "return" }); // choose Sessions for Q1
  press(input, { name: "down" }); // → OAuth
  press(input, { name: "down" }); // → submit row
  press(input, { name: "return" }); // submit (all answered)
  const got = await p;
  check("form returns answers when all chosen and submitted", got !== null && got.length === 2);
  check("first answer is Postgres", got?.[0].answer === "Postgres");
  check("second answer is Sessions", got?.[1].answer === "Sessions");
}
{
  const input = fakeStdin();
  const p = promptForm(rlStub, QS, input);
  press(input, { name: "escape" });
  check("escape cancels the form (null)", (await p) === null);
}
check("non-TTY form returns null", (await promptForm(rlStub, QS, fakeNonTty())) === null);
function fakeNonTty(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as { isTTY: boolean; setRawMode: () => void };
  s.isTTY = false;
  s.setRawMode = () => {};
  return s as unknown as NodeJS.ReadStream;
}

finish();

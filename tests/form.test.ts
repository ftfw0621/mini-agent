import { EventEmitter } from "node:events"; // fake stdin for the interactive form
import { formRows, initFormState, reduceForm, collectAnswers, renderForm, onTypedRow, formHint, type FormQuestion } from "../src/form.js"; // pure form logic
import { promptForm } from "../src/menu.js"; // the interactive driver
import { check, checkContains, finish } from "./helpers.js"; // assertions

const QS: FormQuestion[] = [
  { question: "Which database?", header: "Database", options: [{ label: "Postgres", description: "A server; scales out" }, { label: "SQLite", description: "One file" }] },
  { question: "Which outputs?", header: "Output", multiSelect: true, options: [{ label: "Card" }, { label: "Log file" }, { label: "Bell" }] },
];
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ""); // strip colors
const kinds = (tab: number) => formRows(QS, tab).map((r) => r.kind).join(",");

// ---- the rows of each tab ---------------------------------------------------------------
check("a single-select tab: options, typed answer, chat", kinds(0) === "option,option,typed,chat");
check("a multi-select tab adds Next/Submit before chat", kinds(1) === "option,option,option,typed,next,chat");
check("the review tab: submit, cancel", kinds(2) === "submit,cancel");

// ---- a full pass: pick, toggle, type, review, submit -------------------------------------
let r = reduceForm(QS, reduceForm(QS, initFormState(QS), "down").state, "enter");
check("picking an option moves to the next question", r.state.picked[0].join() === "1" && r.state.tab === 1 && r.state.cursor === 0 && !r.outcome);
let s = reduceForm(QS, r.state, "enter").state; // check Card
s = reduceForm(QS, reduceForm(QS, s, "down").state, "down").state;
s = reduceForm(QS, s, "enter").state; // check Bell
check("multi-select toggles options in place", s.picked[1].join() === "0,2" && s.tab === 1);
s = reduceForm(QS, s, "enter").state;
check("a second Enter unchecks", s.picked[1].join() === "0");
s = reduceForm(QS, s, "down").state;
check("the cursor reaches the typed row", onTypedRow(QS, s));
s = reduceForm(QS, s, "down", "  Slack DM ").state;
check("leaving a typed row keeps its text, checked in multi-select", s.typed[1] === "Slack DM" && s.picked[1].join() === "0,3" && !onTypedRow(QS, s));
r = reduceForm(QS, s, "enter"); // Submit (the next row) on the last question
check("the last question's Submit opens the review", r.state.tab === 2 && !r.outcome);
checkContains("the review lists every answer", plain(renderForm(QS, r.state)), "→ Card, Slack DM");
r = reduceForm(QS, r.state, "enter");
check("submitting with every question answered finishes", r.outcome === "submit");
check("answers pair questions with labels, the typed answer last", JSON.stringify(collectAnswers(QS, r.state)) === JSON.stringify([{ question: "Which database?", answer: "SQLite" }, { question: "Which outputs?", answer: "Card, Slack DM" }]));

// ---- navigation and the other outcomes ------------------------------------------------
{
  const gap = reduceForm(QS, { ...initFormState(QS), tab: 2 }, "enter");
  check("submitting with an open question jumps to it", !gap.outcome && gap.state.tab === 0);
  let t = reduceForm(QS, initFormState(QS), "left").state;
  check("← stops at the first tab", t.tab === 0);
  for (let i = 0; i < 3; i++) t = reduceForm(QS, t, "right").state;
  check("→ stops at the review tab", t.tab === 2);
  check("returning to a tab puts the cursor on its choice", reduceForm(QS, { ...initFormState(QS), tab: 1, picked: [[1], []] }, "left").state.cursor === 1);
  check("Chat about this ends the form as chat", reduceForm(QS, { ...initFormState(QS), cursor: 3 }, "enter").outcome === "chat");
  check("Esc cancels", reduceForm(QS, initFormState(QS), "escape").outcome === "cancel");
  check("the review tab's Cancel cancels", reduceForm(QS, { ...initFormState(QS), tab: 2, cursor: 1 }, "enter").outcome === "cancel");
  const onTyped = { ...initFormState(QS), cursor: 2 };
  check("Enter on an empty typed row does nothing", !reduceForm(QS, onTyped, "enter", "  ").outcome && reduceForm(QS, onTyped, "enter", "").state.picked[0].length === 0);
  const typed = reduceForm(QS, onTyped, "enter", "MySQL");
  check("a typed single-select answer is chosen on Enter", typed.state.picked[0].join() === "2" && typed.state.tab === 1 && collectAnswers(QS, typed.state)[0].answer === "MySQL");
}

// ---- a single question: no tabs, no review, picking submits ----------------------------
const ONE: FormQuestion[] = [QS[0]];
{
  const view = plain(renderForm(ONE, initFormState(ONE)));
  check("a single question has no tab bar or review", !view.includes("✔ Submit") && !view.includes("Review your answers"));
  const picked = reduceForm(ONE, { ...initFormState(ONE), cursor: 1 }, "enter");
  check("a single question submits on the pick", picked.outcome === "submit" && collectAnswers(ONE, picked.state)[0].answer === "SQLite");
  check("moving never submits", !reduceForm(ONE, initFormState(ONE), "down").outcome && !reduceForm(ONE, initFormState(ONE), "right").outcome);
}

// ---- rendering ---------------------------------------------------------------------------
{
  const view = plain(renderForm(QS, initFormState(QS)));
  checkContains("the tab bar shows each header", view, "☐ Database");
  checkContains("the tab bar ends with Submit", view, "✔ Submit");
  checkContains("options are numbered, the cursor marked", view, "❯ 1. Postgres");
  checkContains("a description sits under its option", view, "A server; scales out");
  checkContains("there is a typed-answer row", view, "3. Type something");
  checkContains("chat is the last choice", view, "4. Chat about this");
  const multi = plain(renderForm(QS, { ...initFormState(QS), tab: 1, picked: [[0], [2]] }));
  check("answered tabs are marked", multi.includes("☒ Database") && multi.includes("☒ Output"));
  check("multi-select shows checkboxes and Submit", multi.includes("[ ] Card") && multi.includes("[✔] Bell") && multi.includes("   Submit"));
  checkContains("a typed row shows the live text", plain(renderForm(QS, { ...initFormState(QS), cursor: 2 }, "MySQL")), "3. MySQL");
  check("the hint changes on a typed row", formHint(QS, { ...initFormState(QS), cursor: 2 }).startsWith("Type your answer"));
}

// ---- end to end through promptForm (fake TTY) ------------------------------------------
function fakeStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as { isTTY: boolean; setRawMode: () => void; resume: () => void };
  s.isTTY = true;
  s.setRawMode = () => {};
  s.resume = () => {};
  return s as unknown as NodeJS.ReadStream;
}
function fakeNonTty(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as { isTTY: boolean; setRawMode: () => void };
  s.isTTY = false;
  s.setRawMode = () => {};
  return s as unknown as NodeJS.ReadStream;
}
const rlStub = { pause() {}, resume() {} } as unknown as import("node:readline").Interface;
const press = (input: NodeJS.ReadStream, k: object, str = "") => (input as unknown as EventEmitter).emit("keypress", str, k);

{
  const input = fakeStdin();
  const p = promptForm(rlStub, QS, input);
  press(input, { name: "return" }); // Database → Postgres, on to Output
  press(input, { name: "space" }); // check Card
  for (let i = 0; i < 3; i++) press(input, { name: "down" }); // → Type something
  press(input, {}, "Slack 私信"); // type an answer
  press(input, { name: "return" }); // keep it, on to Submit
  press(input, { name: "return" }); // → the review tab
  press(input, { name: "return" }); // Submit answers
  const got = await p;
  check("terminal form returns answers, the typed one included", Array.isArray(got) && got[0].answer === "Postgres" && got[1].answer === "Card, Slack 私信");
}
{
  const input = fakeStdin();
  const p = promptForm(rlStub, QS, input);
  press(input, { name: "tab" }); // → Output
  press(input, { name: "tab", shift: true }); // ← Database
  press(input, { name: "right" }); // → Output
  press(input, { name: "return" }); // check Card
  press(input, { name: "left" }); // ← Database, nothing chosen there yet
  press(input, { name: "return" }); // Postgres, on to Output
  for (let i = 0; i < 4; i++) press(input, { name: "down" }); // → Submit
  press(input, { name: "return" }); // → review
  press(input, { name: "return" }); // submit
  const got = await p;
  check("Tab, Shift+Tab and arrows switch questions", Array.isArray(got) && got[0].answer === "Postgres" && got[1].answer === "Card");
}
{
  const input = fakeStdin();
  const p = promptForm(rlStub, QS, input);
  press(input, { name: "escape" });
  check("escape cancels the form (null)", (await p) === null);
}
check("non-TTY form returns null", (await promptForm(rlStub, QS, fakeNonTty())) === null);
{
  const input = fakeStdin();
  const p = promptForm(rlStub, ONE, input);
  press(input, { name: "down" }); press(input, { name: "return" });
  const got = await p;
  check("single-question terminal form submits on selection", Array.isArray(got) && got[0].answer === "SQLite");
}
{
  const input = fakeStdin();
  const p = promptForm(rlStub, ONE, input);
  for (let i = 0; i < 3; i++) press(input, { name: "down" }); // → Chat about this
  press(input, { name: "return" });
  check("Chat about this returns chat", (await p) === "chat");
}
{
  const input = fakeStdin();
  let text = "";
  const p = promptForm(rlStub, QS, input, (value) => { text = value; return true; });
  press(input, {}, "换个方案");
  press(input, { name: "return" });
  check("form supports Chinese follow-up without fabricating an answer", (await p) === null && text === "换个方案");
}
finish();

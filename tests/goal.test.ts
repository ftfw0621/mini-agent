import fs from "node:fs"; // edit a file between goal turns (progress)
import os from "node:os"; // temp location
import path from "node:path"; // join paths
import { execFileSync } from "node:child_process"; // git init the scratch dir so the fingerprint sees bash-style changes
import type OpenAI from "openai"; // the fake verifier client's type
import { parseGoalCommand, goalCommand, getGoal, clearGoal, restoreGoal, startGoalTurn, settleGoalTurn, countGoalToolCall, interpretVerdict, recentObservations, runUpdateGoal, goalTurnContent, describeGoal, MAX_STALLED_TURNS } from "../src/goal.js"; // unit under test
import { saveSession, loadSession, sessionTitle } from "../src/session.js"; // the goal rides in the session file
import { check, checkContains, finish } from "./helpers.js"; // assertions

// The fingerprint reads git + the session's writes under the cwd — use a scratch repo.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-goal-"));
process.chdir(tmp);
execFileSync("git", ["init", "-q"]);
fs.writeFileSync("app.txt", "v0\n");

// ---- parse /goal ---------------------------------------------------------------
check("bare /goal shows", parseGoalCommand("").kind === "show");
check("pause / resume / clear are lifecycle words", ["pause", "resume", "clear"].every((w) => parseGoalCommand(w).kind === w));
const q = parseGoalCommand('make all tests pass --check "npm test && npm run typecheck"');
check("--check quoted: objective + full command", q.kind === "set" && q.objective === "make all tests pass" && q.check === "npm test && npm run typecheck", JSON.stringify(q));
const u = parseGoalCommand("fix the build --check npm run build");
check("--check unquoted takes the rest of the line", u.kind === "set" && u.check === "npm run build", JSON.stringify(u));
check("no --check → objective only", (() => { const p = parseGoalCommand("port the CLI to Deno"); return p.kind === "set" && p.objective === "port the CLI to Deno" && p.check === undefined; })());
check("--check with no command is an error", parseGoalCommand("x --check").kind === "error");
check("--check with no objective is an error", parseGoalCommand('--check "npm test"').kind === "error");

// ---- verifier verdict: fail closed --------------------------------------------
check("<done>yes</done> → done, reason kept", (() => { const v = interpretVerdict("<done>yes</done>\nall 12 tests passed"); return v.done && v.reason === "all 12 tests passed"; })());
check("<done>no</done> → not done", !interpretVerdict("<done>no</done>\nno test run seen").done);
check("case-insensitive tag", interpretVerdict("<DONE> Yes </DONE>").done);
check("garbage → not done (fail closed)", !interpretVerdict("looks done to me!").done);
check("empty → not done", !interpretVerdict("").done);

// ---- lifecycle: set → turn → settle ---------------------------------------------
check("no goal → no goal turn", startGoalTurn() === null);
const set = goalCommand('get app.txt to v3 --check "grep -q v3 app.txt"');
check("setting a goal returns the typed line as the auto-mode request", set.request === '/goal get app.txt to v3 --check "grep -q v3 app.txt"', JSON.stringify(set));
check("the goal is active", getGoal()?.status === "active");
const first = startGoalTurn();
check("an active goal yields a goal turn", first !== null);
checkContains("the goal turn restates the objective", first ?? "", "Objective: get app.txt to v3");
checkContains("…and the completion check", first ?? "", "grep -q v3 app.txt");
checkContains("…and how to end it", first ?? "", "update_goal");
check("no second goal turn while one is in flight", startGoalTurn() === null);

// A goal turn with ZERO tool calls pauses at once (the anti-spin rule).
const spin = settleGoalTurn("done", true);
check("a goal turn with no tool calls pauses the goal", getGoal()?.status === "paused" && !!spin, String(spin));
check("resume re-arms it (and is recorded as a request)", goalCommand("resume").request === "/goal get app.txt to v3" && getGoal()?.status === "active");

// Progress resets the stall count; MAX_STALLED_TURNS unchanged turns pause it.
startGoalTurn();
countGoalToolCall();
fs.writeFileSync("app.txt", "v1\n"); // the working tree moved
check("a turn that changed files: goal keeps going", settleGoalTurn("done", true) === null && getGoal()?.status === "active" && getGoal()?.stalls === 0);
for (let i = 1; i <= MAX_STALLED_TURNS; i++) {
  startGoalTurn();
  countGoalToolCall(); // busy — but nothing changes…
  fs.mkdirSync(".mini-agent", { recursive: true });
  fs.writeFileSync(path.join(".mini-agent", `log-${i}.jsonl`), "{}\n"); // …except our own bookkeeping, which is not progress
  settleGoalTurn("done", true);
}
check(`${MAX_STALLED_TURNS} turns with no change pause the goal`, getGoal()?.status === "paused" && (getGoal()?.note ?? "").includes("no file changes"), JSON.stringify(getGoal()));
goalCommand("resume");
check("resume clears the stall count", getGoal()?.stalls === 0);

// Interrupts: Esc pauses; an interrupt that only delivers a follow-up doesn't.
startGoalTurn();
check("interrupted to deliver a follow-up → still active", settleGoalTurn("user_interrupt", true, true) === null && getGoal()?.status === "active");
startGoalTurn();
settleGoalTurn("user_interrupt", true);
check("Esc pauses the goal", getGoal()?.status === "paused");
goalCommand("resume");
settleGoalTurn("user_interrupt", false);
check("Esc on your OWN turn pauses an active goal too", getGoal()?.status === "paused");
goalCommand("resume");
startGoalTurn();
countGoalToolCall();
settleGoalTurn("circuit_breaker", true);
check("a failed goal turn pauses (no retry storm)", getGoal()?.status === "paused" && (getGoal()?.note ?? "").includes("circuit_breaker"));
check("your own turn ending normally leaves the goal alone", (goalCommand("resume"), settleGoalTurn("done", false) === null && getGoal()?.status === "active"));
check("pause while active works", goalCommand("pause").message.includes("paused") && getGoal()?.status === "paused");
check("describeGoal shows status + how to resume", describeGoal(getGoal()).includes("[paused]") && describeGoal(getGoal()).includes("/goal resume"));
check("plain text on a paused goal does not restart it (startGoalTurn stays null)", startGoalTurn() === null);

// ---- update_goal ----------------------------------------------------------------
const verifier = (reply: string | Error, seen?: { prompt: string }) => ({
  chat: { completions: { create: async (req: { messages: { content: string }[] }) => {
    if (seen) seen.prompt = req.messages[1].content;
    if (reply instanceof Error) throw reply;
    return { choices: [{ message: { content: reply } }] };
  } } },
}) as unknown as OpenAI;
const transcript: OpenAI.ChatCompletionMessageParam[] = [
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "run_bash", arguments: '{"command":"cat app.txt"}' } }] },
  { role: "tool", tool_call_id: "c1", content: "v3" },
  { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "update_goal", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c2", content: "(earlier claim)" },
];
const ctx = (client: OpenAI) => ({ client, model: "m", signal: new AbortController().signal, transcript, note: () => {} });
const obs = recentObservations(transcript);
check("the verifier sees real tool results", obs.includes("run_bash") && obs.includes("v3"));
check("…but not update_goal's own calls", !obs.includes("earlier claim"));

goalCommand("resume");
checkContains("a bad status is an error", await runUpdateGoal('{"status":"done","report":"x"}', ctx(verifier("<done>yes</done>"))), "[error]");
checkContains("an empty report is an error", await runUpdateGoal('{"status":"complete","report":" "}', ctx(verifier("<done>yes</done>"))), "[error]");

// The check command is the hard gate: failing it never reaches the verifier.
let called = false;
const spy = { chat: { completions: { create: async () => { called = true; return { choices: [{ message: { content: "<done>yes</done>" } }] }; } } } } as unknown as OpenAI;
const failed = await runUpdateGoal('{"status":"complete","report":"app.txt says v3"}', ctx(spy));
check("a failing --check rejects the claim, goal stays active, verifier not called", failed.includes("Not complete") && getGoal()?.status === "active" && !called, failed);

fs.writeFileSync("app.txt", "v3\n");
const seen = { prompt: "" };
const rejected = await runUpdateGoal('{"status":"complete","report":"app.txt says v3"}', ctx(verifier("<done>no</done>\nno evidence the file was re-read", seen)));
check("check passes but the verifier says no → still active", rejected.includes("verifier rejected") && getGoal()?.status === "active", rejected);
checkContains("the verifier is told the check passed", seen.prompt, "passed (exit 0)");
checkContains("…and sees the objective", seen.prompt, "get app.txt to v3");
check("a verifier error never completes the goal (fail closed)", (await runUpdateGoal('{"status":"complete","report":"done"}', ctx(verifier(new Error("boom"))))).includes("Not complete") && getGoal()?.status === "active");
const ok = await runUpdateGoal('{"status":"complete","report":"cat app.txt → v3"}', ctx(verifier("<done>yes</done>\nthe file reads v3")));
check("check + verifier agree → complete", ok.includes("verified complete") && getGoal()?.status === "complete", ok);
check("a completed goal starts no more turns", startGoalTurn() === null);
checkContains("update_goal with no active goal is an error", await runUpdateGoal('{"status":"blocked","report":"x"}', ctx(verifier("<done>yes</done>"))), "[error]");

goalCommand("ship it");
const blocked = await runUpdateGoal('{"status":"blocked","report":"need the prod API key"}', ctx(verifier("")));
check("blocked → no more turns, the blocker is kept", getGoal()?.status === "blocked" && getGoal()?.note === "need the prod API key" && startGoalTurn() === null, blocked);

// ---- persistence: the goal rides in the session file -----------------------------
goalCommand("resume");
saveSession("goal-session", "m", [{ role: "user", content: "hi" }]);
const loaded = loadSession("goal-session");
check("the session file carries the goal", loaded?.goal?.objective === "ship it" && loaded.goal.status === "active", JSON.stringify(loaded?.goal));
clearGoal();
check("clearGoal drops it", getGoal() === null);
restoreGoal(loaded?.goal);
check("restoreGoal brings it back, still active (so --resume keeps going)", getGoal()?.objective === "ship it" && getGoal()?.status === "active");
check("…and it starts a goal turn right away", startGoalTurn() !== null);
restoreGoal(undefined);
check("a session without a goal clears it", getGoal() === null);
restoreGoal({ objective: "  " } as never);
check("a malformed goal is dropped", getGoal() === null);
check("a session started with /goal is titled by its objective", sessionTitle([{ role: "user", content: goalTurnContent({ objective: "fix the flaky test", status: "active", continuations: 1, stalls: 0, setAt: "" }) }]) === "fix the flaky test");
checkContains("continuation turns are numbered", goalTurnContent({ objective: "o", status: "active", continuations: 4, stalls: 0, setAt: "" }), "Continuation #4");

finish();

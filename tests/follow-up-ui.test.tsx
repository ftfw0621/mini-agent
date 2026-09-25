import chalk from "chalk";
import React from "react";
import { spinnerText } from "../src/ui.js";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { App } from "../src/ink/app.js";
import type { InkSession } from "../src/ink/setup.js";
import type { TurnHooks } from "../src/ink/chat.js";
import { AutoMode } from "../src/auto.js";
import { CONFIG } from "../src/config.js";
import { CostMeter, DEFAULT_PRICING } from "../src/cost.js";
import { TerminateReason } from "../src/loop.js";
import { clearToolCalls, recordToolCall, recordToolResult } from "../src/tui.js";
import { parseSkill } from "../src/skills.js";
import { check, finish } from "./helpers.js";
import { inboxFileName, currentSession, registerSession, unregisterSession, MAX_PEER_TURNS, type PeerMessage } from "../src/peers.js";

const sleep = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mini-follow-ui-"));
process.chdir(temp);
const previousHooks = CONFIG.hooks;
const previousModel = CONFIG.model;
const previousURL = CONFIG.baseURL;
CONFIG.model = "deepseek-flash"; CONFIG.baseURL = "https://api.deepseek.com";
const previousMemory = CONFIG.memory.autoExtract;
CONFIG.hooks = {}; CONFIG.memory.autoExtract = false;
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
let frame = "";
let rawFrame = ""; // the same frame with its colours, for highlight checks
let clears = 0;
let allOutput = "";
stdout.on("data", (bytes) => {
  const text = bytes.toString();
  if (text.includes("\x1b[2J")) clears++;
  const plain = stripVTControlCharacters(text);
  allOutput += plain;
  if (plain.includes("ctx")) { frame = plain; rawFrame = text; }
});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
let modelLists = 0;
const client = { models: { list: async () => { modelLists++; return { data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }; } }, chat: { completions: { create: async () => ({ choices: [{ message: { content: "UI title" } }] }) } } };
const autoMode = new AutoMode(undefined, { apiKey: "" });
autoMode.enabled = true;
process.env.MINI_AGENT_SKILL_USAGE = path.join(os.tmpdir(), `ma-ui-usage-${process.pid}.json`); // never read or write the real usage file
const reviewSkill = parseSkill("---\ndescription: Review this project\n---\nInspect files", "review");
const session = { client, messages: [], systemMessage: "test", initialSessionId: "ui-test", startedAt: Date.now(), costMeter: new CostMeter(DEFAULT_PRICING), skills: () => [reviewSkill], allSkills: () => [reviewSkill], autoMode, model: "test", dir: "demo", branch: null, bannerText: "Follow-up fixture", notices: [], getStatus: () => ({ ctxPct: 1, cost: 0, elapsedMs: 1000 }), disconnectMcp: () => {} } as unknown as InkSession;
let hooks!: TurnHooks;
let turns = 0;
let approved: boolean | undefined;
let answers: unknown;
const submitted: string[] = [];
const submittedContent: unknown[] = [];
let clipboardText: string | undefined;
const peerTurns: string[] = [];
const app = render(<App session={session} clipboard={{ read: async () => clipboardText === undefined ? { image: png } : { text: clipboardText } }} runTurn={async (_input, h) => {
  if (typeof _input === "string" && _input.startsWith("[Message from another mini-agent session")) { peerTurns.push(_input); return { reason: TerminateReason.Done }; } // an idle-started peer turn
  turns++; hooks = h;
  if (_input === null) {
    for (const message of h.followUps!.drain()) h.onFollowUp?.(message.displayText ?? message.text);
    return { reason: TerminateReason.Done, finalText: "Follow-up processed" };
  }
  if (_input === "Approval task" || _input === "Form task") {
    if (_input === "Approval task") approved = await h.confirm("Do the pending action?", "example");
    else answers = await h.askUser!([{ question: "Which option?", options: ["First", "Second"] }]);
    for (const message of h.followUps!.drain()) { submitted.push(message.text); submittedContent.push(message.content); h.onFollowUp?.(message.displayText ?? message.text); }
    return { reason: TerminateReason.Done };
  }
  const call = recordToolCall("external lookup", "args: {}", { id: "lookup", name: "external_lookup", args: "{}" });
  recordToolResult(call, "长结果 🔍 " .repeat(200));
  const spinner = h.output.spinner(spinnerText("Working", 1, false, 1200));
  await new Promise<void>((resolve) => h.signal.addEventListener("abort", () => resolve(), { once: true }));
  spinner.stop();
  return { reason: TerminateReason.UserInterrupt };
}} />, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, patchConsole: false, exitOnCtrlC: false });
const key = async (text: string) => { stdin.write(text); await sleep(); };
try {
  await sleep();
  check("auto mode lives below the status bar, outside the input", !frame.includes("auto ❯") && frame.includes("▶▶ auto mode on") && frame.indexOf("▶▶ auto mode on") > frame.indexOf("ctx"));
  await key("/auto"); await key("\r");
  check("mode footer follows the actual auto setting", !autoMode.enabled && !frame.includes("▶▶ auto mode on"));
  await key("/auto"); await key("\r");
  await key("/status local"); await key("\r");
  check("status command displays a framed usage card without starting an agent turn", turns === 0 && allOutput.includes("mini-agent · Status") && allOutput.includes("Current session") && allOutput.includes("permission review/Jev") && allOutput.includes(`╭${"─".repeat(78)}╮`));
  const previousFetch = globalThis.fetch;
  const previousKey = CONFIG.apiKey;
  let accountSignal: AbortSignal | null | undefined;
  try {
    CONFIG.apiKey = "status-ui-fixture";
    globalThis.fetch = async (_url, init) => {
      accountSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => accountSignal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    };
    await key("/status"); await key("\r");
    check("account status shows progress without starting the model", turns === 0 && frame.includes("Checking account usage") && !!accountSignal);
    await key("\x1b");
    check("Escape cancels account lookup and preserves local usage", accountSignal?.aborted === true && allOutput.includes("unavailable") && turns === 0);
  } finally { globalThis.fetch = previousFetch; CONFIG.apiKey = previousKey; }
  await key("Initial task"); await key("\r");
  check("busy animation keeps activity and tokens while model appears only in the footer", frame.includes("Working…") && frame.includes("↓ 1.2k tokens") && (frame.match(/deepseek-flash/g) ?? []).length === 1);
  await key("Additional instruction");
  check("busy input remains editable", frame.includes("Additional instruction"));
  await key("\x16"); await key("\r");
  check("busy image follow-up has a pending preview", frame.includes("Messages queued") && frame.includes("[Image #1]"));
  check("queued input has real image data", JSON.stringify(hooks.followUps?.pending[0]?.content).includes("data:image/png;base64,"));
  check("queued text is not yet user authorization", autoMode.snapshot().length === 1);
  await key("\x14");
  check("Ctrl+T opens a single detail panel", (frame.match(/Tool details/g) ?? []).length === 1);
  stdout.columns = 42; stdout.rows = 12; stdout.emit("resize"); await sleep();
  const before = clears; await sleep(1100);
  check("detail view fits a resized terminal without full-screen redraw loops", clears === before && frame.trimEnd().split("\n").length < stdout.rows);
  await key("\x1b");
  check("Escape closes details before interrupting queued work", !hooks.signal.aborted && turns === 1);
  stdout.columns = 80; stdout.rows = 24; stdout.emit("resize"); await sleep();
  await key("\x1b"); await sleep();
  check("Escape with a queued follow-up interrupts and resumes once", turns === 2 && !hooks.signal.aborted && hooks.followUps?.size === 0);
  check("delivery replaces the pending preview with a committed user message", !frame.includes("Messages queued") && allOutput.includes("> Additional instruction[Image #1]"));
  await key("Another task"); await key("\r");
  await key("Take this new direction"); await key("\x1b[13;5u"); await sleep();
  check("Ctrl+Enter submits and interrupts without leaking its escape sequence", turns === 4 && !hooks.signal.aborted && !allOutput.includes("[13;5u"));
  await key("/effort");
  check("effort completion opens under input before submission", frame.includes("/effort max") && !frame.includes("medium") && !frame.includes("empty input selects"));
  await key("\x1b[B"); await key("\x1b[B"); await key("\r");
  check("effort choice applies without starting a model turn", turns === 4 && allOutput.includes("deepseek-flash → low"));
  await key("Approval task"); await key("\r");
  await key("Please inspect only");
  check("approval menu keeps text input editable", frame.includes("Please inspect only") && approved === undefined);
  await key("\x16");
  CONFIG.hooks = { UserPromptSubmit: [{ command: 'node -e "setTimeout(() => {}, 350)"' }] };
  await key("\r"); await key("\r");
  check("second Enter cannot approve while follow-up hooks run", approved === undefined);
  await sleep(500); CONFIG.hooks = {};
  check("text submission declines pending action and delivers image follow-up", approved === false && submitted.at(-1)?.includes("Please inspect only[Image #2]") === true);
  await key("Form task"); await key("\r");
  check("single-question UI omits submit answers row", frame.includes("Which option?") && !frame.includes("Submit answers"));
  await key("\x1b[B"); await key("\r");
  check("single-question UI chooses and submits with one Enter", JSON.stringify(answers).includes("Second"));
  await key("Form task"); await key("\r");
  await key("Use another approach"); await key("\r"); await sleep();
  check("form text becomes follow-up instead of an answer", answers === null && submitted.at(-1) === "Use another approach");
  await key("Form task"); await key("\r");
  const longText = Array.from({ length: 14 }, (_, i) => `Long pasted line ${i + 1}`).join("\n");
  await key("Please inspect: "); await key(longText);
  check("multiline paste becomes a compact capsule", frame.includes("[Pasted text #1 +13 lines]") && !frame.includes("Long pasted line 1"));
  await key("\x16"); await key("\r"); await sleep();
  check("folded paste submits full text alongside real image data", submitted.at(-1) === `Please inspect: ${longText}[Image #3]` && JSON.stringify(submittedContent.at(-1)).includes("data:image/png;base64,"));
  check("sent follow-up keeps the compact display", allOutput.includes("> Please inspect: [Pasted text #1 +13 lines][Image #3]"));
  await key("/");
  check("slash opens described command list below the input", frame.indexOf("Toggle automatic permission review") > frame.indexOf("❯ /") && frame.includes("› /auto"));
  await key("\x1b[A");
  check("command navigation reaches choices beyond the visible window", frame.includes("› /review"));
  const listClears = clears; await sleep(1100);
  check("large command list stays inside viewport without repeated clears", clears === listClears && frame.trimEnd().split("\n").length < stdout.rows);
  stdout.columns = 42; stdout.rows = 12; stdout.emit("resize"); await sleep();
  check("completion window shrinks to fit small terminals", frame.trimEnd().split("\n").length < stdout.rows);
  stdout.columns = 80; stdout.rows = 24; stdout.emit("resize"); await sleep();
  await key("\x1b");
  check("Escape dismisses suggestions and preserves the draft", frame.includes("❯ /") && !frame.includes("↑↓ choose"));
  await key("ef"); await key("\t");
  check("typing filters and Tab completes a command without executing it", frame.includes("❯ /effort") && frame.includes("/effort max") && !frame.includes("empty input selects"));
  await key("high"); await key("\r");
  check("Enter submits the completed effort argument", allOutput.includes("deepseek-flash → high"));
  const colourLevel = chalk.level; chalk.level = 3; // this check needs real colour codes (Ink colours through the same chalk)
  await key("/rev");
  check("typing /<skill> at the start lists the skill with its description", frame.includes("› /review") && frame.includes("Review this project"));
  await key("\t");
  check("Tab fills the skill for arguments and closes the list", frame.includes("❯ /review") && !frame.includes("↑↓ choose"));
  check("the chosen skill is highlighted in the input", rawFrame.includes("38;2;177;185;249") || rawFrame.includes("\x1b[38;5;"), JSON.stringify(rawFrame.slice(0, 200)));
  chalk.level = colourLevel;
  for (let i = 0; i < 8; i++) await key("\x7f"); // clear the draft
  await key("/skills ");
  check("skills shows available names and descriptions inline", frame.includes("/skill review") && frame.includes("Review this project"));
  await key("\t");
  check("skill completion fills the executable invocation", frame.includes("❯ /skill review"));
  for (let i = 0; i < "/skill review ".length; i++) await key("\x7f"); // Tab fills "/name " with a trailing space, like Claude Code
  await key("hi /rev");
  check("a slash mid-text shows the rest of the match as ghost text, no list", frame.includes("hi /review") && !frame.includes("↑↓ choose"));
  await key("\t");
  check("Tab accepts the ghost as /name ", frame.includes("❯ hi /review"));
  for (let i = 0; i < "hi /review ".length; i++) await key("\x7f");
  // ---- /skills: Claude Code's manager (no mode change here — that would write the real settings file)
  await key("/skills"); await key("\r"); await sleep();
  check("/skills opens the manager with state, source and cost", frame.includes("Skills") && frame.includes("enter/space to cycle") && frame.includes("✔ on") && frame.includes("review · ") && frame.includes("tok"));
  check("the input box is hidden while the manager owns the keyboard", !frame.includes("│ ❯"));
  await key("/"); await key("/"); await key("zzz"); // a second "/" (people press it twice) must not become the query
  check("/ searches the skills", frame.includes('No skills match "zzz"') && frame.includes("type to filter"));
  await key("\x1b"); // leave search (clears it)
  check("leaving search restores the list", frame.includes("review · "));
  await key("t");
  check("t cycles the sort order", frame.includes("to sort (tokens)"));
  await key("\x1b");
  check("Esc closes the manager and reports no changes", allOutput.includes("No changes") && !frame.includes("enter/space to cycle"));
  // ---- /compact draws Claude Code's progress bar, then reports the result
  const originalCreate = client.chat.completions.create;
  let finishSummary!: () => void;
  (client.chat.completions as { create: unknown }).create = async () => (async function* () {
    await new Promise<void>((r) => { finishSummary = r; });
    yield { choices: [{ delta: { content: "summary" } }] };
  })();
  (session.messages as unknown[]).push({ role: "system", content: "test" }, { role: "user", content: "a long talk" });
  await key("/compact"); await key("\r"); await sleep(300);
  check("/compact shows the progress bar under the verb", frame.includes("Compacting conversation…") && /\n\s*▰*▱+ \d+%/.test(frame), frame);
  finishSummary(); await sleep();
  check("the bar goes away and the result is reported", !frame.includes("Compacting conversation…") && allOutput.includes("compacted:"));
  (client.chat.completions as { create: unknown }).create = originalCreate;
  // ---- peer sessions: a message while idle starts a turn; a streak is capped
  registerSession({ cwd: "/work/ui", branch: null, model: "test" });
  const dropPeerMessage = (text: string) => {
    const me = currentSession()!;
    const msg: PeerMessage = { id: text, from: { id: "p", name: "web", cwd: "/work/web", branch: null }, to: me.id, text, sentAt: Date.now() };
    fs.writeFileSync(path.join(process.env.MINI_AGENT_SESSIONS_DIR!, me.id, "inbox", inboxFileName(msg)), JSON.stringify(msg));
  };
  dropPeerMessage("hello from web"); await sleep(1300);
  check("an idle session answers a peer message on its own", peerTurns.length === 1 && peerTurns[0].includes("hello from web") && allOutput.includes("✉ message from web (/work/web)"));
  for (let i = 1; i <= MAX_PEER_TURNS; i++) { dropPeerMessage(`again ${i}`); await sleep(1300); }
  check("automatic peer turns stop after the cap", peerTurns.length === MAX_PEER_TURNS && allOutput.includes("paused after"), String(peerTurns.length));
  await key("/peers"); await key("\r");
  check("/peers shows this session", allOutput.includes('You are session "ui"'));
  unregisterSession();
  await key("/model"); await sleep();
  check("model options come from the active endpoint", frame.includes("/model deepseek-v4-pro") && modelLists === 1);
  await key(" "); await key("\x7f");
  check("model list is cached across keystrokes", modelLists === 1);
  for (let i = 0; i < "/model".length; i++) await key("\x7f");
  clipboardText = longText;
  await key("\x16");
  check("native clipboard text uses the same folding abstraction", frame.includes("[Pasted text #2 +13 lines]"));
  await key("\x1b[D"); await key("X");
  check("left arrow crosses the entire capsule", frame.includes("X[Pasted text #2 +13 lines]"));
  await key("\x1b[C"); await key("\x7f");
  check("Backspace removes the entire pasted-text capsule", !frame.includes("Pasted text #2") && frame.includes("❯ X"));
  await key("\x7f");
  await key("很长的输入".repeat(300));
  check("long editable drafts stay inside the dynamic viewport", frame.trimEnd().split("\n").length < stdout.rows);
} finally {
  app.unmount(); app.cleanup(); clearToolCalls();
  CONFIG.model = previousModel; CONFIG.baseURL = previousURL;
  CONFIG.hooks = previousHooks; CONFIG.memory.autoExtract = previousMemory;
  process.chdir(cwd); fs.rmSync(temp, { recursive: true, force: true });
}
finish();

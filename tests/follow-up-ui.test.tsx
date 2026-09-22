import React from "react";
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
import { check, finish } from "./helpers.js";

const sleep = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mini-follow-ui-"));
process.chdir(temp);
const previousHooks = CONFIG.hooks;
const previousMemory = CONFIG.memory.autoExtract;
CONFIG.hooks = {}; CONFIG.memory.autoExtract = false;
const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
let frame = "";
let clears = 0;
let allOutput = "";
stdout.on("data", (bytes) => {
  const text = bytes.toString();
  if (text.includes("\x1b[2J")) clears++;
  const plain = stripVTControlCharacters(text);
  allOutput += plain;
  if (plain.includes("ctx")) frame = plain;
});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "UI title" } }] }) } } };
const autoMode = new AutoMode(undefined, { apiKey: "" });
const session = { client, messages: [], systemMessage: "test", initialSessionId: "ui-test", startedAt: Date.now(), costMeter: new CostMeter(DEFAULT_PRICING), skills: [], autoMode, model: "test", dir: "demo", branch: null, bannerText: "Follow-up fixture", notices: [], getStatus: () => ({ ctxPct: 1, cost: 0, elapsedMs: 1000 }), disconnectMcp: () => {} } as unknown as InkSession;
let hooks!: TurnHooks;
let turns = 0;
const app = render(<App session={session} clipboard={{ read: async () => ({ image: png }) }} runTurn={async (_input, h) => {
  turns++; hooks = h;
  if (_input === null) {
    for (const message of h.followUps!.drain()) h.onFollowUp?.(message.text);
    return { reason: TerminateReason.Done, finalText: "Follow-up processed" };
  }
  const call = recordToolCall("external lookup", "args: {}", { id: "lookup", name: "external_lookup", args: "{}" });
  recordToolResult(call, "长结果 🔍 " .repeat(200));
  const spinner = h.output.spinner("Working…");
  await new Promise<void>((resolve) => h.signal.addEventListener("abort", () => resolve(), { once: true }));
  spinner.stop();
  return { reason: TerminateReason.UserInterrupt };
}} />, { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, patchConsole: false, exitOnCtrlC: false });
const key = async (text: string) => { stdin.write(text); await sleep(); };
try {
  await sleep(); await key("Initial task"); await key("\r");
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
  await key("很长的输入".repeat(300));
  check("long editable drafts stay inside the dynamic viewport", frame.trimEnd().split("\n").length < stdout.rows);
} finally {
  app.unmount(); app.cleanup(); clearToolCalls();
  CONFIG.hooks = previousHooks; CONFIG.memory.autoExtract = previousMemory;
  process.chdir(cwd); fs.rmSync(temp, { recursive: true, force: true });
}
finish();

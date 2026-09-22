import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jevReviewer, modelReviewer } from "../src/auto-providers.js";
import { type ReviewState } from "../src/auto-review.js";
import { check, finish } from "./helpers.js";
import { reviewDebugCommand } from "../src/auto-debug.js";

const cwd = process.cwd();
const oldFlag = process.env.MINI_AGENT_REVIEW_DEBUG;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-debug-"));
const file = path.join(dir, ".mini-agent/review-debug.jsonl");
const state: ReviewState = { userRequests: ["Fix the UI and run its tests."], projectInstructions: "", workingDirectory: "/project", deniedBySettings: [], history: { actions: [], omittedActions: 0 }, action: { tool: "run_bash", args: { command: "npx tsx tests/follow-up-ui.test.tsx 2>&1 | tail -40" } } };
const raw = JSON.stringify({ answers: { authorized: { type: "noul", noul: 0.22 }, risky: { type: "noul", noul: 0.24 } } });
let sent: unknown;
const reviewer = jevReviewer("test-secret-key", () => "test-jev", async (_url, init) => {
  sent = JSON.parse(String(init?.body));
  return new Response(raw, { headers: { "x-request-id": "test-request-id" } });
});
const signal = new AbortController().signal;
const records = () => fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
try {
  process.chdir(dir);
  delete process.env.MINI_AGENT_REVIEW_DEBUG;
  await reviewer.review(state, signal);
  check("debug defaults off and creates no file", !fs.existsSync(file));
  check("debug command leaves ordinary auto toggle alone", reviewDebugCommand("/auto") === null);
  check("debug status does not enable tracing", reviewDebugCommand("/auto debug status")?.includes("OFF") === true && process.env.MINI_AGENT_REVIEW_DEBUG === undefined);
  check("invalid debug arguments do not enable tracing", reviewDebugCommand("/auto debug anything")?.startsWith("Usage:") === true && process.env.MINI_AGENT_REVIEW_DEBUG === undefined);
  check("runtime command enables tracing and names output", reviewDebugCommand("/auto debug on")?.includes(file) === true);
  await reviewer.review(state, signal);
  const entries = records();
  check("logged request matches actual Jev body including policy", JSON.stringify(entries[0].request) === JSON.stringify(sent));
  check("raw reply and upstream request ID retained", entries[1].raw === raw && entries[1].requestId === "test-request-id");
  check("events correlate with timestamps and process", entries.length === 3 && entries.every((r) => r.id === entries[0].id && r.pid === process.pid && !Number.isNaN(Date.parse(r.ts))));
  check("normalization and shared verdict explain the ask", entries[2].assessment.authorized === 0.22 && entries[2].verdict.decision === "ask");
  check("credential header is never logged", !fs.readFileSync(file, "utf8").includes("test-secret-key"));
  if (process.platform !== "win32") check("debug file is owner-only", (fs.statSync(file).mode & 0o777) === 0o600);

  await reviewer.review({ ...state, action: { tool: "example", args: { api_key: "payload-secret", text: "test-secret-key" } } }, signal);
  check("payload credential fields and known keys are redacted", !/payload-secret|test-secret-key/.test(fs.readFileSync(file, "utf8")));
  const invalid = jevReviewer("test-secret-key", () => "test-jev", async () => new Response("invalid reply"));
  await invalid.review(state, signal).catch(() => {});
  check("invalid response and error retained for diagnosis", records().some((r) => r.raw === "invalid reply") && records().at(-1).event === "error");
  const failed = jevReviewer("test-secret-key", () => "test-jev", async () => { throw new Error("network failure test-secret-key"); });
  await failed.review(state, signal).catch(() => {});
  check("network error correlates and redacts credential", records().at(-1).error === "network failure <REDACTED>");

  const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"authorized":true,"risky":false}' } }] }) } } };
  await modelReviewer(client as never, () => "fallback-model").review(state, signal);
  const modelEvents = records().filter((r) => r.backend === "model");
  check("fallback logs actual messages and categorical assessment", modelEvents[0].request.messages.length === 2 && modelEvents[2].assessment.authorized === true);
  const size = fs.statSync(file).size;
  reviewDebugCommand("/auto debug off");
  await reviewer.review(state, signal);
  check("runtime disable stops recording future requests", fs.statSync(file).size === size);
  reviewDebugCommand("/auto debug on");
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  check("logging failure cannot change provider behavior", (await reviewer.review(state, signal)).authorized === 0.22);
} finally {
  process.chdir(cwd);
  if (oldFlag === undefined) delete process.env.MINI_AGENT_REVIEW_DEBUG;
  else process.env.MINI_AGENT_REVIEW_DEBUG = oldFlag;
  fs.rmSync(dir, { recursive: true, force: true });
}
finish();

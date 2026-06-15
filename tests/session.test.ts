import fs from "node:fs"; // set up a scratch project dir
import os from "node:os"; // temp location
import path from "node:path"; // join paths
import { saveSession, loadSession, listSessions, latestSession, sessionTitle } from "../src/session.js"; // unit under test
import { check, checkContains, finish } from "./helpers.js"; // assertions

// Sessions are written under the cwd's .mini-agent/sessions — chdir into a
// scratch dir so the test never pollutes the repo. (sessionsDir resolves the
// path lazily, so this works.)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-sessions-"));
process.chdir(tmp);

// ---- sessionTitle: the pickable one-liner -----------------------------------------------
check("title is the first user prompt", sessionTitle([{ role: "user", content: "fix the cart bug" }]) === "fix the cart bug");
check("title strips the @file attachment block", sessionTitle([{ role: "user", content: "explain @x\n\n[Referenced files]\n--- x ---\ncode" }]) === "explain @x");
check("title flattens whitespace to one line", sessionTitle([{ role: "user", content: "line one\n  line two" }]) === "line one line two");
check("title falls back when there is no user message", sessionTitle([{ role: "assistant", content: "hi" }]) === "(no prompt)");

// ---- save → list → load round trip ------------------------------------------------------
const idA = "2026-06-15T10-00-00-000Z";
saveSession(idA, "deepseek-chat", [{ role: "user", content: "first session task" }, { role: "assistant", content: "done" }]);
await new Promise((r) => setTimeout(r, 12)); // ensure a distinct mtime for ordering
const idB = "2026-06-15T11-00-00-000Z";
saveSession(idB, "deepseek-chat", [{ role: "user", content: "second session task" }]);

const list = listSessions(10);
check("both sessions are listed", list.length === 2);
check("newest is first", list[0].id === idB);
check("summary carries the title", list[0].title === "second session task");
check("summary counts the messages", list.find((s) => s.id === idA)?.messageCount === 2);

const loaded = loadSession(idA);
check("loadSession returns the requested session", loaded?.id === idA);
checkContains("loaded messages are intact", JSON.stringify(loaded?.messages ?? []), "first session task");
check("loading a missing session → null", loadSession("does-not-exist") === null);
check("latestSession is the newest", latestSession()?.id === idB);

// ---- cleanup ----------------------------------------------------------------------------
process.chdir(os.tmpdir());
fs.rmSync(tmp, { recursive: true, force: true });
finish();

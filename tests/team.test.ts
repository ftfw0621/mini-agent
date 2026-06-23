import fs from "node:fs"; // to assert the mailboxes are REAL files on disk (落盘)
import os from "node:os"; // temp location
import path from "node:path"; // join paths
import { LEAD, sendMessage, readInbox, inboxCount, registerTeammate, finishTeammate, teammateExists, teammateCount, activeTeammateCount, listTeam, resetTeam, type TeamMessage } from "../src/team.js"; // unit under test
import { check, checkContains, finish } from "./helpers.js"; // assertions

// Mailboxes are written under the cwd's .mini-agent/team — chdir into a scratch
// project dir so the test never touches the real repo, exactly like session.test.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-team-"));
process.chdir(tmp);

// ---- the bus persists to disk (the whole point of 落盘) ----------------------
sendMessage(LEAD, "api", "start with the routes");
const inboxFile = path.join(tmp, ".mini-agent", "team", "api.jsonl");
check("send writes a real .jsonl mailbox file on disk", fs.existsSync(inboxFile));
const onDisk = fs.readFileSync(inboxFile, "utf8").trim();
const parsed = JSON.parse(onDisk) as TeamMessage;
check("the on-disk line is valid JSON with the right shape", parsed.from === LEAD && parsed.to === "api" && parsed.content === "start with the routes" && parsed.type === "message" && typeof parsed.ts === "number", onDisk);

// ---- JSONL append: many messages accumulate ---------------------------------
sendMessage("db", "api", "schema is ready");
check("inboxCount peeks without consuming", inboxCount("api") === 2, String(inboxCount("api")));
check("peeking did NOT delete the file", fs.existsSync(inboxFile));

// ---- consumptive read: read empties the mailbox -----------------------------
const got = readInbox("api");
check("readInbox returns all pending messages in order", got.length === 2 && got[0].content === "start with the routes" && got[1].from === "db", JSON.stringify(got));
check("reading consumes: the file is gone", !fs.existsSync(inboxFile));
check("a consumed inbox reads empty", readInbox("api").length === 0);
check("inboxCount of an empty inbox is 0", inboxCount("api") === 0);

// ---- a result-type message --------------------------------------------------
sendMessage("api", LEAD, "done: added 3 routes", "result");
const leadMsgs = readInbox(LEAD);
check("result type is preserved through the round-trip", leadMsgs.length === 1 && leadMsgs[0].type === "result", JSON.stringify(leadMsgs));

// ---- the registry -----------------------------------------------------------
resetTeam(); // start from a clean registry
check("a fresh team has no teammates", teammateCount() === 0 && activeTeammateCount() === 0);

registerTeammate("api", "API routes", Promise.resolve());
registerTeammate("db", "database layer", Promise.resolve());
check("registered teammates are counted", teammateCount() === 2);
check("teammateExists finds a registered one", teammateExists("api") && !teammateExists("nope"));
check("both start as active/running", activeTeammateCount() === 2);

finishTeammate("api", true);
check("finishing one drops the active count", activeTeammateCount() === 1);

const snap = listTeam();
check("listTeam reports name/role/status", snap.length === 2 && snap.some((t) => t.name === "api" && t.status === "done") && snap.some((t) => t.name === "db" && t.status === "running"), JSON.stringify(snap));

finishTeammate("db", false);
check("a non-Done ending marks the teammate failed", listTeam().find((t) => t.name === "db")?.status === "failed");
check("no teammates remain active", activeTeammateCount() === 0);

// ---- reset clears everything ------------------------------------------------
resetTeam();
check("resetTeam empties the registry", teammateCount() === 0);

// ---- one more observability check: a pending inbox is inspectable ------------
sendMessage(LEAD, "worker", "ping");
checkContains("a pending message is readable straight off disk", fs.readFileSync(path.join(tmp, ".mini-agent", "team", "worker.jsonl"), "utf8"), "ping");
readInbox("worker"); // consume so we leave nothing behind

process.chdir(os.tmpdir()); // leave the scratch dir before it's cleaned
finish();

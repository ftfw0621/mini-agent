import fs from "node:fs"; // to assert the mailboxes are REAL files on disk (落盘)
import os from "node:os"; // temp location
import path from "node:path"; // join paths
import { LEAD, sendMessage, sendProtocol, readInbox, inboxCount, registerTeammate, finishTeammate, teammateExists, teammateCount, activeTeammateCount, listTeam, resetTeam, createRequest, getRequest, resolveResponse, openRequestsFor, setTeammateState, anyTeammateBusy, runningTeammates, markShutdown, shutdownRequestId, type TeamMessage } from "../src/team.js"; // unit under test
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
// Day 39: a running teammate reports its live sub-state (active/idle), not "running".
check("listTeam reports name/role/status", snap.length === 2 && snap.some((t) => t.name === "api" && t.status === "done") && snap.some((t) => t.name === "db" && t.status === "active"), JSON.stringify(snap));

finishTeammate("db", false);
check("a non-Done ending marks the teammate failed", listTeam().find((t) => t.name === "db")?.status === "failed");
check("no teammates remain active", activeTeammateCount() === 0);

// ---- Day 39: protocol state (request/response contracts) --------------------
resetTeam();
const reqId = createRequest("plan_approval", "api", LEAD, "refactor the routes");
check("createRequest returns a req_ id", /^req_\d{6}$/.test(reqId), reqId);
check("a new request is pending, with its payload", getRequest(reqId)?.status === "pending" && getRequest(reqId)?.payload === "refactor the routes");
check("openRequestsFor finds the lead's pending request", openRequestsFor(LEAD).some((r) => r.requestId === reqId));

// match_response: the response kind MUST match the request kind.
check("a mismatched response type is rejected (match_response guard)", resolveResponse(reqId, "shutdown", true).ok === false);
check("request is still pending after a mismatch", getRequest(reqId)?.status === "pending");
check("an unknown request id is rejected", resolveResponse("req_999999", "plan_approval", true).ok === false);

// correct correlation approves it, and you can't resolve twice.
const r1 = resolveResponse(reqId, "plan_approval", true);
check("a correctly-typed response resolves the request", r1.ok && r1.state?.status === "approved" && r1.state?.from === "api", JSON.stringify(r1));
check("a resolved request can't be resolved again", resolveResponse(reqId, "plan_approval", false).ok === false);
check("openRequestsFor no longer lists the resolved request", !openRequestsFor(LEAD).some((r) => r.requestId === reqId));

// a rejection sets the status to rejected.
const reqId2 = createRequest("plan_approval", "db", LEAD, "drop a table");
check("a rejected request ends up rejected", resolveResponse(reqId2, "plan_approval", false).ok && getRequest(reqId2)?.status === "rejected");

// ---- Day 39: protocol messages round-trip on the bus ------------------------
sendProtocol(LEAD, "api", "shutdown_request", "req_000042", "wrap up", undefined);
const protoMsgs = readInbox("api");
check("a protocol message carries kind + requestId through the bus", protoMsgs.length === 1 && protoMsgs[0].kind === "shutdown_request" && protoMsgs[0].requestId === "req_000042", JSON.stringify(protoMsgs));
sendProtocol("api", LEAD, "shutdown_response", "req_000042", "done", "approved");
const resp = readInbox(LEAD);
check("a response carries its status (approved/rejected)", resp[0].kind === "shutdown_response" && resp[0].status === "approved", JSON.stringify(resp));

// ---- Day 39: active/idle + shutdown plumbing --------------------------------
resetTeam();
registerTeammate("w1", "worker one", Promise.resolve());
check("a fresh teammate starts active", anyTeammateBusy() && listTeam()[0].status === "active");
setTeammateState("w1", "idle");
check("an idle teammate is not 'busy' (lead can wrap up)", !anyTeammateBusy() && listTeam()[0].status === "idle");
check("runningTeammates lists the running ones", runningTeammates().includes("w1"));
markShutdown("w1", "req_000007");
check("markShutdown records the request id the teammate replies with", shutdownRequestId("w1") === "req_000007");
finishTeammate("w1", true);
check("a finished teammate is no longer running", !runningTeammates().includes("w1"));

// ---- reset clears everything ------------------------------------------------
resetTeam();
check("resetTeam empties the registry", teammateCount() === 0);
check("resetTeam clears in-flight protocol state too", getRequest(reqId2) === undefined);

// ---- one more observability check: a pending inbox is inspectable ------------
sendMessage(LEAD, "worker", "ping");
checkContains("a pending message is readable straight off disk", fs.readFileSync(path.join(tmp, ".mini-agent", "team", "worker.jsonl"), "utf8"), "ping");
readInbox("worker"); // consume so we leave nothing behind

process.chdir(os.tmpdir()); // leave the scratch dir before it's cleaned
finish();

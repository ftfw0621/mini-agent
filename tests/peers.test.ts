import fs from "node:fs"; // the registry and inboxes are real files
import os from "node:os"; // temp location
import path from "node:path"; // join paths
import { spawn } from "node:child_process"; // a real second process, to prove pid liveness
import type OpenAI from "openai"; // message shapes
import { check, checkContains, finish } from "./helpers.js"; // assertions (also isolates the sessions dir)
import { inboxFileName, peerRow, setSessionInfo, SCREEN_KINDS, currentSession, describePeers, findPeer, listPeers, peerInboxPending, peerMessageContent, peersCommand, readPeerInbox, registerSession, renameSession, sendPeerMessage, sessionsDir, setSessionState, unregisterSession, type PeerMessage, type PeerRecord } from "../src/peers.js"; // unit under test
import { runLoop, TerminateReason } from "../src/loop.js"; // delivery + send_message end to end
import { CONFIG } from "../src/config.js"; // hooks off for the loop run

process.env.MINI_AGENT_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-peers-"));
const dir = sessionsDir();

// Another session, faked on disk: a record + an inbox, like a real one writes.
function fakePeer(over: Partial<PeerRecord>): PeerRecord {
  const rec: PeerRecord = { id: Math.random().toString(16).slice(2, 10), name: "web", pid: process.pid, cwd: "/work/web", branch: "main", model: "m", startedAt: Date.now(), lastSeen: Date.now(), state: "idle", terminal: "iTerm2 · ttys009", ...over };
  fs.mkdirSync(path.join(dir, rec.id, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec));
  return rec;
}
// A message dropped into THIS session's inbox, as a peer's send would.
function deliverToMe(text: string, from = "web"): void {
  const me = currentSession()!;
  const msg: PeerMessage = { id: Math.random().toString(16).slice(2, 10), from: { id: "x", name: from, cwd: `/work/${from}`, branch: "main" }, to: me.id, text, sentAt: Date.now() };
  fs.writeFileSync(path.join(dir, me.id, "inbox", inboxFileName(msg)), JSON.stringify(msg));
}
const inboxOf = (id: string) => fs.readdirSync(path.join(dir, id, "inbox"));

// ---- unregistered: everything is inert --------------------------------------
check("not registered → no session", currentSession() === null);
checkContains("not registered → send refuses", sendPeerMessage("web", "hi"), "not registered");
check("not registered → empty inbox", peerInboxPending() === 0 && readPeerInbox().length === 0);

// ---- registry ---------------------------------------------------------------
const web = fakePeer({ name: "web" });
const me = registerSession({ cwd: "/work/web", branch: "dev", model: "deepseek-flash" });
check("the default name is the folder, made unique among live sessions", me.name === "web-2", me.name);
check("own record is on disk", fs.existsSync(path.join(dir, `${me.id}.json`)));
check("register is idempotent", registerSession({ cwd: "/elsewhere", branch: null, model: "x" }).id === me.id);
check("listPeers excludes this session", listPeers().length === 1 && listPeers()[0].id === web.id);
check("findPeer by name is case-insensitive, and by id", findPeer("WEB")?.id === web.id && findPeer(web.id)?.id === web.id);

const deadPid = fakePeer({ name: "ghost", pid: 2 ** 22 + 12345 }); // no such pid
const stale = fakePeer({ name: "sleepy", lastSeen: Date.now() - 60 * 60_000 }); // alive pid, heartbeat an hour old
check("dead and stale sessions are not listed", !findPeer("ghost") && !findPeer("sleepy"));
check("…and are pruned with their inbox", !fs.existsSync(path.join(dir, `${deadPid.id}.json`)) && !fs.existsSync(path.join(dir, deadPid.id)) && !fs.existsSync(path.join(dir, `${stale.id}.json`)));

// A real second process: listed while alive, pruned once it exits.
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
const real = fakePeer({ name: "other-proc", pid: child.pid! });
check("a live separate process is listed", findPeer("other-proc")?.id === real.id);
child.kill();
await new Promise((r) => child.once("exit", r));
check("…and pruned after it exits", !findPeer("other-proc"));

// ---- rename -----------------------------------------------------------------
checkContains("rename refuses a taken name", renameSession("Web"), "already taken");
check("rename cleans the name", renameSession("  api server! ") === "api-server" && currentSession()!.name === "api-server");
check("rename is written to disk", JSON.parse(fs.readFileSync(path.join(dir, `${me.id}.json`), "utf8")).name === "api-server");
checkContains("/rename without a name shows usage", peersCommand("/rename")!, 'this session is "api-server"');
checkContains("/rename via the command", peersCommand("/rename api")!, '"api"');
check("unrelated lines are not peer commands", peersCommand("/peersx") === null && peersCommand("hello") === null);
setSessionState("busy");
check("state is published", JSON.parse(fs.readFileSync(path.join(dir, `${me.id}.json`), "utf8")).state === "busy");
setSessionState("idle");

// ---- sending ----------------------------------------------------------------
checkContains("send to a live peer", sendPeerMessage("web", "what does GET /users return?"), 'Delivered to session "web"');
const files = inboxOf(web.id);
check("one complete .json lands in the peer's inbox (no leftover .tmp)", files.length === 1 && files[0].endsWith(".json"), files.join(","));
const sent = JSON.parse(fs.readFileSync(path.join(dir, web.id, "inbox", files[0]), "utf8")) as PeerMessage;
check("the message names the sender", sent.from.name === "api" && sent.text === "what does GET /users return?" && sent.to === web.id);
const unknown = sendPeerMessage("nobody", "hi");
check("unknown recipient → error naming who is online", unknown.startsWith("[error]") && unknown.includes("Online: web"), unknown);
sendPeerMessage("web", "x".repeat(20_000));
const long = inboxOf(web.id).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, web.id, "inbox", f), "utf8")) as PeerMessage).find((m) => m.text.startsWith("xxx"))!;
check("oversized messages are truncated", long.text.length < 17_000 && long.text.includes("truncated"));

// ---- receiving --------------------------------------------------------------
fs.writeFileSync(path.join(dir, me.id, "inbox", "999-half.json.tmp"), "{"); // a send still in flight
check("an in-flight .tmp is not a message", peerInboxPending() === 0);
deliverToMe("first");
deliverToMe("second");
check("pending counts waiting messages", peerInboxPending() === 2);
const got = readPeerInbox();
check("read returns them oldest first and empties the inbox", got.map((m) => m.text).join(",") === "first,second" && peerInboxPending() === 0);
const envelope = peerMessageContent(got);
checkContains("envelope names the sender and where it runs", envelope, '"web" (/work/web, branch main)');
checkContains("envelope says it is not the user", envelope, "not from the user");
checkContains("envelope discourages acknowledgement ping-pong", envelope, "never just to acknowledge");
checkContains("describePeers shows self and peers", describePeers(), 'You are session "api"');
checkContains("describePeers lists the peer's state and cwd", describePeers(), "web · idle · /work/web");

// ---- the loop: list_peers, send_message to a peer, mid-turn delivery ----------
CONFIG.hooks = {};
fs.rmSync(path.join(dir, web.id, "inbox"), { recursive: true, force: true });
fs.mkdirSync(path.join(dir, web.id, "inbox"), { recursive: true });
const seen: OpenAI.ChatCompletionMessageParam[][] = [];
let round = 0;
const client = { chat: { completions: { create: async (params: { messages: OpenAI.ChatCompletionMessageParam[]; tools?: OpenAI.ChatCompletionTool[] }) => {
  seen.push([...params.messages]);
  const r = round++;
  const toolNames = (params.tools ?? []).map((t) => (t.type === "function" ? t.function.name : ""));
  return (async function* () {
    if (r === 0) {
      check("the top-level agent gets list_peers", toolNames.includes("list_peers"));
      deliverToMe("the reply from web", "web"); // arrives while this round's tools run
      yield { choices: [{ delta: { tool_calls: [
        { index: 0, id: "t1", function: { name: "list_peers", arguments: "{}" } },
        { index: 1, id: "t2", function: { name: "send_message", arguments: JSON.stringify({ to: "web", content: "ping from the loop" }) } },
      ] } }] };
    } else yield { choices: [{ delta: { content: "done" } }] };
  })();
} } } };
const history: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: "sys" }, { role: "user", content: "ask web" }];
const result = await runLoop(history, { client: client as never, model: "m", quiet: true, signal: new AbortController().signal, isInterrupted: () => false, confirm: async () => true });
check("loop finishes", result.reason === TerminateReason.Done);
const toolResults = history.filter((m) => m.role === "tool").map((m) => String(m.content));
check("list_peers result lists the peer", toolResults.some((c) => c.includes("web · idle")), toolResults.join(" | "));
check("send_message falls through to the peer session", toolResults.some((c) => c.includes('Delivered to session "web"')) && inboxOf(web.id).length === 1);
const second = seen[1] ?? [];
const toolIdx = second.findIndex((m) => m.role === "tool");
const peerIdx = second.findIndex((m) => m.role === "user" && String(m.content).includes("the reply from web"));
check("a message arriving mid-turn is delivered after the tool results", toolIdx >= 0 && peerIdx > toolIdx, `${toolIdx} ${peerIdx}`);

// ---- kinds: the conversation and the screen take different messages ----------
const drop = (kind: PeerMessage["kind"], text: string) => {
  const msg: PeerMessage = { id: text, kind, from: { id: web.id, name: "web", cwd: "/work/web", branch: null }, to: me.id, text, sentAt: Date.now() };
  fs.writeFileSync(path.join(dir, me.id, "inbox", inboxFileName(msg)), JSON.stringify(msg));
};
readPeerInbox(); readPeerInbox(SCREEN_KINDS);
drop("reply", "the answer"); drop("identify", "api"); drop("user", "from the human"); drop(undefined, "legacy agent");
check("conversation kinds skip replies and pings", peerInboxPending() === 2 && peerInboxPending(SCREEN_KINDS) === 2);
check("reading one kind leaves the others", readPeerInbox(["user"]).map((m) => m.text).join() === "from the human" && peerInboxPending() === 1 && peerInboxPending(SCREEN_KINDS) === 2);
check("screen kinds come out together", readPeerInbox(SCREEN_KINDS).map((m) => m.kind).join() === "reply,identify");
const human: PeerMessage = { id: "h", kind: "user", from: { id: web.id, name: "web", cwd: "/work/web", branch: null }, to: me.id, text: "run the tests", sentAt: 1 };
const humanEnvelope = peerMessageContent([human]);
check("a message typed by the user is not disclaimed as another agent's", humanEnvelope.includes("The user sent this") && !humanEnvelope.includes("not from the user"));
check("sessions record which terminal they run in", typeof currentSession()!.terminal === "string" && currentSession()!.terminal.length > 0);
setSessionInfo({ lastPrompt: "fix   the\nlogin bug" });
check("last prompt is stored on one line", currentSession()!.lastPrompt === "fix the login bug");
const row = peerRow({ ...web, cwd: path.join(os.homedir(), "work/web"), title: "Fix login" });
check("picker row: name, state, ~path, branch, terminal, what it's doing", row.startsWith("web  ·  idle  ·  ~/work/web (main)  ·  iTerm2 · ttys009  ·  “Fix login”"), row);
checkContains("identify by id works for send", sendPeerMessage(web.id, "web", "identify"), "Delivered");

// ---- leaving ----------------------------------------------------------------
const myId = me.id;
unregisterSession();
check("unregister removes the record and inbox", !fs.existsSync(path.join(dir, `${myId}.json`)) && !fs.existsSync(path.join(dir, myId)));
check("…and the session is gone", currentSession() === null);

fs.rmSync(dir, { recursive: true, force: true });
finish();

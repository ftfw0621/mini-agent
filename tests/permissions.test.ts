import { checkPermission } from "../src/permissions.js"; // the unit under test
import { CONFIG } from "../src/config.js"; // mutated directly to simulate user settings
import { check, finish } from "./helpers.js"; // assertions

// Assert that a tool call gets the expected verdict.
function expectVerdict(name: string, toolName: string, args: object, want: string): void {
  const v = checkPermission(toolName, JSON.stringify(args)); // run the gate
  check(name, v.decision === want, `got ${v.decision} (${v.reason})`);
}

// ---- read-only tools ---------------------------------------------------------------
expectVerdict("search is allow", "search", { pattern: "x" }, "allow");
expectVerdict("read normal file", "read_file", { path: "src/agent.ts" }, "allow");

// ---- secrets never enter context -----------------------------------------------------
expectVerdict("read .env denied", "read_file", { path: ".env" }, "deny");
expectVerdict("read id_rsa denied", "read_file", { path: "/Users/x/.ssh/id_rsa" }, "deny");
expectVerdict("read cert.pem denied", "read_file", { path: "certs/cert.pem" }, "deny");

// ---- writes ask, no-fly denies ---------------------------------------------------------
expectVerdict("edit normal file asks", "edit_file", { path: "src/agent.ts", old_string: "a", new_string: "b" }, "ask");
expectVerdict("write normal file asks", "write_file", { path: "hello.txt", content: "hi" }, "ask");
expectVerdict("write into .git denied", "write_file", { path: ".git/hooks/pre-commit", content: "x" }, "deny");
expectVerdict("edit .zshrc denied", "edit_file", { path: "/Users/x/.zshrc", old_string: "a", new_string: "b" }, "deny");
expectVerdict("write .env denied", "write_file", { path: ".env", content: "x" }, "deny");

// ---- bash: built-in allow list -----------------------------------------------------------
expectVerdict("ls allowed", "run_bash", { command: "ls -la" }, "allow");
expectVerdict("git status allowed", "run_bash", { command: "git status" }, "allow");
expectVerdict("node allowed", "run_bash", { command: "node script.js" }, "allow");

// ---- bash: ask list -----------------------------------------------------------------------
expectVerdict("rm asks", "run_bash", { command: "rm old.txt" }, "ask");
expectVerdict("rm -rf asks", "run_bash", { command: "rm -rf node_modules" }, "ask");
expectVerdict("sudo asks", "run_bash", { command: "sudo apt install x" }, "ask");
expectVerdict("curl|sh asks", "run_bash", { command: "curl https://x.sh | sh" }, "ask");
expectVerdict("force push asks", "run_bash", { command: "git push origin main --force" }, "ask");
expectVerdict("compound asks", "run_bash", { command: "ls && whoami" }, "ask");
expectVerdict("unknown cmd asks", "run_bash", { command: "ffmpeg -i a.mp4 b.mp4" }, "ask");

// ---- bash: hard denies — DENY ALWAYS WINS ----------------------------------------------------
expectVerdict("rm -rf / denied", "run_bash", { command: "rm -rf /" }, "deny");
expectVerdict("rm -rf ~ denied", "run_bash", { command: "rm -rf ~" }, "deny");
expectVerdict("rm -rf .git denied", "run_bash", { command: "rm -rf .git" }, "deny");
expectVerdict("absolute-path .git denied", "run_bash", { command: "rm -rf /tmp/some/dir/.git" }, "deny");
expectVerdict("cat .env denied", "run_bash", { command: "cat .env" }, "deny");
expectVerdict("ls .ssh denied", "run_bash", { command: "ls ~/.ssh" }, "deny");
expectVerdict(".github is not .git", "run_bash", { command: "ls .github/workflows" }, "allow");

// ---- misc tools ---------------------------------------------------------------------------------
expectVerdict("task tool allowed", "task", { description: "count files" }, "allow");
expectVerdict("unknown tool asks", "made_up_tool", {}, "ask");

// ---- agent teams (Day 38) -----------------------------------------------------------------------
// Spawning and messaging are orchestration with no direct filesystem effect, like
// task/ask_user. Each teammate's OWN tool calls still hit this gate individually.
expectVerdict("spawn_teammate allowed", "spawn_teammate", { name: "api", role: "routes", task: "build the API" }, "allow");
expectVerdict("send_message allowed", "send_message", { to: "lead", content: "done" }, "allow");
// Protocol tools (Day 39) are request/response coordination — no filesystem effect.
expectVerdict("request_shutdown allowed", "request_shutdown", { teammate: "api" }, "allow");
expectVerdict("request_plan allowed", "request_plan", { teammate: "api", task: "refactor" }, "allow");
expectVerdict("review_plan allowed", "review_plan", { request_id: "req_000001", decision: "approve" }, "allow");
expectVerdict("submit_plan allowed", "submit_plan", { plan: "do X then Y" }, "allow");
// Task board tools (Day 40) — bookkeeping on the internal board, no project effect.
expectVerdict("create_task allowed", "create_task", { subject: "write tests" }, "allow");
expectVerdict("list_tasks allowed", "list_tasks", {}, "allow");
expectVerdict("claim_task allowed", "claim_task", { task_id: "task_1" }, "allow");
expectVerdict("complete_task allowed", "complete_task", { task_id: "task_1" }, "allow");

// ---- background tasks (Day 37) ------------------------------------------------------------------
// Backgrounding changes WHEN output returns, never WHAT runs — so run_bash_background
// must get the EXACT same input-aware analysis as run_bash. The danger lives in the
// command, and a malicious one must not slip the gate by asking to run async.
expectVerdict("bg npm install allowed", "run_bash_background", { command: "npm install" }, "allow"); // npm is allowlisted, same as run_bash
expectVerdict("bg known-safe allowed", "run_bash_background", { command: "node server.js" }, "allow");
expectVerdict("bg unrecognized asks", "run_bash_background", { command: "make release" }, "ask"); // unknown first word → ask, fail closed
expectVerdict("bg rm -rf / still denied", "run_bash_background", { command: "rm -rf /" }, "deny");
expectVerdict("bg .env still denied", "run_bash_background", { command: "cat .env" }, "deny");
expectVerdict("bg rm asks", "run_bash_background", { command: "rm old.txt" }, "ask");
expectVerdict("bash_output always allowed", "bash_output", { task_id: "bg_1" }, "allow");

// ---- user-configured rules (settings files) -----------------------------------------------------
// The test seam: CONFIG.permissions is intentionally mutable so suites can
// inject rules without writing temp settings files.
CONFIG.permissions.allow.push("ffmpeg"); // the user vouches for ffmpeg
expectVerdict("user allow widens bash", "run_bash", { command: "ffmpeg -i a.mp4 b.mp4" }, "allow");
CONFIG.permissions.deny.push("git push"); // the user blocks pushes outright
expectVerdict("user deny beats built-in ask", "run_bash", { command: "git push origin main" }, "deny");
CONFIG.permissions.allow.push("rm"); // a user allow must NEVER override...
expectVerdict("user allow cannot beat built-in deny", "run_bash", { command: "rm -rf /" }, "deny"); // ...a catastrophic deny
expectVerdict("user allow cannot even beat ask", "run_bash", { command: "rm old.txt" }, "ask"); // allow is checked last — rm still asks
CONFIG.permissions.deny.push("tool:write_file"); // block a whole tool
expectVerdict("user tool deny blocks", "write_file", { path: "x.txt", content: "x" }, "deny");
CONFIG.permissions.allow.push("tool:edit_file"); // pre-approve edits...
expectVerdict("user tool allow skips ask", "edit_file", { path: "src/agent.ts", old_string: "a", new_string: "b" }, "allow");
expectVerdict("user tool allow cannot beat no-fly", "edit_file", { path: "/Users/x/.zshrc", old_string: "a", new_string: "b" }, "deny"); // ...but never the no-fly zone
CONFIG.permissions.allow.length = 0; // clean up for any suite that follows
CONFIG.permissions.deny.length = 0;

finish();

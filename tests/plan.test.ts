import { checkPermission, setPlanMode, isPlanMode } from "../src/permissions.js"; // unit under test
import { CONFIG } from "../src/config.js"; // to test that pre-approval cannot beat plan mode
import { dispatch } from "../src/tools.js"; // verify the exit_plan_mode tool flips the mode off
import { check, checkContains, finish } from "./helpers.js"; // assertions

// Shorthand: just the decision for a tool + args.
const decide = (tool: string, args: object = {}) => checkPermission(tool, JSON.stringify(args)).decision;

// ---- plan mode blocks every mutation, allows every observation -------------------------
setPlanMode(true);
check("plan mode reports on", isPlanMode());
check("read_file stays allowed", decide("read_file", { path: "x.txt" }) === "allow");
check("search stays allowed", decide("search", { pattern: "x" }) === "allow");
check("safe read-only shell stays allowed", decide("run_bash", { command: "ls -la" }) === "allow");
check("git status stays allowed", decide("run_bash", { command: "git status" }) === "allow");
check("write_file is blocked", decide("write_file", { path: "x.txt", content: "y" }) === "deny");
check("edit_file is blocked", decide("edit_file", { path: "x.txt" }) === "deny");
check("mutating shell is blocked", decide("run_bash", { command: "rm x.txt" }) === "deny");
check("unrecognized shell is blocked", decide("run_bash", { command: "frobnicate" }) === "deny");
check("external/MCP tool is blocked", decide("mcp__srv__write", { a: 1 }) === "deny");
checkContains("block message points the model at exit_plan_mode", checkPermission("write_file", JSON.stringify({ path: "x", content: "y" })).reason, "exit_plan_mode");

// ---- plan mode only TIGHTENS — it never loosens ----------------------------------------
CONFIG.permissions.allow.push("tool:write_file"); // user pre-approved writes...
check("pre-approval cannot beat plan mode", decide("write_file", { path: "x", content: "y" }) === "deny"); // ...still blocked
CONFIG.permissions.allow.pop();

const noFly = checkPermission("write_file", JSON.stringify({ path: ".git/config", content: "x" }));
check("a no-fly write stays deny in plan mode", noFly.decision === "deny");
checkContains("no-fly keeps its own specific reason, not the plan-mode one", noFly.reason, "no-fly");

// ---- exit_plan_mode is the way out: ask, showing the plan ------------------------------
const exitV = checkPermission("exit_plan_mode", JSON.stringify({ plan: "1. refactor the parser" }));
check("exit_plan_mode asks while in plan mode", exitV.decision === "ask");
checkContains("the approval prompt shows the plan", exitV.summary, "refactor the parser");

// ---- leaving plan mode restores normal rules -------------------------------------------
setPlanMode(false);
check("plan mode reports off", !isPlanMode());
check("write_file asks normally again", decide("write_file", { path: "x.txt", content: "y" }) === "ask");
check("exit_plan_mode is a no-op allow outside plan mode", decide("exit_plan_mode", { plan: "x" }) === "allow");

// ---- the tool's run() flips plan mode off (this is what user approval triggers) --------
setPlanMode(true);
const runResult = await dispatch("exit_plan_mode", JSON.stringify({ plan: "1. step one" }));
check("running exit_plan_mode turns plan mode off", !isPlanMode());
checkContains("it tells the model to start implementing", runResult, "implement");

finish();

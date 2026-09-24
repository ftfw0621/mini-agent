import path from "node:path"; // locate the mock server
import { connectMcpServers, reloadMcpServers } from "../src/mcp.js"; // the unit under test
import { CONFIG } from "../src/config.js"; // inject a server (the test seam)
import { tools, dispatch } from "../src/tools.js"; // verify registration + execution
import { checkPermission } from "../src/permissions.js"; // verify the gate treats MCP tools as "ask"
import { check, checkContains, finish } from "./helpers.js"; // assertions

// Point the config at the mock MCP server (a node script that speaks JSON-RPC).
const mockServer = path.resolve(import.meta.dirname, "fixtures/mock-mcp-server.mjs");
CONFIG.mcpServers = { calc: { command: process.execPath, args: [mockServer] } }; // process.execPath = this node binary

// Connecting discovers the server's tools and registers them.
const disconnect = await connectMcpServers();

// ---- discovery + registration -----------------------------------------------------
check("mcp tool is registered", "mcp__calc__add" in tools, Object.keys(tools).join(","));
const def = tools["mcp__calc__add"]?.definition;
check("registered with namespaced name", def?.function.name === "mcp__calc__add");
checkContains("description marks the origin", def?.function.description ?? "", "[MCP:calc]");
check("server's input schema is passed through", JSON.stringify(def?.function.parameters ?? {}).includes('"required":["a","b"]'));

// ---- the permission gate treats it as an external tool (ask) --------------------------
check("mcp tool asks by default", checkPermission("mcp__calc__add", "{}").decision === "ask");
CONFIG.permissions.deny.push("tool:mcp__calc__add"); // user blocks it...
check("user deny blocks the mcp tool", checkPermission("mcp__calc__add", "{}").decision === "deny");
CONFIG.permissions.deny.length = 0; // ...clean up
CONFIG.permissions.allow.push("tool:mcp__calc__add"); // user pre-approves it...
check("user allow pre-approves the mcp tool", checkPermission("mcp__calc__add", "{}").decision === "allow");
CONFIG.permissions.allow.length = 0; // ...clean up

// ---- end-to-end call through dispatch ------------------------------------------------
const result = await dispatch("mcp__calc__add", JSON.stringify({ a: 17, b: 25 }));
checkContains("mcp tool actually runs (17+25=42)", result, "42");

// ---- tools/list_changed: the server announces new tools, we re-fetch ----------------
const waitFor = async (cond: () => boolean) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); return cond(); };
check("no mul tool before the server grows", !("mcp__calc__mul" in tools));
checkContains("grow runs", await dispatch("mcp__calc__grow", "{}"), "grown");
check("list_changed notification registers the new tool", await waitFor(() => "mcp__calc__mul" in tools));
checkContains("the new tool works", await dispatch("mcp__calc__mul", JSON.stringify({ a: 6, b: 7 })), "42");
check("the old tools survive the swap", "mcp__calc__add" in tools);
checkContains("server→client ping is answered", await dispatch("mcp__calc__pong", "{}"), "true");

// ---- hot reload: diff the new mcpServers map against what is running --------------
const calc = { command: process.execPath, args: [mockServer] };
check("reload with an identical map changes nothing", (await reloadMcpServers({ calc: { args: [mockServer], command: process.execPath } })).length === 0); // key order ignored

let changes = await reloadMcpServers({ calc, calc2: calc }); // add a second server
checkContains("reload reports the added server", changes.join(","), "added calc2 (connected)");
check("added server's tools are registered", "mcp__calc2__add" in tools);

changes = await reloadMcpServers({ calc2: { ...calc, env: { X: "1" } } }); // drop calc, change calc2
checkContains("reload reports the removed server", changes.join(","), "removed calc");
checkContains("reload reconnects a changed server", changes.join(","), "reconnected calc2 (connected)");
check("removed server's tools are unregistered", !("mcp__calc__add" in tools));
checkContains("reconnected server still runs", await dispatch("mcp__calc2__add", JSON.stringify({ a: 1, b: 2 })), "3");

await reloadMcpServers({}); // remove everything
check("empty map unregisters every mcp tool", !Object.keys(tools).some((n) => n.startsWith("mcp__")));

disconnect(); // kill the server subprocess
CONFIG.mcpServers = {}; // reset for any suite that follows
finish();

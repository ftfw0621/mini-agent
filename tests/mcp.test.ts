import path from "node:path"; // locate the mock server
import { connectMcpServers } from "../src/mcp.js"; // the unit under test
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

disconnect(); // kill the server subprocess
CONFIG.mcpServers = {}; // reset for any suite that follows
finish();

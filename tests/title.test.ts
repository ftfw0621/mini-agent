import { cleanSessionTitle, terminalTitleSequence } from "../src/title.js"; // the pure half of session naming
import { check, finish } from "./helpers.js"; // assertions

// The model call itself is not under test (no network in the suite); what IS
// testable is the cleaning + rejection that turns a model reply into a title —
// or into "" when the model answered the prompt instead of naming it.

// ---- cleaning ------------------------------------------------------------------------
check("plain title passes through", cleanSessionTitle("Fix login button on mobile") === "Fix login button on mobile");
check("surrounding quotes stripped", cleanSessionTitle("\"Add OAuth authentication\"") === "Add OAuth authentication");
check("curly quotes + trailing period stripped", cleanSessionTitle("“Debug failing CI tests.”") === "Debug failing CI tests");
check("markdown fence stripped", cleanSessionTitle("```\nRefactor API client\n```") === "Refactor API client");
check("first non-empty line only", cleanSessionTitle("\nPrint ftfw string\n\nSome explanation follows.") === "Print ftfw string");
check("'Title:' label stripped", cleanSessionTitle("Title: Compare MCP implementations") === "Compare MCP implementations");
check("Chinese label + 。 stripped", cleanSessionTitle("标题：接入 Slack 和 Linear MCP。") === "接入 Slack 和 Linear MCP");
check("whitespace flattened", cleanSessionTitle("  Build   Slack\tserver ") === "Build Slack server");

// ---- rejection: the model answered instead of naming -----------------------------------
check("an answer's lead-in ending in a colon is rejected", cleanSessionTitle("有，常用的有这几款：") === "");
check("a trailing comma is rejected too", cleanSessionTitle("Sure, here are a few options,") === "");
check("a long sentence is rejected", cleanSessionTitle("Investigate and fix the issue where the login button does not respond on mobile devices at all") === "");
check("echoed wrapper is rejected", cleanSessionTitle("<prompt>fix the cart bug</prompt>") === "");
check("empty reply is empty", cleanSessionTitle("   \n  ") === "");

// ---- terminal tab title: OSC 0 framing, control bytes neutralised ------------------------
check("tab title is an OSC 0 sequence", terminalTitleSequence("✳ Fix login") === "\x1b]0;✳ Fix login\x07");
check("tab title strips control bytes (no escape injection)", terminalTitleSequence("a\x1b]0;evil\x07b\n") === "\x1b]0;a ]0;evil b\x07");

finish();

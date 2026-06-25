import React from "react";
import { render } from "ink";
import { buildInkSession } from "./setup.js"; // the front-end-agnostic session bootstrap
import { makeRunTurn } from "./chat.js"; // drives one turn through the real loop
import { App } from "./app.js"; // the Ink REPL

// Entry for the Ink REPL. Run with: npm run ink
// buildInkSession does the same wiring agent.ts does (MCP, skills, judge, memory,
// cost, hooks, telemetry, optional resume); App renders it and runs the loop.
const session = await buildInkSession({ resume: process.argv.includes("-r") || process.argv.includes("--resume") });
render(<App session={session} runTurn={makeRunTurn(session.client, session.messages)} />);

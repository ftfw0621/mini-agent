import React from "react";
import { render } from "ink";
import { buildInkSession } from "./setup.js"; // the front-end-agnostic session bootstrap
import { makeRunTurn } from "./chat.js"; // drives one turn through the real loop
import { App } from "./app.js"; // the Ink REPL

// Launch the Ink REPL and resolve when it exits. buildInkSession does the same
// wiring agent.ts does (MCP, skills, judge, memory, cost, hooks, telemetry,
// optional resume); App renders it and runs the loop. Exported so BOTH the
// `npm run ink` entry (main.tsx) and agent.ts (the default `mini-agent` entry,
// once it hands interactive sessions to Ink) can start it.
export async function launchInk(opts: { resume?: boolean } = {}): Promise<void> {
  const session = await buildInkSession({ resume: opts.resume });
  const { waitUntilExit } = render(<App session={session} runTurn={makeRunTurn(session.client, session.messages)} />);
  await waitUntilExit(); // keep the process alive until the user quits
}

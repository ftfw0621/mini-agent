import React from "react";
import { render } from "ink";
import OpenAI from "openai";
import path from "node:path";
import { CONFIG, requireApiKey } from "../config.js"; // provider-agnostic settings (.env loaded there)
import { buildSystemMessage } from "../prompt.js"; // the constitution + optional AGENT.md
import { estimateHistoryTokens } from "../context.js"; // for the ctx% in the status bar
import { initCostMeter, DEFAULT_PRICING } from "../cost.js"; // token & cost accounting (live $ in the status bar)
import { gitBranch } from "../tui.js"; // the 🌿 branch for the status bar
import { App } from "./app.js"; // the Ink REPL
import { makeRunTurn } from "./chat.js"; // the minimal streaming turn (no tools yet)

// Entry for the Ink REPL experiment. Run with: npm run ink
requireApiKey();
const client = new OpenAI({ baseURL: CONFIG.baseURL, apiKey: CONFIG.apiKey, maxRetries: 0 });
const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: buildSystemMessage() }];

const costMeter = initCostMeter(DEFAULT_PRICING); // the same meter the non-Ink REPL uses; chat.ts records stream usage into it
const dir = path.basename(process.cwd());
const branch = gitBranch();
const startedAt = Date.now();

// Recomputed live each render: ctx% grows with the history, cost accrues from the
// stream, the clock keeps ticking.
const getStatus = () => ({
  ctxPct: Math.min(100, Math.round((estimateHistoryTokens(messages) / CONFIG.contextWindow) * 100)),
  cost: costMeter.cost(),
  elapsedMs: Date.now() - startedAt,
});

render(<App model={CONFIG.model} dir={dir} branch={branch} getStatus={getStatus} runTurn={makeRunTurn(client, messages)} />);

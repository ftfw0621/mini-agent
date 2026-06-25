import React from "react";
import { render } from "ink";
import OpenAI from "openai";
import { CONFIG, requireApiKey } from "../config.js"; // provider-agnostic settings (.env loaded there)
import { buildSystemMessage } from "../prompt.js"; // the constitution + optional AGENT.md
import { App } from "./app.js"; // the Ink REPL (increment 1)
import { makeRunTurn } from "./chat.js"; // the minimal streaming turn (no tools yet)

// Entry for the Ink REPL experiment. Run with: npm run ink
requireApiKey();
const client = new OpenAI({ baseURL: CONFIG.baseURL, apiKey: CONFIG.apiKey, maxRetries: 0 });
const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: buildSystemMessage() }];
render(<App model={CONFIG.model} runTurn={makeRunTurn(client, CONFIG.model, messages)} />);

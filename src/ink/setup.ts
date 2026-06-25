import OpenAI from "openai";
import path from "node:path";
import { createRequire } from "node:module";
import { CONFIG, requireApiKey } from "../config.js";
import { buildSystemMessage } from "../prompt.js";
import { estimateHistoryTokens } from "../context.js";
import { initCostMeter, DEFAULT_PRICING, type CostMeter } from "../cost.js";
import { gitBranch } from "../tui.js";
import { newSessionId, latestSession } from "../session.js";
import { initTelemetry, emit } from "../telemetry.js";
import { runHooks } from "../hooks.js";
import { connectMcpServers } from "../mcp.js";
import { Judge } from "../judge.js";
import { registerExternalTool } from "../tools.js";
import { rememberTool, readMemory } from "../memory.js";
import { loadSkills, buildSkillTool, type Skill } from "../skills.js";
import { killAllBackground } from "../background.js";
import { banner } from "../ui.js";
import type { StatusData } from "./app.js";

// The Ink REPL's session bootstrap — the same wiring agent.ts (the readline REPL)
// does before the prompt loop, but front-end-agnostic: it touches none of
// readline/editLine, just the shared modules (MCP, skills, judge, memory, cost,
// hooks, telemetry, session). It returns everything the Ink App needs to run a
// real session, so main.tsx stays a thin render() call. (agent.ts is left
// untouched so `npm start` keeps working until 2d flips the default.)

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

export interface InkSession {
  client: OpenAI;
  messages: OpenAI.ChatCompletionMessageParam[]; // the whole conversation — mutated IN PLACE (so /clear etc. keep the same ref)
  systemMessage: string; // rebuilt fresh each session (AGENT.md may have changed); the constant prefix of `messages`
  initialSessionId: string;
  startedAt: number;
  costMeter: CostMeter;
  skills: Skill[];
  judge?: Judge;
  model: string;
  dir: string;
  branch: string | null;
  bannerText: string; // the welcome box
  notices: string[]; // dim startup lines (resume / memory / skills / judge) shown under the banner
  getStatus: () => StatusData; // live ctx% / cost / elapsed for the status bar
  disconnectMcp: () => void; // best-effort cleanup of MCP server subprocesses
}

// Build the session. `resume` mirrors `-r/--resume`: fold the most recent
// conversation in this directory into the fresh constitution.
export async function buildInkSession(opts: { resume?: boolean } = {}): Promise<InkSession> {
  requireApiKey();
  const client = new OpenAI({ baseURL: CONFIG.baseURL, apiKey: CONFIG.apiKey, maxRetries: 0 });

  const systemMessage = buildSystemMessage(); // stable prefix = cache hits every request
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: systemMessage }];

  const notices: string[] = [];
  let sessionId = newSessionId();
  const startedAt = Date.now();

  if (opts.resume) {
    const prev = latestSession();
    if (prev) {
      messages.push(...prev.messages);
      sessionId = prev.id; // keep appending to the same file
      notices.push(`(resumed session ${prev.id} — ${prev.messages.length} messages; files must be re-read before editing)`);
    } else {
      notices.push("(no previous session here — starting fresh)");
    }
  }

  initTelemetry(sessionId);
  emit("agent_session_start", { mode: "repl" });

  // MCP servers — must finish before the first model call so their tools appear
  // in the manual. A server that fails to start is skipped, never fatal.
  const disconnectMcp = await connectMcpServers();
  process.on("exit", disconnectMcp);
  process.on("exit", killAllBackground); // SIGKILL any background job so it never outlives the agent

  const judge = CONFIG.judge.enabled ? new Judge(client, CONFIG.judge.model || CONFIG.model) : undefined;
  if (judge) notices.push(`(permission judge on — model ${CONFIG.judge.model || CONFIG.model})`);

  // The remember tool flows through the same permission gate as any tool.
  registerExternalTool(rememberTool);
  const memCount = readMemory().length;
  if (memCount) notices.push(`(long-term memory: ${memCount} facts loaded)`);

  // Skills: model-invocable ones get the single `skill` tool; user-only ones are
  // reachable via /skill <name>.
  const skills: Skill[] = loadSkills();
  if (skills.some((s) => !s.disableModelInvocation)) registerExternalTool(buildSkillTool(skills));
  if (skills.length) notices.push(`(skills: ${skills.length} loaded — ${skills.map((s) => s.name).join(", ")})`);

  const costMeter = initCostMeter({
    inputPerM: CONFIG.pricing.inputPerM ?? DEFAULT_PRICING.inputPerM,
    cachedInputPerM: CONFIG.pricing.cachedInputPerM ?? DEFAULT_PRICING.cachedInputPerM,
    outputPerM: CONFIG.pricing.outputPerM ?? DEFAULT_PRICING.outputPerM,
  });

  // SessionStart hooks run once; their stdout becomes context on the first turn.
  const sessionStart = await runHooks("SessionStart", {});
  if (sessionStart.stdout) messages.push({ role: "user", content: `[SessionStart hook]\n${sessionStart.stdout}` });

  const dir = path.basename(process.cwd());
  const branch = gitBranch();

  const getStatus = (): StatusData => ({
    ctxPct: Math.min(100, Math.round((estimateHistoryTokens(messages) / CONFIG.contextWindow) * 100)),
    cost: costMeter.cost(),
    elapsedMs: Date.now() - startedAt,
  });

  return {
    client,
    messages,
    systemMessage,
    initialSessionId: sessionId,
    startedAt,
    costMeter,
    skills,
    judge,
    model: CONFIG.model,
    dir,
    branch,
    bannerText: banner(pkg.version, CONFIG.model, new URL(CONFIG.baseURL).host),
    notices,
    getStatus,
    disconnectMcp,
  };
}

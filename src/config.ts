import fs from "node:fs"; // reading .env and settings files
import os from "node:os"; // home directory for the global settings path
import path from "node:path"; // path joining
import chalk from "chalk"; // colored error output

// Minimal .env loader: lets `npx mini-agent` work in any directory that has a
// .env file — no dotenv dependency, no --env-file flag to remember.
try {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/); // KEY=value, nothing fancier
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; // real env vars always win over the file
  }
} catch {
  /* no .env here — the variables may come from the shell instead */
}

// ---- Settings files ------------------------------------------------------------
// Two layers, both optional:
//   global:  ~/.config/mini-agent/settings.json   (your defaults, every project)
//   project: ./.mini-agent/settings.json          (this repo's rules, commit it if you like)
// Scalars (model, baseURL, contextWindow): project wins over global.
// Permission lists: BOTH layers apply — a deny from either layer is a deny.
// API keys never live in settings files — secrets stay in the environment.
export const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), ".config", "mini-agent", "settings.json");
export const PROJECT_SETTINGS_PATH = path.resolve(".mini-agent", "settings.json");

// One hook definition: a shell command, optionally filtered to one tool.
export interface HookDef {
  match?: string; // tool name to match (e.g. "run_bash"); omit = every tool
  command: string; // shell command; receives event JSON on stdin
  timeoutMs?: number; // kill the hook after this long (default 10s)
}

// One MCP server: a process we spawn and speak JSON-RPC to over stdio. Its tools
// are discovered at startup and exposed to the model as mcp__<server>__<tool>.
export interface McpServerDef {
  // A server is reached EITHER by spawning a subprocess (stdio) OR over HTTP.
  command?: string; // stdio: executable, e.g. "npx"
  args?: string[]; // stdio: arguments, e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  env?: Record<string, string>; // stdio: extra environment variables for the server
  url?: string; // http: the server endpoint, e.g. "https://example.com/mcp" — when set, HTTP transport is used
  headers?: Record<string, string>; // http: extra request headers (e.g. an Authorization bearer token)
}

// What a settings file may contain. Unknown keys are ignored.
interface SettingsFile {
  model?: string; // which model to call
  subAgentModel?: string; // model for delegated sub-agents (task tool); defaults to the main model
  baseURL?: string; // which OpenAI-compatible endpoint
  contextWindow?: number; // the model's context size in tokens
  permissions?: {
    allow?: string[]; // bash first-words (e.g. "cargo") or "tool:<name>" to skip asking
    deny?: string[]; // substrings of bash commands (e.g. "git push") or "tool:<name>" to hard-block
  };
  hooks?: {
    PreToolUse?: HookDef[]; // before a tool runs — exit 2 blocks it
    PostToolUse?: HookDef[]; // after a tool ran — observational only
    SessionStart?: HookDef[]; // when a session begins — stdout goes to the model
    Stop?: HookDef[]; // when the agent wants to finish — exit 2 sends it back to work
  };
  mcpServers?: Record<string, McpServerDef>; // external tool servers, keyed by name
  judge?: {
    enabled?: boolean; // run an LLM classifier on "ask" verdicts to auto-allow the clearly safe
    model?: string; // judge model (defaults to the main model); a cheaper one is ideal
  };
  pricing?: {
    inputPerM?: number; // $ per 1M uncached input tokens
    cachedInputPerM?: number; // $ per 1M cached input tokens
    outputPerM?: number; // $ per 1M output tokens
  };
}

// Read one settings file. A broken settings file is a HARD error, not a warning:
// silently ignoring it would silently drop the user's deny rules — fail closed.
function readSettings(p: string): SettingsFile {
  if (!fs.existsSync(p)) return {}; // absent is fine
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as SettingsFile; // parse or throw
  } catch (err) {
    console.error(chalk.red(`Could not parse settings file: ${p}`));
    console.error(chalk.dim(`  ${(err as Error).message}`));
    console.error("Fix or delete the file, then run again. (Ignoring it could drop your deny rules.)");
    process.exit(1); // fail closed — never run with half-loaded security config
  }
}

const globalSettings = readSettings(GLOBAL_SETTINGS_PATH); // the user's defaults
const projectSettings = readSettings(PROJECT_SETTINGS_PATH); // this project's rules

// User permission rules, both layers concatenated (deny from either layer wins).
export interface PermissionRules {
  allow: string[]; // widens what runs without asking — can NEVER override a deny
  deny: string[]; // hard blocks — nothing overrides these
}

// Provider-agnostic configuration. Resolution order, most specific wins:
//   env MINI_AGENT_*  >  project settings  >  global settings  >  legacy DEEPSEEK_* env  >  defaults
export const CONFIG = {
  baseURL:
    process.env.MINI_AGENT_BASE_URL || // explicit env wins...
    projectSettings.baseURL || // ...then the project file...
    globalSettings.baseURL || // ...then the user's global file...
    process.env.DEEPSEEK_BASE_URL || // ...then the legacy override (kept for back-compat and tests)
    "https://api.deepseek.com", // ...and finally the default provider
  apiKey:
    process.env.MINI_AGENT_API_KEY || // generic key wins...
    process.env.DEEPSEEK_API_KEY || // ...over the back-compat one
    "", // empty = missing; requireApiKey() turns that into a helpful error
  model: process.env.MINI_AGENT_MODEL || projectSettings.model || globalSettings.model || "deepseek-chat", // must support function calling
  // Sub-agents (the task tool) can run on a DIFFERENT model than the orchestrator:
  // a cheap/fast one for grunt work (reading many files, broad search), or a
  // strong one as an "advisor" to double-check. undefined → use the main model.
  subAgentModel:
    process.env.MINI_AGENT_SUBAGENT_MODEL || projectSettings.subAgentModel || globalSettings.subAgentModel || undefined,
  contextWindow:
    Number(process.env.MINI_AGENT_CONTEXT_WINDOW) || // env override first
    projectSettings.contextWindow || // then files
    globalSettings.contextWindow ||
    1_048_565, // DeepSeek's real window, learned from an actual API error
  permissions: {
    // Both layers apply: global rules + project rules. Mutable on purpose —
    // the test suite injects rules here instead of writing temp files.
    allow: [...(globalSettings.permissions?.allow ?? []), ...(projectSettings.permissions?.allow ?? [])],
    deny: [...(globalSettings.permissions?.deny ?? []), ...(projectSettings.permissions?.deny ?? [])],
  } as PermissionRules,
  hooks: {
    // Hook lists also concatenate: global hooks run first, then project hooks.
    PreToolUse: [...(globalSettings.hooks?.PreToolUse ?? []), ...(projectSettings.hooks?.PreToolUse ?? [])],
    PostToolUse: [...(globalSettings.hooks?.PostToolUse ?? []), ...(projectSettings.hooks?.PostToolUse ?? [])],
    SessionStart: [...(globalSettings.hooks?.SessionStart ?? []), ...(projectSettings.hooks?.SessionStart ?? [])],
    Stop: [...(globalSettings.hooks?.Stop ?? []), ...(projectSettings.hooks?.Stop ?? [])],
  },
  // MCP servers: project entries override global ones with the same name.
  mcpServers: { ...(globalSettings.mcpServers ?? {}), ...(projectSettings.mcpServers ?? {}) } as Record<string, McpServerDef>,
  // LLM permission judge: off unless a settings file turns it on. Project wins.
  judge: {
    enabled: projectSettings.judge?.enabled ?? globalSettings.judge?.enabled ?? false,
    model: projectSettings.judge?.model || globalSettings.judge?.model || undefined, // undefined → use the main model
  },
  // Token prices for the /cost estimate (defaults applied in cost.ts). Project
  // overrides global; either may set just the fields it cares about.
  pricing: { ...(globalSettings.pricing ?? {}), ...(projectSettings.pricing ?? {}) } as {
    inputPerM?: number;
    cachedInputPerM?: number;
    outputPerM?: number;
  },
};

// No key, no point: fail with instructions instead of a stack trace later.
export function requireApiKey(): void {
  if (CONFIG.apiKey) return; // all good
  console.error(chalk.red("Missing API key."));
  console.error("mini-agent works with any OpenAI-compatible provider. Either:");
  console.error("  echo 'DEEPSEEK_API_KEY=sk-...' > .env              (DeepSeek, the default)");
  console.error("  or set MINI_AGENT_API_KEY / MINI_AGENT_BASE_URL / MINI_AGENT_MODEL");
  console.error("     to use OpenAI, Kimi, Qwen, GLM, OpenRouter, Ollama... (see .env.example)");
  process.exit(1);
}

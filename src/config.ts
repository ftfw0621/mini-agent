import fs from "node:fs"; // reading .env and settings files
import os from "node:os"; // home directory for the global settings path
import path from "node:path"; // path joining
import chalk from "chalk"; // colored error output
import type { EffortProfile } from "./effort.js";

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

// OAuth client settings for an HTTP MCP server. Most servers (Linear, GitHub…)
// support Dynamic Client Registration, so nothing needs to be configured: the
// agent registers itself on first /mcp auth. Some (Slack) do NOT offer DCR and
// instead publish a pre-registered public client id + a fixed callback port —
// the same shape Claude Code's plugin config uses, so an entry can be copied over.
export interface McpOAuthDef {
  clientId?: string; // pre-registered client id — when set, dynamic client registration is skipped
  clientSecret?: string; // its secret, if the server issued one (MCP clients are usually public: no secret)
  callbackPort?: number; // fixed loopback port for the redirect URI http://localhost:<port>/callback (the registered redirect must match)
  scopes?: string[]; // explicit scopes to request; default: what the server's resource metadata advertises
}

// One MCP server: a process we spawn and speak JSON-RPC to over stdio, or a URL
// we POST to. Its tools are discovered at startup and exposed to the model as
// mcp__<server>__<tool>.
export interface McpServerDef {
  // A server is reached EITHER by spawning a subprocess (stdio) OR over HTTP.
  // The transport is chosen from the fields present (url → http, else stdio).
  type?: "stdio" | "http"; // accepted so an entry copied from Claude Code's config parses as-is; informational only
  command?: string; // stdio: executable, e.g. "npx"
  args?: string[]; // stdio: arguments, e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  env?: Record<string, string>; // stdio: extra environment variables for the server
  url?: string; // http: the server endpoint, e.g. "https://example.com/mcp" — when set, HTTP transport is used
  headers?: Record<string, string>; // http: extra request headers (e.g. a static Authorization bearer token)
  oauth?: McpOAuthDef; // http: OAuth client settings for servers without dynamic client registration
}

// What a settings file may contain. Unknown keys are ignored.
interface SettingsFile {
  effortProfiles?: Record<string, EffortProfile>;
  model?: string; // which model to call
  subAgentModel?: string; // model for delegated sub-agents (task tool); defaults to the main model
  baseURL?: string; // which OpenAI-compatible endpoint
  contextWindow?: number; // the model's context size in tokens
  skillOverrides?: Record<string, "off" | "user-only">; // /skills toggles: a skill turned off, or hidden from the model (absent = on)
  contextWindows?: Record<string, number>; // per-model windows, e.g. { "deepseek-chat": 128000 } — /model switches follow them
  permissions?: {
    allow?: string[]; // bash first-words (e.g. "cargo") or "tool:<name>" to skip asking
    deny?: string[]; // substrings of bash commands (e.g. "git push") or "tool:<name>" to hard-block
  };
  // Hooks keyed by lifecycle event (PreToolUse, PostToolUse, SessionStart, Stop,
  // UserPromptSubmit, SessionEnd, PreCompact, PostCompact, SubagentStart,
  // SubagentStop, …). A plain record so new events need no schema change.
  hooks?: Record<string, HookDef[]>;
  mcpServers?: Record<string, McpServerDef>; // external tool servers, keyed by name
  judge?: {
    enabled?: boolean; // run an LLM classifier on "ask" verdicts to auto-allow the clearly safe
    model?: string; // judge model (defaults to the main model); a cheaper one is ideal
  };
  autoMode?: {
    policy?: "scores" | "rules"; // rules is opt-in until held-out live evaluation
    enabled?: boolean; // opt-in tool review: Jev with a key, current vendor otherwise
    model?: string; // Jev model only; the vendor fallback uses judge.model or model
  };
  pricing?: {
    inputPerM?: number; // $ per 1M uncached input tokens
    cachedInputPerM?: number; // $ per 1M cached input tokens
    outputPerM?: number; // $ per 1M output tokens
  };
  memory?: {
    autoExtract?: boolean; // after each turn, a cheap call extracts durable memories (off by default — it costs an extra call)
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

// Re-read ONLY the mcpServers map from both layers, mid-session (the MCP hot
// reload in mcp.ts). Unlike startup, a file that won't parse is NOT fatal here:
// an editor saving in two steps can leave half-written JSON for a moment, and
// killing a live session over that would be absurd. Return null instead — the
// caller keeps the servers it already has and waits for the next save.
export function readMcpServers(): Record<string, McpServerDef> | null {
  const layers: SettingsFile[] = [];
  for (const p of [GLOBAL_SETTINGS_PATH, PROJECT_SETTINGS_PATH]) {
    if (!fs.existsSync(p)) {
      layers.push({});
      continue;
    }
    try {
      layers.push(JSON.parse(fs.readFileSync(p, "utf8")) as SettingsFile);
    } catch {
      return null; // unparseable right now — don't guess, keep what is running
    }
  }
  return { ...(layers[0].mcpServers ?? {}), ...(layers[1].mcpServers ?? {}) }; // same merge as startup: project wins
}

// Which settings file defines this MCP server (the /mcp panel's "Config
// location"). Project entries override global ones, so check the project first.
export function mcpConfigPath(name: string): string {
  try {
    if ((JSON.parse(fs.readFileSync(PROJECT_SETTINGS_PATH, "utf8")) as SettingsFile).mcpServers?.[name]) return PROJECT_SETTINGS_PATH;
  } catch {
    /* no project settings (or unreadable) — it's global */
  }
  return GLOBAL_SETTINGS_PATH;
}

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
  model: process.env.MINI_AGENT_MODEL || projectSettings.model || globalSettings.model || "deepseek-flash", // must support function calling
  effortProfiles: { ...(globalSettings.effortProfiles ?? {}), ...(projectSettings.effortProfiles ?? {}) } as Record<string, EffortProfile>,
  // Sub-agents (the task tool) can run on a DIFFERENT model than the orchestrator:
  // a cheap/fast one for grunt work (reading many files, broad search), or a
  // strong one as an "advisor" to double-check. undefined → use the main model.
  subAgentModel:
    process.env.MINI_AGENT_SUBAGENT_MODEL || projectSettings.subAgentModel || globalSettings.subAgentModel || undefined,
  // /skills on/off/user-only choices. Project entries override global ones.
  skillOverrides: { ...(globalSettings.skillOverrides ?? {}), ...(projectSettings.skillOverrides ?? {}) } as Record<string, "off" | "user-only">,
  // Per-model windows (context.ts contextWindowFor): project entries override global ones.
  contextWindows: { ...(globalSettings.contextWindows ?? {}), ...(projectSettings.contextWindows ?? {}) } as Record<string, number>,
  contextWindow:
    Number(process.env.MINI_AGENT_CONTEXT_WINDOW) || // env override first
    projectSettings.contextWindow || // then files
    globalSettings.contextWindow ||
    1_048_565, // DeepSeek's real window, learned from an actual API error
  // Explicit CLI opt-in only: never enable unattended bypass from saved settings.
  bypassPermissions: false,
  permissions: {
    // Both layers apply: global rules + project rules. Mutable on purpose —
    // the test suite injects rules here instead of writing temp files.
    allow: [...(globalSettings.permissions?.allow ?? []), ...(projectSettings.permissions?.allow ?? [])],
    deny: [...(globalSettings.permissions?.deny ?? []), ...(projectSettings.permissions?.deny ?? [])],
  } as PermissionRules,
  // Hooks for every event, merged across layers (global first, then project) by
  // a generic union so adding a new event needs no edit here.
  hooks: ((): Record<string, HookDef[]> => {
    const merged: Record<string, HookDef[]> = {};
    for (const src of [globalSettings.hooks, projectSettings.hooks]) {
      for (const [event, defs] of Object.entries(src ?? {})) merged[event] = [...(merged[event] ?? []), ...(defs ?? [])];
    }
    return merged;
  })(),
  // MCP servers: project entries override global ones with the same name.
  mcpServers: { ...(globalSettings.mcpServers ?? {}), ...(projectSettings.mcpServers ?? {}) } as Record<string, McpServerDef>,
  // LLM permission judge: off unless a settings file turns it on. Project wins.
  judge: {
    enabled: projectSettings.judge?.enabled ?? globalSettings.judge?.enabled ?? false,
    model: projectSettings.judge?.model || globalSettings.judge?.model || undefined, // undefined → use the main model
  },
  autoMode: {
    policy: (process.env.MINI_AGENT_AUTO_POLICY ?? projectSettings.autoMode?.policy ?? globalSettings.autoMode?.policy ?? "scores") === "rules" ? "rules" as const : "scores" as const,
    enabled: process.env.MINI_AGENT_AUTO_MODE !== undefined ? process.env.MINI_AGENT_AUTO_MODE === "1" : (projectSettings.autoMode?.enabled ?? globalSettings.autoMode?.enabled ?? false),
    model: projectSettings.autoMode?.model || globalSettings.autoMode?.model || "jev-1.13.0",
  },
  // Token prices for the /cost estimate (defaults applied in cost.ts). Project
  // overrides global; either may set just the fields it cares about.
  pricing: { ...(globalSettings.pricing ?? {}), ...(projectSettings.pricing ?? {}) } as {
    inputPerM?: number;
    cachedInputPerM?: number;
    outputPerM?: number;
  },
  // Long-term memory: auto-extract durable facts after each turn. Off by default
  // — it costs an extra (cheap) model call per turn. Project overrides global.
  memory: {
    autoExtract: projectSettings.memory?.autoExtract ?? globalSettings.memory?.autoExtract ?? false,
  },
};

// Persist a single key to the global settings file, preserving all other keys.
// Used by /model to remember the user's last choice across sessions.
export function saveGlobalSetting(key: string, value: unknown): void {
  const dir = path.dirname(GLOBAL_SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const current = fs.existsSync(GLOBAL_SETTINGS_PATH)
    ? JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, "utf8"))
    : {};
  current[key] = value;
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(current, null, 2) + "\n");
}

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

import fs from "node:fs"; // for the minimal .env loader
import chalk from "chalk"; // colored error output

// Minimal .env loader: lets `npx mini-agent` work in any directory that has a
// .env file — no dotenv dependency, no --env-file flag to remember.
// Lives here (not in agent.ts) so the eval harness gets it for free too.
try {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/); // KEY=value, nothing fancier
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; // real env vars always win over the file
  }
} catch {
  /* no .env here — the variables may come from the shell instead */
}

// Provider-agnostic configuration. mini-agent talks the OpenAI wire protocol,
// so ANY compatible endpoint works — DeepSeek, OpenAI, Kimi, Qwen, GLM,
// OpenRouter, a local Ollama... three variables and you're on a new model.
//
// Resolution order, most specific wins:
//   MINI_AGENT_* (generic)  >  DEEPSEEK_* (back-compat)  >  DeepSeek defaults
export const CONFIG = {
  baseURL:
    process.env.MINI_AGENT_BASE_URL || // bring your own provider...
    process.env.DEEPSEEK_BASE_URL || // ...or the original DeepSeek override (kept for back-compat and tests)
    "https://api.deepseek.com", // the default provider
  apiKey:
    process.env.MINI_AGENT_API_KEY || // generic key wins...
    process.env.DEEPSEEK_API_KEY || // ...over the back-compat one
    "", // empty = missing; requireApiKey() turns that into a helpful error
  model: process.env.MINI_AGENT_MODEL || "deepseek-chat", // must support function calling
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

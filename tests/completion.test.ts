import { slashCompletions, COMMANDS, type CompletionContext } from "../src/completion.js";
import { SESSION_HELP } from "../src/ink/commands.js";
import { CONFIG } from "../src/config.js";
import { check, finish } from "./helpers.js";

const ctx: CompletionContext = { model: "deepseek-flash", skills: [{ name: "review", description: "Review code", whenToUse: "" }], models: ["deepseek-flash", "deepseek-v4-pro"], servers: ["docs"] };
const previous = CONFIG.baseURL;
CONFIG.baseURL = "https://api.deepseek.com";
try {
  const values = (input: string) => slashCompletions(input, ctx)?.items.map((item) => item.value) ?? [];
  check("plain messages do not open command suggestions", slashCompletions("ask /effort", ctx) === null);
  check("pasted multiline text is not interpreted as a command", slashCompletions("/help\nthen do something", ctx) === null);
  check("slash includes every documented top-level command", [...SESSION_HELP.matchAll(/^  (\/\w+)/gm)].every((m) => values("/").includes(m[1])));
  check("catalog has unique commands", new Set(COMMANDS.map((c) => c.value)).size === COMMANDS.length);
  check("partial names filter commands", JSON.stringify(values("/ef")) === JSON.stringify(["/effort"]));
  check("effort exposes only supported model choices", JSON.stringify(values("/effort")) === JSON.stringify(["default", "none", "low", "high", "max"].map((v) => `/effort ${v}`)));
  check("argument prefixes filter choices", JSON.stringify(values("/effort h")) === JSON.stringify(["/effort high"]));
  check("skills plural completes to runnable singular command", JSON.stringify(values("/skills re")) === JSON.stringify(["/skill review"]));
  check("missing skills are explained", slashCompletions("/skills", { ...ctx, skills: [] })?.hint?.includes("No skills") === true);
  check("model choices deduplicate the current model", values("/model").filter((v) => v === "/model deepseek-flash").length === 1);
  check("save model subcommand exposes endpoint models", values("/model save").includes("/model save deepseek-v4-pro"));
  check("auto debug arguments are selectable", values("/auto debug o").length === 2);
  check("MCP subcommands use actual server names", values("/mcp auth")[0] === "/mcp auth docs");
  check("unknown commands have no fabricated choices", values("/unknown").length === 0);
} finally { CONFIG.baseURL = previous; }
finish();

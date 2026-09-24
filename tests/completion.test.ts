import { slashCompletions, skillTokenRanges, COMMANDS, type CompletionContext } from "../src/completion.js";
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
  check("missing skills are explained", slashCompletions("/skills ", { ...ctx, skills: [] })?.hint?.includes("No skills") === true);
  check("model choices deduplicate the current model", values("/model").filter((v) => v === "/model deepseek-flash").length === 1);
  check("save model subcommand exposes endpoint models", values("/model save").includes("/model save deepseek-v4-pro"));
  check("auto debug arguments are selectable", values("/auto debug o").length === 2);
  check("MCP subcommands use actual server names", values("/mcp auth")[0] === "/mcp auth docs");
  check("status lists local and official account choices", values("/status").includes("/status local") && values("/status").includes("/status anthropic"));
  check("unknown commands have no fabricated choices", values("/unknown").length === 0);

  // ---- skills in the "/" typeahead -------------------------------------------------------
  const sk: CompletionContext = { ...ctx, skills: [{ name: "grill-me", description: "Interview me about a plan", whenToUse: "" }, { name: "pr-loop", description: "PR loop", whenToUse: "" }, { name: "help", description: "clashes with /help", whenToUse: "" }] };
  const sv = (input: string) => slashCompletions(input, sk)?.items.map((item) => item.value) ?? [];
  check("bare slash lists skills first, then commands", sv("/")[0] === "/grill-me" && sv("/")[1] === "/pr-loop" && sv("/").includes("/model"));
  check("typing filters skills by prefix", JSON.stringify(sv("/gri")) === JSON.stringify(["/grill-me"]));
  check("substring matches follow prefix matches", sv("/loop").includes("/pr-loop"));
  check("a built-in command wins a name clash", sv("/help").filter((v) => v === "/help").length === 1);
  check("a skill item shows its description", slashCompletions("/gri", sk)?.items[0].description === "Interview me about a plan");
  check("choosing a skill fills it for arguments instead of sending", slashCompletions("/gri", sk)?.items[0].children === true);
  check("typing arguments after a skill closes the list", slashCompletions("/grill-me the plan", sk) === null);
  check("the list only opens at the very start", slashCompletions("please /gri", sk) === null);

  // ---- which /skill tokens get highlighted --------------------------------------------------
  const r = (text: string) => JSON.stringify(skillTokenRanges(text, sk.skills));
  check("a skill at the start is highlighted", r("/grill-me") === "[[0,9]]");
  check("a skill anywhere in the text is highlighted", r("hi /grill-me now") === "[[3,12]]");
  check("several skills, each highlighted", r("/pr-loop then /grill-me") === "[[0,8],[14,23]]");
  check("a partial name is not highlighted", r("/grill") === "[]");
  check("a longer word is not highlighted", r("/grill-mean") === "[]");
  check("a path-like token is not highlighted", r("a/grill-me") === "[]");
  check("case-insensitive, like running it", r("/Grill-Me") === "[[0,9]]");
} finally { CONFIG.baseURL = previous; }
finish();

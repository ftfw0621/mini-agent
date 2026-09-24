import { slashCompletions, commandTokenRanges, commandNames, inlineCommandGhost, COMMANDS, type CompletionContext } from "../src/completion.js";
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

  // ---- skills in the "/" typeahead (Claude Code's generateCommandSuggestions) ------------------
  const sk: CompletionContext = {
    ...ctx,
    skills: [
      { name: "grill-me", description: "Interview me about a plan", whenToUse: "", source: "user" },
      { name: "pr-loop", description: "Drive a pull request to merge", whenToUse: "", source: "user", argNames: ["pr"] },
      { name: "zeta", description: "Project helper", whenToUse: "", source: "project" },
      { name: "help", description: "clashes with /help", whenToUse: "" },
    ],
    usage: (name) => (name === "zeta" ? 5 : name === "grill-me" ? 1 : 0),
  };
  const sv = (input: string) => slashCompletions(input, sk)?.items.map((item) => item.value) ?? [];
  const bare = sv("/");
  check("bare slash: most-used skills first, by score", bare[0] === "/zeta" && bare[1] === "/grill-me");
  check("then built-ins, alphabetical", bare[2] === "/auto" && bare.indexOf("/model") < bare.indexOf("/pr-loop"));
  check("then user skills, then project skills", bare.at(-1) === "/pr-loop" || bare.indexOf("/pr-loop") > bare.indexOf("/undo"));
  check("a prefix match comes first", sv("/gri")[0] === "/grill-me");
  check("fuzzy: a name part matches", sv("/loop").includes("/pr-loop"));
  check("fuzzy: description words match too", sv("/interview").includes("/grill-me"));
  check("exact name beats everything", sv("/plan")[0] === "/plan" && sv("/mod")[0] === "/model");
  check("a built-in command wins a name clash", sv("/help").filter((v) => v === "/help").length === 1);
  {
    const item = slashCompletions("/gri", sk)?.items[0];
    check("a skill row shows its source like Claude Code", item?.description === "Interview me about a plan (User)");
  }
  check("a skill without arguments runs on Enter", slashCompletions("/gri", sk)?.items[0].children === false);
  const pr = slashCompletions("/pr-l", sk)?.items[0];
  check("a skill with arguments is filled in on Enter", pr?.children === true && pr.description.includes("(arguments: pr)"));
  check("after the name, a skill with arguments shows its hint", slashCompletions("/pr-loop ", sk)?.hint === "<pr>" && slashCompletions("/pr-loop ", sk)?.items.length === 0);
  check("once arguments are typed, nothing is in the way", slashCompletions("/pr-loop 42", sk) === null);
  check("the list only opens at the very start", slashCompletions("please /gri", sk) === null);

  // ---- a "/" later in the text: ghost text, not a list -------------------------------------------
  const g = inlineCommandGhost("please /gri", sk);
  check("mid-text slash suggests the rest of the best match", g?.suffix === "ll-me" && g.full === "grill-me" && g.start === 7);
  check("built-in commands are suggested too", inlineCommandGhost("then /mod", sk)?.full === "model");
  check("a complete name needs no ghost", inlineCommandGhost("x /model", sk) === null);
  check("no ghost at the very start (that is the list's job)", inlineCommandGhost("/gri", sk) === null);

  // ---- which /command tokens get highlighted (commands AND skills, anywhere) ----------------------
  const names = commandNames(sk);
  const r = (text: string) => JSON.stringify(commandTokenRanges(text, names));
  check("a skill at the start is highlighted", r("/grill-me") === "[[0,9]]");
  check("a skill anywhere in the text is highlighted", r("hi /grill-me now") === "[[3,12]]");
  check("built-in commands are highlighted too", r("try /model then /pr-loop") === "[[4,10],[16,24]]");
  check("punctuation after the name still highlights", r("/grill-me, please") === "[[0,9]]");
  check("a partial name is not highlighted", r("/grill") === "[]");
  check("a longer word is not highlighted", r("/grill-mean") === "[]");
  check("a path-like token is not highlighted", r("a/grill-me") === "[]");
  check("case-insensitive, like running it", r("/Grill-Me") === "[[0,9]]");
} finally { CONFIG.baseURL = previous; }
finish();

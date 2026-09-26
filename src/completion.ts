import Fuse from "fuse.js"; // the fuzzy matcher Claude Code's "/" typeahead uses
import { effortMenu } from "./effort.js";
import type { Skill } from "./skills.js";

// Completion describes editable text, never executes it. Frontends own keys,
// rendering and submission; providers below only supply available choices.
export interface Completion {
  value: string;
  description: string;
  children?: boolean;
}
export const COMMANDS: Completion[] = [
  { value: "/model", description: "Switch the model for this session", children: true },
  { value: "/effort", description: "Choose this model's reasoning effort", children: true },
  { value: "/skills", description: "Turn skills on, off, or user-only" },
  { value: "/skill", description: "Run a skill by name", children: true },
  { value: "/help", description: "Show commands and keyboard shortcuts" },
  { value: "/clear", description: "Start a fresh conversation" },
  { value: "/compact", description: "Summarize conversation history" },
  { value: "/stats", description: "Show session event counts" },
  { value: "/memory", description: "Show remembered project facts" },
  { value: "/status", description: "Show session usage and account balance/cost", children: true },
  { value: "/cost", description: "Show tokens and estimated cost" },
  { value: "/mcp", description: "Manage MCP servers", children: true },
  { value: "/plan", description: "Toggle plan mode" },
  { value: "/auto", description: "Toggle automatic permission review", children: true },
  { value: "/todos", description: "Show the current task plan" },
  { value: "/bg", description: "Show background tasks" },
  { value: "/team", description: "Show teammates and status" },
  { value: "/tasks", description: "Show the shared task board" },
  { value: "/goal", description: "Keep working until a goal is verified done", children: true },
  { value: "/cron", description: "Show scheduled jobs" },
  { value: "/peers", description: "Talk to another mini-agent session, or find its window" },
  { value: "/rename", description: "Rename this session for other sessions", children: true },
  { value: "/undo", description: "Revert the most recent file write" },
  { value: "/diff", description: "Show file changes this session" },
  { value: "/resume", description: "Choose a previous session" },
];

export interface CompletionContext {
  model: string;
  skills: (Pick<Skill, "name" | "description" | "whenToUse"> & { argNames?: string[]; argumentHint?: string; source?: "user" | "project" })[];
  models: string[];
  servers: string[];
  usage?: (skillName: string) => number; // recency-weighted use (skills.ts skillUsageScore); a bare "/" puts the top 5 first
}
// Every "/<command>" token in the text that names a real command or skill, as
// [start, end) code-unit ranges — the input box paints these. Claude Code's
// rule (findSlashCommandPositions): a "/" at the start or after whitespace,
// then a letter and [A-Za-z0-9:_-]*, anywhere in the text; it lights up only
// if that name exists. So "/grill-me," lights up, "/grill" and "a/grill-me" don't.
export function commandTokenRanges(text: string, names: string[]): [number, number][] {
  const known = new Set(names.map((n) => n.toLowerCase()));
  const out: [number, number][] = [];
  for (const m of text.matchAll(/(^|\s)(\/[a-zA-Z][a-zA-Z0-9:\-_]*)/g)) {
    const start = (m.index ?? 0) + m[1].length;
    if (known.has(m[2].slice(1).toLowerCase())) out.push([start, start + m[2].length]);
  }
  return out;
}

// Names a "/" can reach: built-in commands, then skills (a built-in wins a clash — it is what runs).
export function commandNames(ctx: Pick<CompletionContext, "skills">): string[] {
  const builtins = COMMANDS.map((c) => c.value.slice(1));
  return [...builtins, ...ctx.skills.map((s) => s.name).filter((n) => !builtins.includes(n))];
}

type Item = Completion & { name: string; group: "builtin" | "user" | "project"; usage: number };

function typeaheadItems(ctx: CompletionContext): Item[] {
  const builtins = new Set(COMMANDS.map((c) => c.value));
  const skills: Item[] = ctx.skills
    .filter((s) => !builtins.has(`/${s.name}`))
    .map((s) => ({
      value: `/${s.name}`,
      name: s.name,
      // Claude Code's formatDescriptionWithSource: "desc (User)" / "desc (Project)", plus the argument names.
      description: `${s.description || s.whenToUse}${s.source ? ` (${s.source === "project" ? "Project" : "User"})` : ""}${s.argNames?.length ? ` (arguments: ${s.argNames.join(", ")})` : ""}`,
      children: Boolean(s.argNames?.length), // takes arguments → Enter fills it in; none → Enter runs it
      group: s.source ?? "user",
      usage: ctx.usage?.(s.name) ?? 0,
    }));
  return [...COMMANDS.map((c): Item => ({ ...c, name: c.value.slice(1), group: "builtin", usage: 0 })), ...skills];
}

// The "/" typeahead, Claude Code's generateCommandSuggestions:
//   bare "/"  → your 5 most-used skills, then built-ins, then user skills, then
//               project skills, each group alphabetical
//   "/query"  → Fuse.js over name (weight 3), name parts split on :_- (2) and
//               description words (0.5), threshold 0.3; then re-sorted: exact
//               name, then name prefix (shorter first), then fuzzy score (when
//               it differs by > 0.1), then usage
function commandTypeahead(input: string, ctx: CompletionContext): Completion[] {
  const items = typeaheadItems(ctx);
  const q = input.slice(1).toLowerCase();
  const alpha = (a: Item, b: Item) => a.name.localeCompare(b.name);
  if (!q) {
    const top = items.filter((i) => i.usage > 0).sort((a, b) => b.usage - a.usage).slice(0, 5);
    const rest = (group: Item["group"]) => items.filter((i) => i.group === group && !top.includes(i)).sort(alpha);
    return [...top, ...rest("builtin"), ...rest("user"), ...rest("project")];
  }
  const docs = items.map((item) => {
    const parts = item.name.split(/[:_-]/);
    return { item, commandName: item.name.toLowerCase(), partKey: parts.length > 1 ? parts.map((p) => p.toLowerCase()) : undefined, descriptionKey: item.description.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean) };
  });
  const fuse = new Fuse(docs, { includeScore: true, threshold: 0.3, location: 0, distance: 100, keys: [{ name: "commandName", weight: 3 }, { name: "partKey", weight: 2 }, { name: "descriptionKey", weight: 0.5 }] });
  const rank = (name: string) => (name === q ? 0 : name.startsWith(q) ? 1 : 2);
  return fuse.search(q).sort((a, b) => {
    const an = a.item.commandName, bn = b.item.commandName;
    if (rank(an) !== rank(bn)) return rank(an) - rank(bn);
    if (rank(an) === 1 && an.length !== bn.length) return an.length - bn.length;
    const ds = (a.score ?? 0) - (b.score ?? 0);
    if (Math.abs(ds) > 0.1) return ds;
    return b.item.item.usage - a.item.item.usage;
  }).map((r) => r.item.item);
}

// A "/" in the middle of the text gets no list — just ghost text: the rest of
// the best prefix match, dim, after the cursor; Tab accepts it as "/name ".
// (Claude Code: getBestCommandMatch on /\s\/([a-zA-Z0-9_:-]*)$/ before the cursor.)
export function inlineCommandGhost(beforeCursor: string, ctx: Pick<CompletionContext, "skills">): { start: number; suffix: string; full: string } | null {
  const m = beforeCursor.match(/\s\/([a-zA-Z0-9_:-]+)$/);
  if (!m) return null;
  const partial = m[1].toLowerCase();
  const best = commandNames(ctx).filter((n) => n.toLowerCase().startsWith(partial) && n.length > partial.length).sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return best ? { start: beforeCursor.length - m[1].length - 1, suffix: best.slice(partial.length), full: best } : null;
}

export function slashCompletions(input: string, ctx: CompletionContext): { items: Completion[]; hint?: string } | null {
  if (!input.startsWith("/") || /[\r\n]/.test(input)) return null;
  const [command, ...parts] = input.split(/\s+/);
  const arg = parts.join(" ").toLowerCase();
  const filter = (items: Completion[], prefix = input) => items.filter((item) => item.value.toLowerCase().startsWith(prefix.toLowerCase()));
  if (command === "/effort") {
    const menu = effortMenu(ctx.model);
    return { items: filter(menu.values.map((value, i) => ({ value: `/effort ${value}`, description: menu.labels[i] }))), hint: menu.header };
  }
  if ((command === "/skills" && parts.length) || command === "/skill") { // bare "/skills" opens the manager; "/skills <name>" still runs one
    return { items: ctx.skills.filter((s) => s.name.toLowerCase().startsWith(arg)).map((s) => ({ value: `/skill ${s.name}`, description: s.whenToUse || s.description })), hint: ctx.skills.length ? "Choose a skill to run" : "No skills found in project or user skill directories" };
  }
  if (command === "/model") {
    const save = arg === "save" || arg.startsWith("save ");
    const prefix = save ? "/model save " : "/model ";
    const items: Completion[] = [...new Set([ctx.model, ...ctx.models])].sort().map((name) => ({ value: prefix + name, description: name === ctx.model ? "Current model" : "Switch model" }));
    if (!save) items.push({ value: "/model save", description: "Save a model as your default", children: true });
    return { items: filter(items, save && arg === "save" ? prefix : input), hint: "Models from your endpoint; you can also type a model name" };
  }
  if (command === "/status") {
    return { items: filter([
      { value: "/status", description: "Current endpoint account and session usage" },
      { value: "/status local", description: "Session only; no account API request" },
      ...["deepseek", "openai", "anthropic"].map((provider) => ({ value: `/status ${provider}`, description: `Query the official ${provider} account with its dedicated credential` })),
    ], input.trimEnd()) };
  }
  if (command === "/auto") {
    return { items: filter([
      { value: "/auto", description: "Toggle auto mode" },
      ...["on", "off", "status"].map((v) => ({ value: `/auto debug ${v}`, description: `${v === "status" ? "Inspect" : v === "on" ? "Enable" : "Disable"} reviewer request logging` })),
    ], input.trimEnd()) };
  }
  if (command === "/mcp") {
    const items = [{ value: "/mcp", description: "Open MCP server menu" }, { value: "/mcp reload", description: "Re-read MCP servers from settings.json" }, ...["tools", "auth", "clear-auth", "reconnect", "enable", "disable"].flatMap((action) => ctx.servers.map((name) => ({ value: `/mcp ${action} ${name}`, description: `${action} ${name}` })))];
    return { items: filter(items, input.trimEnd()) };
  }
  if (!/\s/.test(input)) return { items: commandTypeahead(input, ctx), hint: "No matching commands or skills" };
  // "/<skill> args…": the user is typing arguments now — no list, just the
  // skill's argument hint while it has one (Claude Code's argumentHint).
  const skill = ctx.skills.find((s) => `/${s.name.toLowerCase()}` === command.toLowerCase());
  if (skill) {
    const hint = skill.argumentHint || (skill.argNames?.length ? skill.argNames.map((a) => `<${a}>`).join(" ") : "");
    return hint && !arg ? { items: [], hint } : null;
  }
  return { items: filter(COMMANDS), hint: "Commands" };
}

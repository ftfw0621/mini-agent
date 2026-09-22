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
  { value: "/skills", description: "Browse and run available skills", children: true },
  { value: "/skill", description: "Run a skill by name", children: true },
  { value: "/help", description: "Show commands and keyboard shortcuts" },
  { value: "/clear", description: "Start a fresh conversation" },
  { value: "/compact", description: "Summarize conversation history" },
  { value: "/stats", description: "Show session event counts" },
  { value: "/memory", description: "Show remembered project facts" },
  { value: "/cost", description: "Show tokens and estimated cost" },
  { value: "/mcp", description: "Manage MCP servers", children: true },
  { value: "/plan", description: "Toggle plan mode" },
  { value: "/auto", description: "Toggle automatic permission review", children: true },
  { value: "/todos", description: "Show the current task plan" },
  { value: "/bg", description: "Show background tasks" },
  { value: "/team", description: "Show teammates and status" },
  { value: "/tasks", description: "Show the shared task board" },
  { value: "/cron", description: "Show scheduled jobs" },
  { value: "/undo", description: "Revert the most recent file write" },
  { value: "/diff", description: "Show file changes this session" },
  { value: "/resume", description: "Choose a previous session" },
];

export interface CompletionContext {
  model: string;
  skills: Pick<Skill, "name" | "description" | "whenToUse">[];
  models: string[];
  servers: string[];
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
  if (command === "/skills" || command === "/skill") {
    return { items: ctx.skills.filter((s) => s.name.toLowerCase().startsWith(arg)).map((s) => ({ value: `/skill ${s.name}`, description: s.whenToUse || s.description })), hint: ctx.skills.length ? "Choose a skill to run" : "No skills found in project or user skill directories" };
  }
  if (command === "/model") {
    const save = arg === "save" || arg.startsWith("save ");
    const prefix = save ? "/model save " : "/model ";
    const items: Completion[] = [...new Set([ctx.model, ...ctx.models])].sort().map((name) => ({ value: prefix + name, description: name === ctx.model ? "Current model" : "Switch model" }));
    if (!save) items.push({ value: "/model save", description: "Save a model as your default", children: true });
    return { items: filter(items, save && arg === "save" ? prefix : input), hint: "Models from your endpoint; you can also type a model name" };
  }
  if (command === "/auto") {
    return { items: filter([
      { value: "/auto", description: "Toggle auto mode" },
      ...["on", "off", "status"].map((v) => ({ value: `/auto debug ${v}`, description: `${v === "status" ? "Inspect" : v === "on" ? "Enable" : "Disable"} reviewer request logging` })),
    ], input.trimEnd()) };
  }
  if (command === "/mcp") {
    const items = [{ value: "/mcp", description: "Open MCP server menu" }, ...["reconnect", "auth", "enable", "disable"].flatMap((action) => ctx.servers.map((name) => ({ value: `/mcp ${action} ${name}`, description: `${action} ${name}` })))];
    return { items: filter(items, input.trimEnd()) };
  }
  return { items: filter(COMMANDS), hint: "Commands" };
}

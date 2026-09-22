import { CONFIG } from "./config.js";
import type OpenAI from "openai";

// Both UIs share capability discovery and request adaptation. Unknown gateways
// need an explicit profile: /models has no standard effort metadata.
export interface EffortProfile {
  levels: string[];
  parameter: "reasoning_effort" | "deepseek";
  default?: string;
}
const selections = new Map<string, string>();
const keyFor = (model: string) => `${CONFIG.baseURL}\n${model}`;

export function effortProfile(model: string): EffortProfile | undefined {
  const configured = CONFIG.effortProfiles[model];
  if (configured) {
    if (!Array.isArray(configured.levels) || !configured.levels.every((v) => typeof v === "string" && /^[a-z]+$/.test(v) && v !== "default")
      || !["reasoning_effort", "deepseek"].includes(configured.parameter)) return undefined;
    return configured;
  }
  let host = "";
  try { host = new URL(CONFIG.baseURL).hostname; } catch { return undefined; }
  if (host === "api.deepseek.com" && ["deepseek-flash", "deepseek-v4-pro"].includes(model)) {
    return { levels: ["none", "low", "high", "max"], parameter: "deepseek", default: "high" };
  }
  if (host === "api.openai.com") {
    const name = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
    const levels: Record<string, string[]> = {
      "gpt-5": ["minimal", "low", "medium", "high"],
      "gpt-5-mini": ["minimal", "low", "medium", "high"],
      "gpt-5-nano": ["minimal", "low", "medium", "high"],
      "gpt-5.1": ["none", "low", "medium", "high"],
      "gpt-5.2": ["none", "low", "medium", "high", "xhigh"],
      "o3": ["low", "medium", "high"], "o3-mini": ["low", "medium", "high"], "o4-mini": ["low", "medium", "high"],
    };
    if (levels[name]) return { levels: levels[name], parameter: "reasoning_effort" };
  }
  return undefined;
}

export function selectedEffort(model: string): string {
  const selected = selections.get(keyFor(model));
  return selected && effortProfile(model)?.levels.includes(selected) ? selected : "default";
}

export function effortMenu(model: string): { header: string; values: string[]; labels: string[] } {
  const profile = effortProfile(model);
  const current = selectedEffort(model);
  const values = profile?.levels.length ? ["default", ...profile.levels] : [];
  return {
    header: values.length ? `effort — ${model} · current: ${current}`
      : `Effort capabilities unknown or not configurable for ${model} at this endpoint. Configure effortProfiles for a custom gateway.`,
    values,
    labels: values.map((v) => `${v}${v === "default" ? ` (provider default${profile?.default ? `: ${profile.default}` : ""})` : v === "none" ? " (thinking off)" : ""}${v === current ? " ✓" : ""}`),
  };
}

export function setEffort(model: string, value: string): string {
  if (value === "default") { selections.delete(keyFor(model)); return `effort: ${model} → provider default`; }
  const menu = effortMenu(model);
  if (!menu.values.includes(value)) return menu.values.length ? `Unsupported effort '${value}' for ${model}. Choose: ${menu.values.join(", ")}` : menu.header;
  selections.set(keyFor(model), value);
  return `effort: ${model} → ${value} (this session)`;
}

export function effortParameters(model: string): Record<string, unknown> {
  const value = selectedEffort(model);
  if (value === "default") return {};
  if (effortProfile(model)?.parameter === "deepseek") {
    return value === "none" ? { thinking: { type: "disabled" } }
      : { thinking: { type: "enabled" }, reasoning_effort: value };
  }
  return { reasoning_effort: value };
}

export function retainsReasoning(model: string): boolean { return effortProfile(model)?.parameter === "deepseek"; }

export function effortMessages(model: string, messages: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const { reasoning_content, ...plain } = message as typeof message & { reasoning_content?: string };
    return retainsReasoning(model) ? { ...plain, reasoning_content: reasoning_content ?? "" } : plain;
  });
}

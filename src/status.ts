import { CONFIG } from "./config.js";
import type { CostMeter } from "./cost.js";
import { getAccountStatus, type AccountProvider, type Metric, type Money, type AccountStatus } from "./account-status.js";

function show<T>(metric: Metric<T>, format: (value: T) => string): string {
  return metric.state === "ok" ? format(metric.value) : `unavailable — ${metric.reason}`;
}
const money = (values: Money[]) => values.map((m) => `${m.currency} ${m.amount.toFixed(4)}`).join(" · ");
export function formatAccountStatus(status: AccountStatus): string {
  return [
    `Account: ${status.provider} · queried ${status.checkedAt}`,
    `  balance: ${show(status.balance, money)}`,
    `  report period (UTC, month to date): ${status.period}`,
    `  account usage: ${show(status.usage, (u) => `input ${u.input} (${u.cached} cached) · output ${u.output}`)}`,
    `  account reported cost: ${show(status.cost, money)}`,
    status.note,
  ].filter(Boolean).join("\n");
}
// Shared by Ink and readline. No model call, conversation insertion or logging.
export async function statusCommand(line: string, meter: CostMeter, options: { request?: typeof fetch; env?: Record<string, string | undefined>; signal?: AbortSignal } = {}): Promise<string> {
  const arg = line.trim().split(/\s+/).slice(1).join(" ");
  if (arg && !["local", "deepseek", "openai", "anthropic"].includes(arg)) return "Usage: /status [local|deepseek|openai|anthropic]";
  // A URL may itself contain credentials/query tokens; show only its origin.
  let endpoint = "custom endpoint";
  try { endpoint = new URL(CONFIG.baseURL).origin; } catch { /* leave generic */ }
  const local = [`Model: ${CONFIG.model}`, `Endpoint: ${endpoint}`, meter.report(),
    "Local usage covers metered main/subagent streams; auxiliary calls (including permission review/Jev) are excluded. Estimates use settings.pricing, not account billing."].join("\n");
  if (arg === "local") return local;
  const account = await getAccountStatus({ baseURL: CONFIG.baseURL, apiKey: CONFIG.apiKey, env: options.env ?? process.env, provider: arg ? arg as AccountProvider : undefined, request: options.request, signal: options.signal });
  return `${local}\n\n${formatAccountStatus(account)}`;
}

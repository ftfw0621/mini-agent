import { CONFIG } from "./config.js";
import chalk from "chalk";
import wrapAnsi from "wrap-ansi";
import { displayWidth } from "./editor.js";
import { cacheHitRate, type CostMeter } from "./cost.js";
import { getAccountStatus, type AccountProvider, type Metric, type Money, type AccountStatus } from "./account-status.js";

function show<T>(metric: Metric<T>, format: (value: T) => string): string {
  return metric.state === "ok" ? format(metric.value) : chalk.dim(`unavailable — ${metric.reason}`);
}
const money = (values: Money[]) => values.map((m) => `${m.currency} ${m.amount.toFixed(4)}`).join(" · ");

type StatusLine = { label?: string; text: string };
function accountLines(status: AccountStatus): StatusLine[] {
  return [
    { text: chalk.bold("Vendor account") },
    { label: "Provider", text: chalk.cyan.bold(status.provider) },
    { label: "Balance", text: show(status.balance, (values) => chalk.green.bold(money(values))) },
    { label: "Reported cost", text: show(status.cost, (values) => chalk.yellow.bold(money(values))) },
    { label: "Account usage", text: show(status.usage, (u) => chalk.cyan(`input ${u.input} (${u.cached} cached) · output ${u.output}`)) },
    { label: "Period (UTC)", text: status.period },
    { label: "Checked at", text: chalk.dim(status.checkedAt) },
    ...(status.note ? [{ text: chalk.dim(status.note) }] : []),
  ];
}

// Both frontends use the same ANSI/CJK-aware layout. Narrow terminals stack
// labels above values; wider ones align values in a second column.
function renderLines(lines: StatusLine[], width: number): string[] {
  return lines.flatMap(({ label, text }) => {
    const indent = label && width >= 44 ? 18 : 0;
    const value = wrapAnsi(text, Math.max(1, width - indent), { hard: true, trim: false }).split("\n");
    if (!label) return value;
    if (!indent) return [chalk.dim(`${label}:`), ...value];
    return value.map((line, i) => (i === 0 ? chalk.dim(`${label}:`.padEnd(indent)) : " ".repeat(indent)) + line);
  });
}

export function formatAccountStatus(status: AccountStatus): string {
  return renderLines(accountLines(status), 92).join("\n");
}

function statusCard(lines: StatusLine[], columns: number): string {
  const width = Math.max(1, Math.min(96, Math.floor(columns)));
  if (width < 6) return renderLines(lines, width).join("\n");
  const inner = width - 4; // two borders and one space of padding per side
  const body = renderLines(lines, inner).map((line) => chalk.dim("│ ") + line + " ".repeat(Math.max(0, inner - displayWidth(line))) + chalk.dim(" │"));
  return [chalk.dim(`╭${"─".repeat(width - 2)}╮`), ...body, chalk.dim(`╰${"─".repeat(width - 2)}╯`)].join("\n");
}

// Shared by Ink and readline. No model call, conversation insertion or logging.
export async function statusCommand(line: string, meter: CostMeter, options: { request?: typeof fetch; env?: Record<string, string | undefined>; signal?: AbortSignal; columns?: number } = {}): Promise<string> {
  const arg = line.trim().split(/\s+/).slice(1).join(" ");
  if (arg && !["local", "deepseek", "openai", "anthropic"].includes(arg)) return "Usage: /status [local|deepseek|openai|anthropic]";
  // A URL may itself contain credentials/query tokens; show only its origin.
  let endpoint = "custom endpoint";
  try { endpoint = new URL(CONFIG.baseURL).origin; } catch { /* leave generic */ }
  const usage = meter.snapshot();
  const local: StatusLine[] = [
    { text: chalk.bold("mini-agent · Status") },
    { text: "" },
    { label: "Model", text: chalk.cyan.bold(CONFIG.model) },
    { label: "Endpoint", text: endpoint },
    { text: "" },
    { text: chalk.bold("Current session") },
    { label: "Model calls", text: chalk.cyan(String(usage.calls)) },
    { label: "Input tokens", text: chalk.cyan(String(usage.inputUncached + usage.inputCached)) },
    { label: "Cached input", text: `${usage.inputCached} (${(cacheHitRate(usage) * 100).toFixed(0)}% hit rate)` },
    { label: "Output tokens", text: chalk.cyan(String(usage.output)) },
    { label: "Estimated cost", text: chalk.yellow.bold(`$${usage.cost.toFixed(4)}`) },
    { text: "" },
    { text: chalk.dim("Main/subagent streams only; excludes permission review/Jev and other auxiliary calls.") },
    { text: chalk.dim("Estimates use settings.pricing, not account billing.") },
  ];
  const columns = options.columns ?? (process.stdout.columns || 80);
  if (arg === "local") return statusCard(local, columns);
  const account = await getAccountStatus({ baseURL: CONFIG.baseURL, apiKey: CONFIG.apiKey, env: options.env ?? process.env, provider: arg ? arg as AccountProvider : undefined, request: options.request, signal: options.signal });
  return statusCard([...local, { text: "" }, ...accountLines(account)], columns);
}

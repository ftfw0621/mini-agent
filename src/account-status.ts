// Account APIs are independent from inference protocols. Each adapter normalizes
// only documented fields; an unavailable balance must never become a fake zero.
export type AccountProvider = "deepseek" | "openai" | "anthropic";
export type Metric<T> = { state: "ok"; value: T } | { state: "unavailable"; reason: string };
export interface Money { currency: string; amount: number }
export interface AccountUsage { input: number; cached: number; output: number }
export interface AccountStatus {
  provider: AccountProvider | "custom";
  checkedAt: string;
  period: string;
  balance: Metric<Money[]>;
  usage: Metric<AccountUsage>;
  cost: Metric<Money[]>;
  note: string;
}
export interface AccountOptions {
  baseURL: string;
  apiKey: string;
  provider?: AccountProvider;
  env: Record<string, string | undefined>;
  request?: typeof fetch;
  now?: Date;
  signal?: AbortSignal;
}
const unavailable = <T>(reason: string): Metric<T> => ({ state: "unavailable", reason });
const origins: Record<AccountProvider, string> = {
  deepseek: "https://api.deepseek.com", openai: "https://api.openai.com", anthropic: "https://api.anthropic.com",
};
export function accountProvider(baseURL: string): AccountProvider | undefined {
  try {
    const url = new URL(baseURL);
    if (url.username || url.password) return undefined;
    return (Object.keys(origins) as AccountProvider[]).find((id) => origins[id] === url.origin);
  } catch { return undefined; }
}
class AccountError extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccountError("Invalid account API response");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new AccountError("Invalid account API response");
  return value;
}
function number(value: unknown): number {
  if (!(typeof value === "number" || (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)))) throw new AccountError("Invalid numeric account data");
  const result = Number(value);
  if (!Number.isFinite(result)) throw new AccountError("Invalid numeric account data");
  return result;
}
function tokens(value: unknown): number {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new AccountError("Invalid token count");
  return result;
}
function currency(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z]{3}$/i.test(value)) throw new AccountError("Invalid account currency");
  return value.toUpperCase();
}
async function metric<T>(run: () => Promise<T>): Promise<Metric<T>> {
  try { return { state: "ok", value: await run() }; }
  catch (error) {
    // Never print provider bodies or transport errors: either can contain keys.
    return unavailable(error instanceof AccountError ? error.message : "Request failed, timed out or was cancelled; try /status again");
  }
}
interface AccountAdapter {
  origin: string;
  headers: Record<string, string>;
  request: typeof fetch;
  signal: AbortSignal;
}
async function json(adapter: AccountAdapter, path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const url = new URL(path, adapter.origin);
  url.search = new URLSearchParams(query).toString();
  adapter.signal.throwIfAborted();
  const response = await adapter.request(url.toString(), { method: "GET", headers: adapter.headers, signal: adapter.signal, redirect: "error" });
  if (!response.ok) throw new AccountError(response.status === 401 || response.status === 403
    ? `Authentication/permission denied (HTTP ${response.status}); check the account credential`
    : response.status === 429 ? "Account API rate-limited; try later" : `Account API unavailable (HTTP ${response.status})`);
  return object(await response.json());
}
async function report(adapter: AccountAdapter, path: string, query: Record<string, string>): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  // Fetch all pages or fail this metric. Never label a partial sum as a total.
  for (let page = 0; page < 50; page++) {
    const body = await json(adapter, path, query);
    for (const bucket of array(body.data)) for (const result of array(object(bucket).results)) results.push(object(result));
    if (body.has_more === false) return results;
    if (body.has_more !== true || typeof body.next_page !== "string" || !body.next_page || seen.has(body.next_page)) throw new AccountError("Invalid account report pagination");
    seen.add(body.next_page);
    query = { ...query, page: body.next_page };
  }
  throw new AccountError("Account report exceeded the page limit; total unavailable");
}
function sumUsage(rows: Record<string, unknown>[], provider: "openai" | "anthropic"): AccountUsage {
  return rows.reduce<AccountUsage>((sum, row) => {
    let input: number;
    let cached: number;
    if (provider === "openai") {
      input = tokens(row.input_tokens);
      cached = tokens(row.input_cached_tokens ?? 0); // included in input_tokens
      if (cached > input) throw new AccountError("Invalid cached token count");
    } else {
      const creation = object(row.cache_creation);
      cached = tokens(row.cache_read_input_tokens);
      input = tokens(row.uncached_input_tokens) + cached + tokens(creation.ephemeral_1h_input_tokens) + tokens(creation.ephemeral_5m_input_tokens);
    }
    return { input: sum.input + input, cached: sum.cached + cached, output: sum.output + tokens(row.output_tokens) };
  }, { input: 0, cached: 0, output: 0 });
}
function sumCost(rows: Record<string, unknown>[], provider: "openai" | "anthropic"): Money[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const money = provider === "openai" ? object(row.amount) : row;
    const unit = currency(money.currency);
    // Anthropic reports decimal cents; OpenAI reports currency units.
    const amount = provider === "openai" ? number(money.value) : number(money.amount) / 100;
    totals.set(unit, (totals.get(unit) ?? 0) + amount);
  }
  return totals.size ? [...totals].map(([currency, amount]) => ({ currency, amount })) : [{ currency: "USD", amount: 0 }];
}
export async function getAccountStatus(options: AccountOptions): Promise<AccountStatus> {
  const detected = accountProvider(options.baseURL);
  const provider = options.provider ?? detected;
  const now = options.now ?? new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const result: AccountStatus = {
    provider: provider ?? "custom", checkedAt: now.toISOString(), period: `${start.toISOString()} → ${now.toISOString()}`,
    balance: unavailable("No documented public balance endpoint integrated; check the vendor billing console"),
    usage: unavailable("Not provided by this account API; see session usage below"),
    cost: unavailable("Not provided by this account API; see session estimate below"), note: "",
  };
  if (!provider) {
    result.note = "Custom/proxy endpoint: billing is vendor-specific. Use /status <provider> only to query a separate official account with its dedicated credential.";
    return result;
  }
  const adminEnv = provider === "openai" ? "OPENAI_ADMIN_KEY" : "ANTHROPIC_ADMIN_KEY";
  const key = provider === "deepseek" ? (detected === "deepseek" ? options.apiKey : options.env.DEEPSEEK_API_KEY)
    : options.env[adminEnv] || options.env[adminEnv.replace("_KEY", "_API_KEY")];
  if (!key?.trim()) {
    const reason = provider === "deepseek" ? "No DeepSeek API key configured" : `Set ${adminEnv} (admin credential); a normal inference key is not used for organization reports`;
    if (provider === "deepseek") result.balance = unavailable(reason);
    else { result.usage = unavailable(reason); result.cost = unavailable(reason); }
    return result;
  }
  // Fixed official origins, no redirects and no model-name inference: never
  // send an admin key to an OpenAI-compatible proxy or a lookalike host.
  const adapter: AccountAdapter = {
    origin: origins[provider], request: options.request ?? fetch,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    headers: provider === "anthropic" ? { "x-api-key": key.trim(), "anthropic-version": "2023-06-01", "User-Agent": "mini-agent" } : { Authorization: `Bearer ${key.trim()}` },
  };
  if (provider === "deepseek") {
    result.balance = await metric(async () => {
      const body = await json(adapter, "/user/balance");
      if (typeof body.is_available !== "boolean") throw new AccountError("Invalid balance availability");
      const balances = array(body.balance_infos).map((entry) => { const v = object(entry); return { currency: currency(v.currency), amount: number(v.total_balance) }; });
      if (!balances.length) throw new AccountError("Balance API returned no currencies");
      result.note = `Balance sufficient for API calls: ${body.is_available ? "yes" : "no"}`;
      return balances;
    });
    return result;
  }
  result.note = `Organization-wide reports for the admin credential, across all keys/projects; may be delayed. Usage covers ${provider === "openai" ? "completions" : "Messages"} only.${provider === "anthropic" ? " Cost excludes Priority Tier." : ""}`;
  const query: Record<string, string> = provider === "openai"
    ? { start_time: String(Math.floor(start.getTime() / 1000)), end_time: String(Math.floor(now.getTime() / 1000)), bucket_width: "1d", limit: "31" }
    : { starting_at: start.toISOString(), ending_at: now.toISOString(), bucket_width: "1d", limit: "31" };
  const paths = provider === "openai" ? ["/v1/organization/usage/completions", "/v1/organization/costs"] : ["/v1/organizations/usage_report/messages", "/v1/organizations/cost_report"];
  [result.usage, result.cost] = await Promise.all([
    metric(async () => sumUsage(await report(adapter, paths[0], query), provider)),
    metric(async () => sumCost(await report(adapter, paths[1], query), provider)),
  ]);
  return result;
}

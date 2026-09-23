import { getAccountStatus, accountProvider, type AccountOptions } from "../src/account-status.js";
import { statusCommand, formatAccountStatus } from "../src/status.js";
import { CONFIG } from "../src/config.js";
import { CostMeter, DEFAULT_PRICING } from "../src/cost.js";
import { check, finish } from "./helpers.js";
const now = new Date("2026-09-23T03:04:05Z");
const opts: AccountOptions = { baseURL: "https://api.deepseek.com/v1", apiKey: "inference-secret", env: {}, now };
let calls: { url: URL; init?: RequestInit }[] = [];
const record = (body: unknown, status = 200): typeof fetch => async (url, init) => { calls.push({ url: new URL(String(url)), init }); return new Response(JSON.stringify(body), { status }); };
const page = (results: unknown[], next: string | null = null) => ({ data: [{ results }], has_more: next !== null, next_page: next });
const usage = { input_tokens: 100, input_cached_tokens: 20, output_tokens: 30 };
const costs = { amount: { value: 1.25, currency: "usd" } };
check("provider comes from exact HTTPS origin, including /v1 endpoints", accountProvider(opts.baseURL) === "deepseek" && accountProvider("https://api.openai.com/v1") === "openai");
for (const url of ["https://api.openai.com.evil.test/v1", "https://proxy.test/openai", "http://api.openai.com", "https://api.openai.com:8443", "https://token@api.openai.com", "bad"]) check("proxy/lookalike/insecure URL cannot select a billing credential", accountProvider(url) === undefined);
const balance = await getAccountStatus({ ...opts, request: record({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "10.50" }, { currency: "USD", total_balance: "2.10" }] }) });
check("DeepSeek uses current inference key at official balance endpoint", calls.length === 1 && calls[0].url.toString() === "https://api.deepseek.com/user/balance" && new Headers(calls[0].init?.headers).get("Authorization") === "Bearer inference-secret");
check("balance preserves multiple currencies without conversion", balance.balance.state === "ok" && balance.balance.value[0].amount === 10.5 && balance.balance.value[1].currency === "USD");
check("balance is not reported as monthly account spend", balance.cost.state === "unavailable" && balance.usage.state === "unavailable");
check("account calls reject redirects and have cancellation signals", calls[0].init?.redirect === "error" && !!calls[0].init?.signal);
const zero = await getAccountStatus({ ...opts, request: record({ is_available: false, balance_infos: [{ currency: "USD", total_balance: "0" }] }) });
check("zero balance is distinct from unavailable", zero.balance.state === "ok" && zero.balance.value[0].amount === 0 && zero.note.includes("no"));
for (const invalid of [{}, { is_available: true, balance_infos: [] }, { is_available: true, balance_infos: [{ currency: "USD", total_balance: "" }] }]) {
  check("malformed balance never becomes zero", (await getAccountStatus({ ...opts, request: record(invalid) })).balance.state === "unavailable");
}
calls = [];
const unknown = await getAccountStatus({ ...opts, baseURL: "https://proxy.test/v1", env: { OPENAI_ADMIN_KEY: "admin-secret" }, request: record({}) });
check("unknown vendor makes no billing request despite admin key", unknown.provider === "custom" && calls.length === 0);
const missing = await getAccountStatus({ ...opts, baseURL: "https://api.openai.com/v1", request: record({}) });
check("ordinary OpenAI inference key is not reused as admin key", missing.usage.state === "unavailable" && missing.usage.reason.includes("OPENAI_ADMIN_KEY") && calls.length === 0);
const openai = await getAccountStatus({ ...opts, baseURL: "https://api.openai.com/v1", env: { OPENAI_ADMIN_KEY: "admin-secret" }, request: async (url, init) => {
  const u = new URL(String(url)); calls.push({ url: u, init });
  return new Response(JSON.stringify(u.pathname.endsWith("costs") ? page([costs]) : page([usage], u.searchParams.has("page") ? null : "next")));
} });
check("OpenAI aggregates every usage page", openai.usage.state === "ok" && openai.usage.value.input === 200 && openai.usage.value.cached === 40 && openai.usage.value.output === 60);
check("OpenAI reported currency units are not divided by 100", openai.cost.state === "ok" && openai.cost.value[0].amount === 1.25);
check("reports use admin key, UTC month start and explicit end", calls.length === 3 && calls.every((c) => new Headers(c.init?.headers).get("Authorization") === "Bearer admin-secret" && c.url.searchParams.get("start_time") === String(Date.UTC(2026, 8, 1) / 1000) && c.url.searchParams.get("end_time") === String(now.getTime() / 1000)));
check("usage scope and unavailable balance are explicit", openai.note.includes("Organization-wide") && openai.note.includes("completions") && openai.balance.state === "unavailable");
calls = [];
const anthropic = await getAccountStatus({ ...opts, provider: "anthropic", baseURL: "https://proxy.test", env: { ANTHROPIC_ADMIN_API_KEY: "anthropic-admin" }, request: async (url, init) => {
  const u = new URL(String(url)); calls.push({ url: u, init });
  return new Response(JSON.stringify(page(u.pathname.endsWith("cost_report") ? [{ currency: "USD", amount: "123.78912" }] : [{ uncached_input_tokens: 100, cache_read_input_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 5 }, output_tokens: 30 }])));
} });
check("explicit Anthropic query uses official origin, never the inference proxy", calls.every((c) => c.url.origin === "https://api.anthropic.com" && new Headers(c.init?.headers).get("x-api-key") === "anthropic-admin" && new Headers(c.init?.headers).get("anthropic-version") === "2023-06-01"));
check("Anthropic report uses ISO UTC dates", calls[0].url.searchParams.get("starting_at") === "2026-09-01T00:00:00.000Z" && calls[0].url.searchParams.get("ending_at") === now.toISOString());
check("Anthropic input includes read and creation cache tokens", anthropic.usage.state === "ok" && anthropic.usage.value.input === 135 && anthropic.usage.value.cached === 20);
check("Anthropic decimal cents are converted to USD once", anthropic.cost.state === "ok" && Math.abs(anthropic.cost.value[0].amount - 1.2378912) < 1e-10);
calls = [];
await getAccountStatus({ ...opts, provider: "deepseek", baseURL: "https://proxy.test", env: { DEEPSEEK_API_KEY: "dedicated" }, request: record({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "1" }] }) });
check("explicit DeepSeek query never forwards proxy key", new Headers(calls[0].init?.headers).get("Authorization") === "Bearer dedicated");
const partial = await getAccountStatus({ ...opts, baseURL: "https://api.openai.com", env: { OPENAI_ADMIN_KEY: "secret" }, request: async (url) => String(url).includes("/costs?") ? new Response("secret-response", { status: 403 }) : new Response(JSON.stringify(page([usage]))) });
check("one failed metric leaves the successful metric visible", partial.usage.state === "ok" && partial.cost.state === "unavailable" && partial.cost.reason.includes("403"));
check("HTTP response bodies never reach the screen", !formatAccountStatus(partial).includes("secret-response"));
const looped = await getAccountStatus({ ...opts, baseURL: "https://api.openai.com", env: { OPENAI_ADMIN_KEY: "secret" }, request: record(page([usage], "same-page")) });
check("pagination loops fail rather than displaying partial totals", looped.usage.state === "unavailable" && looped.usage.reason.includes("pagination"));
const bad = await getAccountStatus({ ...opts, baseURL: "https://api.openai.com", env: { OPENAI_ADMIN_KEY: "secret" }, request: record(page([{ ...usage, input_tokens: "garbage" }])) });
check("malformed usage does not coerce missing/invalid fields into zero", bad.usage.state === "unavailable");
const empty = await getAccountStatus({ ...opts, baseURL: "https://api.openai.com", env: { OPENAI_ADMIN_KEY: "secret" }, request: record(page([])) });
check("valid empty reports mean zero recorded usage", empty.usage.state === "ok" && empty.usage.value.input === 0 && empty.cost.state === "ok" && empty.cost.value[0].amount === 0);
const controller = new AbortController(); controller.abort(); calls = [];
const cancelled = await getAccountStatus({ ...opts, signal: controller.signal, request: record({}) });
check("cancelled lookup sends no request", cancelled.balance.state === "unavailable" && calls.length === 0);
for (const code of [401, 429, 503]) {
  const result = await getAccountStatus({ ...opts, request: record({}, code) });
  check(`HTTP ${code} is represented as unavailable`, result.balance.state === "unavailable");
}
const previousURL = CONFIG.baseURL;
const meter = new CostMeter(DEFAULT_PRICING);
meter.record({ prompt_tokens: 100, completion_tokens: 10 });
try {
  CONFIG.baseURL = "https://user:password@proxy.test/v1?token=secret";
  calls = [];
  const local = await statusCommand("/status local", meter, { request: record({}) });
  check("local status performs no network request and retains session usage", calls.length === 0 && local.includes("input:  100") && local.includes("output: 10") && local.includes("estimated cost"));
  check("local estimate discloses excluded reviewer usage", local.includes("permission review/Jev") && local.includes("settings.pricing"));
  check("endpoint display excludes URL credentials and query secrets", !local.includes("password") && !local.includes("token=secret"));
  check("invalid command arguments cannot trigger a query", (await statusCommand("/status garbage", meter, { request: record({}) })).startsWith("Usage:") && calls.length === 0);
} finally { CONFIG.baseURL = previousURL; }
finish();

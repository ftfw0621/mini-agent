// Token & cost accounting. The most-emphasized lesson of the Harness book is
// token economics: "cache breaks are silent", "90% of the bill is re-sending
// the same prompt". You cannot manage what you cannot see — so every model
// call's usage is metered, and /cost shows tokens, the cache hit rate, and an
// estimated spend. Nothing here leaves the machine; it is just arithmetic over
// the `usage` the API already returns.

// The token counts an API response reports. Providers differ in shape, so the
// recorder normalizes into these four fields.
export interface Usage {
  inputUncached: number; // prompt tokens that were NOT served from cache (full price)
  inputCached: number; // prompt tokens served from cache (cheap)
  output: number; // completion tokens (the expensive ones)
}

// Per-million-token prices. Defaults are DeepSeek-ish but WILL drift — they are
// configurable in settings (pricing: { ... }). The point is the hit-rate and
// the trend, not three-decimal accuracy.
export interface Pricing {
  inputPerM: number; // price per 1M uncached input tokens
  cachedInputPerM: number; // price per 1M cached input tokens (much cheaper)
  outputPerM: number; // price per 1M output tokens
}

export const DEFAULT_PRICING: Pricing = {
  inputPerM: 0.27, // $ / 1M — check your provider; override in settings.pricing
  cachedInputPerM: 0.07, // cache hits are ~4x cheaper — this is why hit rate matters
  outputPerM: 1.1, // output is the pricey one — don't let the model ramble
};

// Normalize a provider `usage` object into our four fields. Handles DeepSeek
// (prompt_cache_hit_tokens / prompt_cache_miss_tokens) and OpenAI
// (prompt_tokens_details.cached_tokens) shapes; falls back gracefully.
export function normalizeUsage(usage: Record<string, unknown> | undefined | null): Usage {
  if (!usage) return { inputUncached: 0, inputCached: 0, output: 0 };
  const prompt = Number(usage.prompt_tokens ?? 0); // total input tokens
  const output = Number(usage.completion_tokens ?? 0); // total output tokens
  // DeepSeek reports the split directly:
  const dsHit = Number(usage.prompt_cache_hit_tokens ?? NaN);
  const dsMiss = Number(usage.prompt_cache_miss_tokens ?? NaN);
  if (!Number.isNaN(dsHit) && !Number.isNaN(dsMiss)) {
    return { inputUncached: dsMiss, inputCached: dsHit, output };
  }
  // OpenAI reports only the cached count, nested:
  const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const cached = Number(details?.cached_tokens ?? 0);
  return { inputUncached: Math.max(0, prompt - cached), inputCached: cached, output };
}

// Estimated dollar cost of some usage under some pricing. Pure — easy to test.
export function costOf(u: Usage, p: Pricing): number {
  return (u.inputUncached * p.inputPerM + u.inputCached * p.cachedInputPerM + u.output * p.outputPerM) / 1_000_000;
}

// Cache hit rate over input tokens, 0..1. The single most useful number for
// spotting a silent cache break: if it drops, you are paying full price for a
// prefix that should have been free.
export function cacheHitRate(u: Usage): number {
  const input = u.inputUncached + u.inputCached;
  return input === 0 ? 0 : u.inputCached / input;
}

// The process-wide meter. The loop records into it from every stream; the CLI
// builds it once (with the configured prices) and /cost reads it. A module
// singleton because metering is ambient — threading it through every call would
// add noise for a cross-cutting concern. Tests construct their own CostMeter.
let sessionMeter: CostMeter | null = null;
export function initCostMeter(pricing: Pricing): CostMeter {
  sessionMeter = new CostMeter(pricing);
  return sessionMeter;
}
export function recordUsage(usage: Record<string, unknown> | undefined | null): void {
  sessionMeter?.record(usage); // no-op until the CLI initializes it (tests stay silent)
}

// Accumulates usage across a session and formats /cost.
export class CostMeter {
  private total: Usage = { inputUncached: 0, inputCached: 0, output: 0 };
  private calls = 0; // how many model calls were metered

  constructor(private pricing: Pricing) {}

  // Fold one response's usage into the running total.
  record(usage: Record<string, unknown> | undefined | null): void {
    const u = normalizeUsage(usage);
    if (u.inputUncached + u.inputCached + u.output === 0) return; // a chunk with no usage — ignore
    this.total.inputUncached += u.inputUncached;
    this.total.inputCached += u.inputCached;
    this.total.output += u.output;
    this.calls++;
  }

  // The /cost report. Estimated, local-only.
  report(): string {
    const t = this.total;
    const input = t.inputUncached + t.inputCached;
    return [
      `tokens this session (${this.calls} model calls):`,
      `  input:  ${input} (${t.inputCached} cached, ${(cacheHitRate(t) * 100).toFixed(0)}% hit rate)`,
      `  output: ${t.output}`,
      `  estimated cost: $${costOf(t, this.pricing).toFixed(4)} (rough — prices set in settings.pricing)`,
    ].join("\n");
  }
}

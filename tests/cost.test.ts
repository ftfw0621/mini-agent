import { normalizeUsage, costOf, cacheHitRate, CostMeter, type Pricing } from "../src/cost.js"; // units under test
import { check, checkContains, finish } from "./helpers.js"; // assertions

const PRICES: Pricing = { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 5 }; // round numbers for easy math

// ---- normalize: DeepSeek shape (explicit hit/miss split) -------------------------------
const ds = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 });
check("deepseek: uncached = miss", ds.inputUncached === 200);
check("deepseek: cached = hit", ds.inputCached === 800);
check("deepseek: output", ds.output === 200);

// ---- normalize: OpenAI shape (only cached_tokens, nested) ------------------------------
const oa = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } });
check("openai: uncached = prompt - cached", oa.inputUncached === 400);
check("openai: cached from details", oa.inputCached === 600);

// ---- normalize: missing / empty is zero, never NaN ------------------------------------
const z = normalizeUsage(undefined);
check("undefined usage → all zero", z.inputUncached === 0 && z.inputCached === 0 && z.output === 0);
const bare = normalizeUsage({ prompt_tokens: 500, completion_tokens: 100 }); // no cache info at all
check("no cache info → all input uncached", bare.inputUncached === 500 && bare.inputCached === 0);

// ---- cost math -------------------------------------------------------------------------
// 200 uncached*1 + 800 cached*0.1 + 200 output*5 = 200 + 80 + 1000 = 1280 per million
check("costOf is correct", Math.abs(costOf(ds, PRICES) - 1280 / 1_000_000) < 1e-12, String(costOf(ds, PRICES)));
check("zero usage costs nothing", costOf(z, PRICES) === 0);

// ---- cache hit rate -------------------------------------------------------------------
check("hit rate 800/1000 = 0.8", Math.abs(cacheHitRate(ds) - 0.8) < 1e-12);
check("no input → hit rate 0 (no NaN)", cacheHitRate(z) === 0);

// ---- the meter accumulates across calls -----------------------------------------------
const meter = new CostMeter(PRICES);
meter.record({ prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 });
meter.record({ prompt_tokens: 500, completion_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 500 });
const report = meter.report();
checkContains("report counts both calls", report, "2 model calls");
checkContains("report shows combined input", report, "input:  1500");
checkContains("report shows combined output", report, "output: 300");
checkContains("report shows a hit rate", report, "% hit rate");
meter.record(undefined); // a usage-less chunk must not count as a call
checkContains("usage-less chunk ignored", meter.report(), "2 model calls");

finish();

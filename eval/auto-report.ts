import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Auto-mode measurement from LOCAL telemetry — no API requests. Real sessions
// only: tests and evals never arm telemetry. Answers "how often does auto mode
// interrupt me, why, and at what latency", so policy changes are compared by
// numbers instead of a handful of remembered examples.
//
//   npx tsx eval/auto-report.ts [--since=2026-09-23] [--file=.mini-agent/telemetry.jsonl]
//
// Labels come from the human's answer to an "ask" (agent_auto_human):
// approved ≈ false block, declined ≈ correct block. They are weak labels —
// people approve out of fatigue too — so review a sample before trusting them.

type Event = Record<string, string | number> & { ts: string; session: string; event: string };
const MAX_STATE_BYTES = 24_000; // mirror of src/auto.ts: above it, review is skipped for a human prompt

const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : "n/a";
// Wilson 95% interval: small samples are the normal case here, and a bare
// "3/12 = 25%" hides that the truth could be anywhere from 9% to 53%.
function wilson(n: number, d: number): string {
  if (!d) return "";
  const z = 1.96, p = n / d, den = 1 + z * z / d;
  const mid = (p + z * z / (2 * d)) / den, half = z * Math.sqrt(p * (1 - p) / d + z * z / (4 * d * d)) / den;
  return ` [95% CI ${(100 * Math.max(0, mid - half)).toFixed(0)}–${(100 * Math.min(1, mid + half)).toFixed(0)}%]`;
}
function quantile(values: number[], q: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
const tally = (items: string[]) => [...items.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);

export interface AutoReport {
  sessions: number; toolCalls: number; reviews: number; instrumented: number;
  verdicts: Record<string, number>;
  humans: Record<string, number>;
  unanswered: number;
  cliffs: { stateTooLarge: number; historyTruncated: number };
  routes: [string, number][];
  askTools: [string, number][];
  latency: { backend: string; n: number; p50?: number; p95?: number }[];
}

export function summarize(events: Event[]): AutoReport {
  const verdicts = events.filter((e) => e.event === "agent_auto_verdict");
  // Only sessions where auto review actually ran; manual-mode sessions would
  // dilute every per-call rate.
  const sessions = new Set(verdicts.map((e) => e.session));
  const toolCalls = events.filter((e) => e.event === "agent_tool_call" && sessions.has(e.session)).length;
  const humans = events.filter((e) => e.event === "agent_auto_human");
  const answered = new Set(humans.map((e) => String(e.reviewId)));
  // Events written before reviewId/stateBytes existed still count as verdicts
  // but cannot contribute to joins or cliff counts.
  const instrumented = verdicts.filter((e) => e.reviewId !== undefined && e.stateBytes !== undefined);
  const asks = verdicts.filter((e) => e.verdict === "ask");
  // Latency of actual provider reviews; preconditions (e.g. the size cliff) and failures never waited on one.
  const reviewed = verdicts.filter((e) => typeof e.durationMs === "number" && e.outcome !== "precondition" && e.outcome !== "unavailable" && e.route !== "none");
  return {
    sessions: sessions.size, toolCalls, reviews: verdicts.length, instrumented: instrumented.length,
    verdicts: Object.fromEntries(tally(verdicts.map((e) => String(e.verdict)))),
    humans: Object.fromEntries(tally(humans.map((e) => String(e.decision)))),
    // An ask with no recorded answer: interrupted, or logged before linking existed.
    unanswered: asks.filter((e) => e.reviewId !== undefined && !answered.has(String(e.reviewId))).length,
    cliffs: {
      stateTooLarge: instrumented.filter((e) => Number(e.stateBytes) > MAX_STATE_BYTES).length,
      historyTruncated: instrumented.filter((e) => Number(e.omittedActions) > 0).length,
    },
    routes: tally(verdicts.filter((e) => e.route !== undefined).map((e) => String(e.route))),
    askTools: tally(asks.map((e) => String(e.tool))),
    latency: tally(reviewed.map((e) => String(e.backend ?? "none"))).map(([backend]) => {
      const values = reviewed.filter((e) => String(e.backend ?? "none") === backend).map((e) => Number(e.durationMs));
      return { backend, n: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95) };
    }),
  };
}

export function render(r: AutoReport): string {
  const asks = r.verdicts.ask ?? 0;
  const interruptions = (r.humans.approved ?? 0) + (r.humans.declined ?? 0);
  const lines = [
    `Auto-mode report — ${r.sessions} session(s), ${r.toolCalls} tool calls, ${r.reviews} reviews (${r.instrumented} with full instrumentation)`,
    "",
    `Reviewed calls:      ${pct(r.reviews, r.toolCalls)} of tool calls went to a reviewer`,
    `Verdicts:            ${Object.entries(r.verdicts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `Ask rate:            ${pct(asks, r.reviews)} of reviews${wilson(asks, r.reviews)}`,
    `Human interruptions: ${interruptions} → ${r.toolCalls ? (100 * interruptions / r.toolCalls).toFixed(1) : "n/a"} per 100 tool calls`,
    ...(r.instrumented < r.reviews ? [`(${r.reviews - r.instrumented} older reviews predate reviewId/size fields: they count in rates, not in joins or cliffs)`] : []),
    `Human answers:       approved ${r.humans.approved ?? 0} (likely false block), declined ${r.humans.declined ?? 0}, unattended ${r.humans.unattended ?? 0}, unanswered ${r.unanswered}`,
    `Likely false blocks: ${pct(r.humans.approved ?? 0, interruptions)} of answered asks${wilson(r.humans.approved ?? 0, interruptions)}`,
    "",
    `Cliff: state > ${MAX_STATE_BYTES / 1000}KB → forced ask:        ${r.cliffs.stateTooLarge} of ${r.instrumented}`,
    `Cliff: history truncated (Jev pass off): ${r.cliffs.historyTruncated} of ${r.instrumented}`,
  ];
  if (r.routes.length) lines.push(`Rules routing:       ${r.routes.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (r.askTools.length) lines.push(`Asks by tool:        ${r.askTools.slice(0, 8).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  lines.push("", "Review latency (ms):");
  for (const l of r.latency) lines.push(`  ${l.backend.padEnd(8)} n=${l.n}  p50=${l.p50 ?? "-"}  p95=${l.p95 ?? "-"}`);
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const file = option("file") ?? path.resolve(".mini-agent", "telemetry.jsonl");
  const since = option("since");
  if (argv.some((a) => !/^--(file|since)=/.test(a)) || (since && Number.isNaN(Date.parse(since)))) throw new Error("Usage: [--since=ISO-date] [--file=telemetry.jsonl]");
  const events = fs.readFileSync(file, "utf8").split("\n").flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line) as Event] : []; } catch { return []; } // a torn last line is not fatal
  }).filter((e) => !since || e.ts >= new Date(since).toISOString());
  console.log(render(summarize(events)));
}

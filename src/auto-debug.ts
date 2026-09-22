import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { emit } from "./telemetry.js";

// Explicit opt-in: unlike telemetry, this contains conversation and tool data.
export function reviewDebugPath(): string | undefined {
  return process.env.MINI_AGENT_REVIEW_DEBUG === "1"
    ? path.resolve(".mini-agent", "review-debug.jsonl") : undefined;
}

// Shared by both frontends. This controls tracing only, never permission mode.
export function reviewDebugCommand(line: string): string | null {
  if (!/^\/auto\s+debug(?:\s|$)/.test(line)) return null;
  const action = line.trim().split(/\s+/).slice(2).join(" ");
  if (action === "on") process.env.MINI_AGENT_REVIEW_DEBUG = "1";
  else if (action === "off") process.env.MINI_AGENT_REVIEW_DEBUG = "0";
  else if (action && action !== "status") return "Usage: /auto debug [on|off|status]";
  const file = reviewDebugPath();
  return file ? `Review debug ON — ${file}\nRecords actual requests and replies for future reviews; local conversation/tool data, known credentials redacted.`
    : "Review debug OFF — use /auto debug on to capture future review requests and replies.";
}

// Headers are deliberately never accepted here. Redact known credential values
// even when they appear in free-form text; arbitrary tool payloads can still be
// sensitive, so this log must remain local and opt-in.
export function beginReviewDebug(backend: string, request: unknown, secrets: string[] = [], reviewId?: string): (event: string, fields: Record<string, unknown>) => void {
  const file = reviewDebugPath();
  if (!file) return () => {};
  const credentials = [...secrets, ...Object.entries(process.env)
    .filter(([key]) => /(?:API_KEY|TOKEN|PASSWORD|SECRET)$/.test(key))
    .map(([, value]) => value ?? "")].filter(Boolean).sort((a, b) => b.length - a.length);
  const id = reviewId ?? randomUUID();
  const started = Date.now();
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      const text = credentials.reduce((text, secret) => text.split(secret).join("<REDACTED>"), value);
      // Providers also carry JSON inside message strings and raw HTTP bodies.
      if (/^\s*[\[{]/.test(text)) {
        try {
          const parsed: unknown = JSON.parse(text);
          const clean = redact(parsed);
          if (JSON.stringify(parsed) !== JSON.stringify(clean)) return JSON.stringify(clean);
        } catch { /* preserve non-JSON text for diagnosis */ }
      }
      return text;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i.test(key) ? "<REDACTED>" : redact(item)]));
    return value;
  };
  const record = (event: string, fields: Record<string, unknown>) => {
    try {
      const line = JSON.stringify(redact({ ts: new Date().toISOString(), pid: process.pid, id, backend, event, durationMs: Date.now() - started, ...fields })) + "\n";
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, line); } finally { fs.closeSync(fd); }
    } catch {
      // Diagnostics must never change an approval or interrupt execution.
      emit("agent_auto_debug_unavailable");
    }
  };
  record("request", { request });
  return record;
}

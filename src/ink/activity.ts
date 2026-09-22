import { stripVTControlCharacters } from "node:util";
import wrapAnsi from "wrap-ansi";
import type { ToolCallRecord } from "../tui.js";
import { formatElapsed } from "../ui.js";

export interface ActivitySummary { title: string; detail: string; running: boolean; failed: boolean }

function plain(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
function oneLine(text: string): string { return plain(text).replace(/\s+/g, " ").trim().slice(0, 180); }

function title(call: ToolCallRecord): string {
  const labels: Record<string, string> = {
    read_file: "Read", search: "Search", run_bash: "Run", run_bash_background: "Start background task",
    bash_output: "Check background task", write_file: "Write", edit_file: "Edit",
  };
  let target = "";
  try {
    const args = JSON.parse(call.args ?? "{}");
    target = [call.name === "search" ? args.pattern : undefined, args.path, args.command, args.task_id].find((v) => typeof v === "string") ?? "";
  } catch { /* malformed input is shown in full in the details */ }
  return oneLine(`${labels[call.name ?? ""] ?? call.name ?? "Tool"}${target ? ` (${target})` : ""}`);
}

// Consecutive calls of the same type share one card. Polling 100 times still
// takes two lines; only the most recent groups occupy the transient viewport.
export function summarizeActivity(calls: readonly ToolCallRecord[], now = Date.now(), limit = 2): ActivitySummary[] {
  const groups: ToolCallRecord[][] = [];
  for (const call of calls) {
    const previous = groups.at(-1);
    if (previous && previous[0].name === call.name) previous.push(call);
    else groups.push([call]);
  }
  return groups.slice(-limit).map((group) => {
    const last = group.at(-1)!;
    const running = group.some((c) => c.endedAt === undefined);
    const failed = group.some((c) => /^\[(?:error|permission|hook)\]/.test(c.result ?? ""));
    const completed = group.filter((c) => c.endedAt !== undefined).length;
    const duration = formatElapsed((running ? now : Math.max(...group.map((c) => c.endedAt!))) - group[0].startedAt);
    let result = last.result === undefined ? "In progress" : "Completed";
    if (last.result !== undefined) {
      if (/^\[(?:error|permission|hook)\]/.test(last.result)) result = oneLine(last.result);
      else if (last.name === "read_file") result = `Read ${last.result === "(empty file)" ? 0 : last.result.split("\n").length} lines`;
      else if (last.name === "search") result = last.result.startsWith("No matches.") ? "No matches" : `Found ${last.result.split("\n").filter((line) => /:\d+:/.test(line)).length} matches`;
      else result = oneLine(last.result.split("\n")[0]) || "Completed (no output)";
    }
    const count = group.length > 1 ? `${completed}/${group.length} calls · ` : "";
    return { title: title(last), detail: `${count}${result} · ${duration}${failed ? " · needs attention" : ""}`, running, failed };
  });
}

// Page from the end so opening a trace shows the latest action. Wrapping before
// slicing bounds physical terminal rows, including CJK and long JSON strings.
export function detailPage(text: string, page: number, rows: number, columns: number): { text: string; page: number; pages: number } {
  const height = Math.max(1, rows);
  const lines = wrapAnsi(plain(text), Math.max(1, columns), { hard: true, trim: false }).split("\n");
  const pages = Math.max(1, Math.ceil(lines.length / height));
  const selected = Math.max(0, Math.min(page, pages - 1));
  const end = lines.length - selected * height;
  return { text: lines.slice(Math.max(0, end - height), end).join("\n"), page: selected, pages };
}

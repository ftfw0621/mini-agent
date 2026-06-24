// Terminal UI helpers that need state or the filesystem: the git branch for the
// status line, and collapsible tool output. The pure formatting (status line,
// spinner) lives in ui.ts; this is the side-effecting half.
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";

// ---- git branch for the status line -----------------------------------------
// Walk up from the cwd to the nearest .git and read HEAD. A branch name, a short
// detached SHA, or null if this isn't a repo. Never throws.
export function gitBranch(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 40; i++) {
    try {
      const gitPath = path.join(dir, ".git");
      const stat = fs.statSync(gitPath);
      let headFile = path.join(gitPath, "HEAD");
      if (stat.isFile()) {
        // A worktree: .git is a file "gitdir: <path>" pointing elsewhere.
        const gitdir = fs.readFileSync(gitPath, "utf8").replace(/^gitdir:\s*/, "").trim();
        headFile = path.join(path.resolve(dir, gitdir), "HEAD");
      }
      const head = fs.readFileSync(headFile, "utf8").trim();
      const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      return m ? m[1] : head.slice(0, 7); // branch name, or a short detached SHA
    } catch {
      /* not a repo here — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return null;
}

// ---- collapsible tool output -------------------------------------------------
// Tool calls used to print a line each (recordToolCall folds them into a tally
// now — see below), but their full args are still stashed here so Tab can expand
// the most recent one.
interface CollapsedBlock {
  full: string;
  expanded: boolean;
}
const collapsed: CollapsedBlock[] = [];
const MAX_COLLAPSED = 50; // bound the memory — old blocks fall off

// Tab handler: reveal (or re-hide) the full text of the most recent tool block.
// Returns false if there's nothing to toggle.
export function toggleLastCollapsed(): boolean {
  const block = collapsed[collapsed.length - 1];
  if (!block) return false;
  block.expanded = !block.expanded;
  if (block.expanded) {
    process.stdout.write(chalk.dim(block.full.replace(/^/gm, "  ⎿ ")) + "\n");
    process.stdout.write(chalk.dim("  (Tab to collapse)\n"));
  } else {
    process.stdout.write(chalk.dim("  (collapsed)\n"));
  }
  return true;
}

// ---- collapsed reasoning (the model's thinking) ------------------------------
// Reasoning models (deepseek-reasoner / R1) stream a long thinking trace before
// the answer. Dumping it all to the screen buries the actual reply, so we hide
// it behind a spinner and a one-line indicator, keeping the trace here for the
// user to reveal with Ctrl+R (handled by the line editor, like Tab for tools).
// Stored as one entry per model round; cleared when a new user turn begins, so
// Ctrl+R always shows the thinking behind the LAST answer.
const reasoningTrace: string[] = [];

export function recordReasoning(text: string): void {
  const t = text.trim();
  if (t) reasoningTrace.push(t);
}

// Drop the current turn's thinking. Called when a new prompt is submitted (the
// old thinking belonged to the old answer) and on /clear.
export function clearReasoning(): void {
  reasoningTrace.length = 0;
}

// Ctrl+R handler: print the stored thinking for the last answer, dimmed and
// nested. Returns false (nothing to show) so the editor can ignore the key.
export function revealReasoning(): boolean {
  if (!reasoningTrace.length) return false;
  process.stdout.write(chalk.dim("💭 model's thinking:\n"));
  process.stdout.write(chalk.dim(reasoningTrace.join("\n\n— — —\n\n").replace(/^/gm, "  ")) + "\n");
  return true;
}

// ---- collapsed tool calls (the activity trace) -------------------------------
// A long task fires dozens of read_file/search calls; printing one line each
// floods the screen. Instead the loop prints a compact per-round tally and we
// keep the full call lines here for Ctrl+T to reveal. Cleared per turn, so
// Ctrl+T shows the calls behind the LAST answer. (Diffs, prompts, and results
// still print live — only the one-line announcements are folded.)
const toolCallLog: string[] = [];
const MAX_TOOL_LOG = 500; // bound the memory

// Record a tool call's full line for Ctrl+T, and stash its args for Tab.
export function recordToolCall(line: string, full: string): void {
  toolCallLog.push(line);
  if (toolCallLog.length > MAX_TOOL_LOG) toolCallLog.shift();
  collapsed.push({ full, expanded: false }); // Tab still reveals the most recent call's full args
  if (collapsed.length > MAX_COLLAPSED) collapsed.shift();
}

export function clearToolCalls(): void {
  toolCallLog.length = 0;
}

// Ctrl+T handler: print every tool call behind the last answer. Returns false
// (nothing to show) so the editor can ignore the key.
export function revealToolCalls(): boolean {
  if (!toolCallLog.length) return false;
  process.stdout.write(chalk.dim(`tool calls this turn (${toolCallLog.length}):\n`));
  process.stdout.write(toolCallLog.join("\n") + "\n");
  return true;
}

// ---- cleanup -----------------------------------------------------------------
// Called on exit. Nothing fancy to restore now (we no longer hijack the bottom
// of the screen), but keep the hook so callers don't have to change if that
// changes again.
export function cleanup(): void {
  process.stdout.write("\n");
}

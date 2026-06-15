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
// Tool results can be verbose. By default we print only a one-line summary; the
// full args/output are remembered so Tab can expand the most recent block.
interface CollapsedBlock {
  full: string;
  expanded: boolean;
}
const collapsed: CollapsedBlock[] = [];
const MAX_COLLAPSED = 50; // bound the memory — old blocks fall off

// Print the one-line summary now; stash the full text for Tab to reveal later.
export function printToolSummary(summary: string, full: string): void {
  process.stdout.write(summary + "\n");
  collapsed.push({ full, expanded: false });
  if (collapsed.length > MAX_COLLAPSED) collapsed.shift();
}

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

// ---- cleanup -----------------------------------------------------------------
// Called on exit. Nothing fancy to restore now (we no longer hijack the bottom
// of the screen), but keep the hook so callers don't have to change if that
// changes again.
export function cleanup(): void {
  process.stdout.write("\n");
}

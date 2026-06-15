// Terminal UI helpers: bottom-anchored prompt area and collapsible tool output.
import chalk from "chalk";

// ---- bottom prompt ----------------------------------------------------------
// Between turns we always redraw the prompt at the terminal's bottom so the
// user never has to hunt for where to type. During model output the prompt may
// scroll away, but it's immediately restored afterwards.

export function termHeight(): number {
  return process.stdout.rows || 24;
}
function frameW(): number {
  return Math.max(8, Math.min(process.stdout.columns || 80, 100) - 1);
}

// Move cursor to the bottom line and clear it.
function moveToPromptLine(): void {
  process.stdout.write(`\x1b[${termHeight()};1H\x1b[K`);
}

// Move cursor up N lines.
function moveUp(n: number): void {
  process.stdout.write(`\x1b[${n}A`);
}

// Draw the separator + prompt at the bottom of the terminal.
export function drawBottomPrompt(): void {
  const h = termHeight();
  const w = frameW();
  process.stdout.write(`\x1b[${h - 1};1H\x1b[K`); // clear separator line
  process.stdout.write(chalk.dim("─".repeat(w)));
  moveToPromptLine();
}

// After the user submits their input, redraw it as a framed box in the
// output area (above the bottom separator), then restore the bottom prompt.
export function frameInputAndRestore(line: string, planMode: boolean): void {
  const h = termHeight();
  const w = frameW();
  const prefix = planMode ? "⏸ plan ❯ " : "❯ ";
  const maxDisplay = w - 2; // 2 chars padding inside box
  let display = prefix + line;
  if (display.length > maxDisplay) display = display.slice(0, maxDisplay - 3) + "...";
  const pStyle = planMode ? chalk.yellow.bold : chalk.cyan.bold;
  const pad = Math.max(0, w - display.length);

  // Clear the readline prompt line (it sits at the bottom) and draw the box
  // just above the separator area.
  moveToPromptLine();
  process.stdout.write("\x1b[K"); // clear the prompt line
  moveUp(1);
  process.stdout.write("\x1b[K"); // clear the separator line

  // Print framed box at current position (just cleared).
  process.stdout.write(
    chalk.dim(`┌${"─".repeat(w)}┐\n`) +
      chalk.dim("│ ") + pStyle(prefix) + chalk.reset(line.slice(0, maxDisplay - (prefix.length) - 3 > 0 ? maxDisplay - (prefix.length) - 3 : undefined)) + (line.length > maxDisplay - (prefix.length) ? "..." : "") + " ".repeat(Math.max(0, w - display.length)) + chalk.dim(" │\n") +
      chalk.dim(`└${"─".repeat(w)}┘\n`),
  );

  // Redraw bottom separator + prompt for next turn.
  drawBottomPrompt();
}

// ---- collapsible tool output -------------------------------------------------
// Tool results can be verbose. By default only a one-line summary is printed;
// Tab toggles expand/collapse on the most recent block.

interface CollapsedBlock {
  summary: string;
  full: string;
  expanded: boolean;
}
const collapsed: CollapsedBlock[] = [];
const MAX_COLLAPSED = 50;

export function printToolSummary(summary: string, full: string): void {
  process.stdout.write(summary + "\n");
  collapsed.push({ summary, full, expanded: false });
  if (collapsed.length > MAX_COLLAPSED) collapsed.shift();
}

export function toggleLastCollapsed(): boolean {
  if (!collapsed.length) return false;
  const block = collapsed[collapsed.length - 1];
  if (block.expanded) {
    process.stdout.write(chalk.dim("  ⎿ collapsed — Tab to expand\n"));
    block.expanded = false;
  } else {
    process.stdout.write(chalk.dim(block.full) + "\n");
    process.stdout.write(chalk.dim("  ⎿ expanded — Tab to collapse\n"));
    block.expanded = true;
  }
  return true;
}

// ---- cleanup -----------------------------------------------------------------
export function cleanup(): void {
  process.stdout.write("\n");
}

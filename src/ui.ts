import chalk from "chalk"; // the one place color lives

// The app's visual theme, in one place. Before this, emoji and colors were
// sprinkled across agent.ts and loop.ts — no coherent look, and impossible to
// restyle without hunting. This module owns "what the tool looks like": the
// welcome box, the prompt, the activity markers, the spinner. Still no TUI
// framework — we print line by line — just with one consistent vocabulary.
//
// Glyphs over emoji: ⏺ (an action or answer), ⎿ (a nested detail), ❯ (the
// prompt). They're width-1 in terminals (emoji like 🔧 are width-2 and break
// alignment), and they read as "a real tool" rather than "a toy".

// Draw a rounded box around plain-text lines. Width is measured on the PLAIN
// text, so callers pass plain strings; an optional per-line style wraps the
// already-padded cell (ANSI sits outside the padding, so alignment survives).
// Keep box content ASCII-ish — String.length miscounts CJK/emoji width.
function box(lines: { text: string; style?: (s: string) => string }[]): string {
  const width = Math.max(...lines.map((l) => l.text.length));
  const top = chalk.dim(`╭${"─".repeat(width + 2)}╮`);
  const bottom = chalk.dim(`╰${"─".repeat(width + 2)}╯`);
  const body = lines.map((l) => {
    const cell = l.text.padEnd(width); // pad the plain text to a uniform width
    return chalk.dim("│ ") + (l.style ? l.style(cell) : cell) + chalk.dim(" │"); // style wraps the padded cell
  });
  return [top, ...body, bottom].join("\n");
}

// The welcome banner, shown once at startup.
export function banner(version: string, model: string, host: string): string {
  return box([
    { text: `mini-agent  v${version}`, style: chalk.bold.cyan },
    { text: `${model}  ·  ${host}`, style: chalk.dim },
    { text: "" },
    { text: "/help  commands     @file  attach a file     Ctrl+C  interrupt", style: chalk.dim },
  ]);
}

// The input prompt. A styled chevron, not a bare ">". Plan mode (Day 20) gets a
// distinct marker so you always know writes are blocked.
export function promptString(planMode: boolean): string {
  return planMode ? chalk.yellow.bold("\n⏸ plan ❯ ") : chalk.cyan.bold("\n❯ ");
}

// The activity log vocabulary. ⏺ marks a thing happening, ⎿ marks a detail
// hanging off it. Indentation/nesting is the caller's job (it knows sub-agent
// depth), so these are just the styled pieces.
export const mark = {
  tool: (name: string, args: string) => chalk.cyan("⏺ ") + chalk.bold(name) + (args ? chalk.dim(` ${args}`) : ""),
  answer: chalk.green("⏺ "), // prefix for the model's streamed answer
  denied: (reason: string) => chalk.red("  ⎿ ") + chalk.red(`denied — ${reason}`),
  declined: chalk.yellow("  ⎿ declined"),
  judge: chalk.dim("  ⎿ judge: clearly safe, auto-allowed"),
  hookBlock: (event: string) => chalk.red(`  ⎿ blocked by ${event} hook`),
  subAgentStart: (desc: string, tier: string) =>
    chalk.blue("  ⎿ sub-agent") + (tier ? chalk.dim(` [${tier}]`) : "") + chalk.blue(`: ${desc}`),
  subAgentDone: chalk.blue("  ⎿ sub-agent done"),
  note: (s: string) => chalk.dim(s), // dim asides (resumed, attached, cleared…)
  warn: (s: string) => chalk.yellow(s),
};

// Playful "thinking" words, cycled while waiting for the first token — the same
// touch Claude Code uses so a wait feels alive, not frozen.
const WORDS = ["Thinking", "Pondering", "Cogitating", "Reasoning", "Working", "Scheming", "Brewing", "Crunching", "Mulling", "Noodling"];

// Pick a word by a seed (a call counter) rather than Math.random — deterministic,
// testable, and still varies turn to turn.
export function thinkingWord(seed: number): string {
  return WORDS[((seed % WORDS.length) + WORDS.length) % WORDS.length];
}

// The live spinner text: the model (so you can SEE which one is answering — proof
// a /model switch took effect) + a thinking word + elapsed seconds + how to bail.
export function spinnerText(word: string, elapsedSec: number, subAgent: boolean, model?: string): string {
  const head = subAgent ? "sub-agent" : word;
  const tag = model && !subAgent ? chalk.dim(`${model} · `) : ""; // show the model on top-level calls
  return `${tag}${head}… ${chalk.dim(`(${elapsedSec}s · Ctrl+C to interrupt)`)}`;
}

// ---- the input area ---------------------------------------------------------
// Like Claude Code: two horizontal rules (top + bottom) with the user's input
// between them. Long input is truncated to keep the box compact.
function frameWidth(): number {
  return Math.max(8, Math.min(process.stdout.columns || 80, 100) - 1); // fit the terminal, but cap the rule
}
export function inputRule(): string {
  return chalk.dim("─".repeat(frameWidth())); // a plain separator line
}
// The prompt under the rule. Plan mode (Day 20) is marked so you know writes are blocked.
export function framedPrompt(planMode: boolean): string {
  return planMode ? chalk.yellow.bold("⏸ plan ❯ ") : chalk.cyan.bold("❯ ");
}

// After the user hits Enter, redraw their input between two rules.
// Long lines are replaced with a short placeholder so the output stays readable.
const MAX_INPUT_DISPLAY = 76; // before truncation
export function frameUserInput(line: string, planMode: boolean): string {
  const prefix = planMode ? "⏸ plan ❯ " : "❯ ";
  const prefixLen = planMode ? 10 : 2; // approximate visual width of the prefix
  const available = frameWidth() - 2 - prefixLen; // box padding + prefix
  let display = line;
  if (display.length > available) {
    display = display.slice(0, available - 3) + "..."; // truncate with ellipsis
  }
  const rule = chalk.dim("─".repeat(frameWidth()));
  const promptStyle = planMode ? chalk.yellow.bold : chalk.cyan.bold;
  return (
    chalk.dim(`\x1b[2K\r┌${"─".repeat(frameWidth())}┐\n`) +
    chalk.dim("│ ") + promptStyle(prefix) + chalk.reset(display) + chalk.dim(" │\n") +
    chalk.dim(`└${"─".repeat(frameWidth())}┘`)
  );
}

// ---- the selection menu -----------------------------------------------------
// Render a numbered list of options with one highlighted. The interactive part
// (raw-mode arrow keys) lives in menu.ts; this is just the pure drawing, so it's
// testable. Selecting beats typing: an approval is one keystroke, not "type y/N".
// Numbered so the user can also see "option 2" at a glance, like Claude Code.
export function renderMenu(options: string[], selected: number): string {
  return options
    .map((o, i) => {
      const label = `${i + 1}. ${o}`;
      return i === selected ? chalk.cyan.bold(`❯ ${label}`) : chalk.dim(`  ${label}`);
    })
    .join("\n");
}

// The hint line under a menu — how to drive it.
export const MENU_HINT = chalk.dim("↑↓ to move · Enter to select · Esc to cancel");

// Label a model list for the picker, marking the one in use. Pure, so the "which
// is current" logic is testable without hitting the network for the list.
export function formatModelChoices(models: string[], current: string): string[] {
  return models.map((m) => (m === current ? `${m}  (current)` : m));
}

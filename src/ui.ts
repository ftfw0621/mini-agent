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

// The live spinner text: word + elapsed seconds + how to bail out.
export function spinnerText(word: string, elapsedSec: number, subAgent: boolean): string {
  const head = subAgent ? "sub-agent" : word;
  return `${head}… ${chalk.dim(`(${elapsedSec}s · Ctrl+C to interrupt)`)}`;
}

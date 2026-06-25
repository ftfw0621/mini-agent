import chalk from "chalk";
import path from "node:path";
import { CONFIG } from "../config.js";
import { statsReport } from "../telemetry.js";
import { readMemoryTyped, MEMORY_PATH } from "../memory.js";
import { getTodos, renderTodos } from "../todos.js";
import { listBackground } from "../background.js";
import { listTeam } from "../team.js";
import { boardSummary } from "../board.js";
import { undoLast, sessionChanges } from "../undo.js";
import { renderDiff } from "../diff.js";
import type { CostMeter } from "../cost.js";
import type { Skill } from "../skills.js";

// The non-interactive slash commands: each produces a block of text to commit as
// a note. Lifted from agent.ts's handleCommand, with console.log → a returned
// string so the Ink REPL can render them inside its tree. The stateful commands
// (/clear, /compact, /plan, /model, /resume, /skill) stay in the App — they
// mutate the conversation or pop an interactive menu.

// The in-session command reference shown by /help.
export const SESSION_HELP = `commands:
  /help      this text
  /clear     wipe the conversation (and the file read-state) — fresh start
  /compact   compact the history into a summary right now (happens automatically near the limit)
  /model     switch model for THIS session: "/model" to pick from a list, "/model <name>" to set; "/model save <name>" to make it your default
  /stats     event counts for this session (local telemetry — nothing leaves this machine)
  /memory    show the durable facts the agent remembers about this project
  /cost      tokens, cache hit rate and estimated spend this session (local)
  /plan      toggle plan mode — research-only; the agent presents a plan you approve before any change
  /todos     show the agent's current task plan (it maintains one with todo_write on multi-step work)
  /bg        list background tasks this session (run_bash_background) and their status
  /team      list the agent team (spawn_teammate): each teammate's role, status, and pending inbox
  /tasks     show the shared task board (create_task/claim_task): each task's status, owner, and dependencies
  /undo      revert the most recent file write (write_file / edit_file) this session
  /diff      show every file changed this session, as a diff from where it started
  /resume    list recent sessions in this project and continue one of them
  /skills    list the reusable skills available in this project
  /skill <name>  run a skill yourself (works even for user-only skills)
  exit       leave (Ctrl+C does the same)

keys (at the prompt):
  Ctrl+R     reveal the model's thinking for the last answer (collapsed behind a spinner by default)
  Ctrl+T     reveal the folded tool-call trace for the last answer`;

// Run a non-interactive command. Returns the note text to display, or null if
// `line` isn't one of these (the App handles the rest).
export function runInfoCommand(line: string, ctx: { skills: Skill[]; costMeter: CostMeter }): string | null {
  switch (line) {
    case "/help":
      return chalk.dim(SESSION_HELP);

    case "/cost":
      return chalk.dim(ctx.costMeter.report()); // tokens, cache hit rate, estimated spend (local)

    case "/stats":
      return chalk.dim(statsReport()); // local counters, busiest first

    case "/memory": {
      const entries = readMemoryTyped();
      return chalk.dim(
        entries.length
          ? `long-term memory (${MEMORY_PATH}):\n${entries.map((e) => `  [${e.type}] ${e.fact}`).join("\n")}`
          : `(no long-term memory yet — the model saves facts with the remember tool${CONFIG.memory.autoExtract ? "" : "; turn on settings.memory.autoExtract to capture them automatically"})`,
      );
    }

    case "/todos": {
      const todos = getTodos();
      return todos.length ? renderTodos(todos) : chalk.dim("(no plan yet — the agent writes one with todo_write on multi-step tasks)");
    }

    case "/bg": {
      const bg = listBackground();
      if (!bg.length) return chalk.dim("(no background tasks — the agent starts them with run_bash_background for slow commands)");
      const icon = { running: chalk.yellow("●"), completed: chalk.green("✓"), failed: chalk.red("✗"), killed: chalk.dim("∅") };
      return chalk.dim("background tasks this session:\n") + bg.map((t) => chalk.dim(`  ${icon[t.status]} ${t.id} [${t.status}, ${t.elapsed}s] — ${t.command.slice(0, 70)}`)).join("\n");
    }

    case "/team": {
      const team = listTeam();
      if (!team.length) return chalk.dim("(no team — the agent forms one with spawn_teammate for large parallel tasks)");
      const icon: Record<string, string> = { active: chalk.yellow("●"), idle: chalk.cyan("◐"), done: chalk.green("✓"), failed: chalk.red("✗") };
      return (
        chalk.dim("agent team this session:\n") +
        team.map((t) => chalk.dim(`  ${icon[t.status] ?? "?"} ${t.name} [${t.status}, ${t.elapsed}s] — ${t.role.slice(0, 60)}${t.pending ? chalk.yellow(` · ${t.pending} unread`) : ""}`)).join("\n")
      );
    }

    case "/tasks": {
      const summary = boardSummary();
      return summary === "(the task board is empty)" ? chalk.dim("(no tasks — the lead adds them with create_task; teammates claim them autonomously)") : chalk.dim(`task board:\n${summary}`);
    }

    case "/skills": {
      if (!ctx.skills.length) return chalk.dim("(no skills — add one at .mini-agent/skills/<name>/SKILL.md or ~/.config/mini-agent/skills/)");
      return (
        chalk.dim("skills in this project:\n") +
        ctx.skills.map((s) => chalk.dim(`  ${s.name} [${s.disableModelInvocation ? chalk.yellow("user-only") : chalk.green("model+user")}${chalk.dim("]")} — ${(s.whenToUse || s.description).slice(0, 70)}`)).join("\n")
      );
    }

    case "/undo": {
      const undone = undoLast();
      if (!undone) return chalk.dim("(nothing to undo — no file writes recorded this session)");
      return chalk.dim(`↩ ${undone.summary}`) + "\n" + renderDiff(undone.after ?? "", undone.before ?? "");
    }

    case "/diff": {
      const changes = sessionChanges();
      if (!changes.length) return chalk.dim("(no file changes this session)");
      const verb = { created: chalk.green("created"), modified: chalk.yellow("modified"), deleted: chalk.red("deleted") };
      const head = chalk.dim(`${changes.length} file${changes.length === 1 ? "" : "s"} changed this session:`);
      return head + "\n" + changes.map((c) => `\n${verb[c.status]} ${path.relative(process.cwd(), c.path) || c.path}\n${renderDiff(c.baseline, c.current)}`).join("");
    }

    default:
      return null; // not an info command — the App handles it (or it's a normal task line)
  }
}

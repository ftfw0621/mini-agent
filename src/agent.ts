#!/usr/bin/env node
import OpenAI from "openai"; // the API client
import chalk from "chalk"; // terminal colors
import readline from "node:readline/promises"; // promise-based terminal input
import { createRequire } from "node:module"; // to read package.json for --version
import { CONFIG, requireApiKey, saveGlobalSetting, PROJECT_SETTINGS_PATH, GLOBAL_SETTINGS_PATH } from "./config.js"; // provider-agnostic settings (.env loaded there)
import { runLoop, TerminateReason, MAX_RETRIES, type LoopResult } from "./loop.js"; // the state machine
import { buildSystemMessage } from "./prompt.js"; // the constitution + optional AGENT.md project memory
import { forgetFilesExcept, registerExternalTool } from "./tools.js"; // file-state reset + tool registration
import { compactHistory, estimateHistoryTokens, COMPACT_AT } from "./context.js"; // for the manual /compact command
import { newSessionId, saveSession, latestSession, listSessions, loadSession } from "./session.js"; // conversation persistence (project-local) + the /resume picker
import { initTelemetry, emit, statsReport } from "./telemetry.js"; // local-only event log + /stats
import { runHooks } from "./hooks.js"; // SessionStart lifecycle hook
import { connectMcpServers } from "./mcp.js"; // external tool servers (MCP)
import { Judge } from "./judge.js"; // optional LLM permission classifier
import { isPlanMode, setPlanMode } from "./permissions.js"; // plan mode: research-only until the user approves a plan
import { undoLast, clearUndo, sessionChanges } from "./undo.js"; // /undo + /diff: take back, or review, this session's writes
import { clearTodos, getTodos, renderTodos } from "./todos.js"; // the agent's plan: /todos to view, cleared with the conversation
import { renderDiff } from "./diff.js"; // show what /undo put back / what /diff changed, reusing the Day 21 diff renderer
import path from "node:path"; // shorten paths for the /diff summary
import { expandMentions } from "./mentions.js"; // @file mentions: pull referenced files into context (secret files refused)
import { banner, framedPrompt, formatModelChoices, statusLine, inputRule } from "./ui.js"; // welcome box, prompt, model labels, status line
import { gitBranch, toggleLastCollapsed, revealReasoning, clearReasoning, cleanup as tuiCleanup } from "./tui.js"; // git branch for the status line + collapsible output + collapsed reasoning (Ctrl+R)
import { promptSelect, promptForm } from "./menu.js"; // arrow-key approval menu + multi-question form
import { editLine } from "./editor.js"; // our own line editor (keeps the status footer pinned even when input wraps)
import { normalizeDroppedPaths } from "./drop.js"; // drag-and-drop: a dropped file's path → a clean absolute path in the input
import { rememberTool, readMemory, readMemoryTyped, extractMemories, MEMORY_PATH } from "./memory.js"; // long-term project memory + auto-extract
import { loadSkills, buildSkillTool, findSkill, skillInstructions, type Skill } from "./skills.js"; // Markdown-as-plugin skills
import { initCostMeter, DEFAULT_PRICING } from "./cost.js"; // token & cost accounting for /cost
import { listBackground, hasRunningBackground, killAllBackground } from "./background.js"; // background tasks: /bg view + kill-on-exit (Day 37)
import { listTeam, resetTeam } from "./team.js"; // agent teams: /team view + reset on clear/resume (Day 38)
import { boardSummary, resetBoard } from "./board.js"; // task board: /tasks view + reset on clear/resume (Day 40)

// package.json sits one level above both src/ (dev) and dist/ (built) — same path either way.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

// ---- CLI arguments --------------------------------------------------------------
// Tiny by design: a help text, a version, and a one-shot print mode. Anything
// fancier belongs in settings files, not flags.
const USAGE = `mini-agent ${pkg.version} — a Claude Code-style CLI agent (any OpenAI-compatible model)

Usage:
  mini-agent                 interactive session (REPL)
  mini-agent -r | --resume   continue the most recent session in this directory
  mini-agent -p "<task>"     one-shot: run a single task, print the result, exit
  mini-agent -v | --version  print the version
  mini-agent -h | --help     this text

Configuration (optional):
  ${GLOBAL_SETTINGS_PATH}   your defaults (model, baseURL, permissions, hooks)
  ${PROJECT_SETTINGS_PATH}   per-project rules — both layers apply, deny always wins
  MINI_AGENT_API_KEY / MINI_AGENT_BASE_URL / MINI_AGENT_MODEL override everything.

In a session, type /help for the in-session commands.`;

// What we tell the user for every way a query can end. No raw stack traces.
const EXIT_NOTES: Record<Exclude<TerminateReason, TerminateReason.Done>, string> = {
  [TerminateReason.CircuitBreaker]: "3 API failures in a row — stopping here instead of burning money.",
  [TerminateReason.RetryBudgetExhausted]: `${MAX_RETRIES} failed API calls in this query — giving up. Check your network and try again.`,
  [TerminateReason.RateLimitBudgetExhausted]: "The provider keeps rate-limiting us. Wait a minute, then try again.",
  [TerminateReason.ContextTooLong]: "The conversation no longer fits the model's context window, and compaction could not shrink it enough. Use /clear to start fresh.",
  [TerminateReason.CompactionFailed]: "Automatic compaction kept failing — stopping instead of looping. Use /clear to start fresh.",
  [TerminateReason.FatalApiError]: "Unrecoverable API error — retrying would not help. Check your API key and request.",
  [TerminateReason.UserInterrupt]: "Interrupted — back at the prompt.",
};

// The in-session command reference, shown by /help.
const SESSION_HELP = `commands:
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
  exit       leave (Ctrl+C at the prompt does the same)

keys (at the prompt):
  Ctrl+R     reveal the model's thinking for the last answer (collapsed behind a spinner by default)
  Tab        expand/collapse the most recent tool output`;

// Injected when the user turns plan mode on, so the model knows the rules of the
// mode it now lives in (the permission gate enforces them regardless).
const PLAN_MODE_NOTICE = `[plan mode ON] Investigate this request using only read-only tools — read_file, search, and safe read-only shell (ls, cat, git status). Do NOT write files, edit, or run mutating commands; the permission gate will block them. When you have a concrete, ordered plan, call the exit_plan_mode tool with that plan. The user reviews and approves it before you make any change.`;

async function main() {
  // ---- Flag handling, before anything touches the network -----------------------
  const argv = process.argv.slice(2); // everything after "mini-agent"
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(pkg.version); // just the number — script-friendly
    return;
  }
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE); // the full help text
    return;
  }
  // Print mode: -p / --print takes the task from the remaining arguments.
  const pIdx = argv.findIndex((a) => a === "-p" || a === "--print"); // where the flag sits
  const printTask = pIdx >= 0 ? argv.slice(pIdx + 1).join(" ").trim() : null; // everything after it is the task
  if (pIdx >= 0 && !printTask) {
    console.error('Usage: mini-agent -p "<task>"'); // -p without a task is a usage error
    process.exitCode = 2;
    return;
  }

  requireApiKey(); // fail fast with instructions, not a stack trace from inside the SDK

  // Build the API client once, for the whole session.
  const client = new OpenAI({
    baseURL: CONFIG.baseURL, // DeepSeek by default; any OpenAI-compatible endpoint via config
    apiKey: CONFIG.apiKey, // from .env or the shell
    maxRetries: 0, // we own the retry policy — never let the SDK retry underneath us
  });

  // The system message is built ONCE per session: stable prefix = cache hits
  // on every request. Nothing session-specific may sneak into it later.
  const systemMessage = buildSystemMessage();
  let messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: systemMessage }]; // the whole conversation lives here, across turns

  // ---- Session persistence ---------------------------------------------------------
  // Every conversation is snapshotted to .mini-agent/sessions/ after each turn;
  // -r / --resume picks up the most recent one. The system message is NOT
  // restored from disk — it is rebuilt fresh, because AGENT.md may have changed.
  let sessionId = newSessionId(); // this session's identity (and file name)
  const sessionStartedAt = Date.now(); // for the status line's elapsed clock
  if (argv.includes("-r") || argv.includes("--resume")) {
    const prev = latestSession(); // newest snapshot in this directory, if any
    if (prev) {
      messages.push(...prev.messages); // the old conversation joins the fresh constitution
      sessionId = prev.id; // keep appending to the same session file
      console.log(chalk.dim(`(resumed session ${prev.id} — ${prev.messages.length} messages; files must be re-read before editing)`));
    } else {
      console.log(chalk.dim("(no previous session here — starting fresh)")); // resume with nothing to resume is not an error
    }
  }
  initTelemetry(sessionId); // arm the local event log (no-op under MINI_AGENT_NO_TELEMETRY=1)
  emit("agent_session_start", { mode: printTask !== null ? "print" : "repl" }); // how this session was started

  // Connect to any configured MCP servers and register their tools. This must
  // finish before the first model call so the tools appear in the manual. A
  // server that fails to start is skipped, never fatal.
  const disconnectMcp = await connectMcpServers();
  process.on("exit", disconnectMcp); // best-effort cleanup of server subprocesses
  process.on("exit", killAllBackground); // Day 37: SIGKILL any background job (dev server, slow install) so it never outlives the agent as an orphan

  // The optional LLM permission judge, built once if a settings file enabled it.
  const judge = CONFIG.judge.enabled ? new Judge(client, CONFIG.judge.model || CONFIG.model) : undefined;
  if (judge) console.log(chalk.dim(`(permission judge on — model ${CONFIG.judge.model || CONFIG.model})`));

  // The remember tool: let the model save durable facts to long-term memory.
  // Registered like any tool, so it flows through the same permission gate.
  registerExternalTool(rememberTool);
  const memCount = readMemory().length;
  if (memCount) console.log(chalk.dim(`(long-term memory: ${memCount} facts loaded)`));

  // Skills: reusable Markdown procedures. The model-invocable ones are exposed
  // through a single `skill` tool whose description lists them (progressive
  // disclosure); user-only skills are reachable via /skill <name>.
  const skills: Skill[] = loadSkills();
  if (skills.some((s) => !s.disableModelInvocation)) registerExternalTool(buildSkillTool(skills));
  if (skills.length) console.log(chalk.dim(`(skills: ${skills.length} loaded — ${skills.map((s) => s.name).join(", ")})`));

  // Token/cost meter for this session. Prices come from settings, falling back
  // to the defaults; the loop records usage into it from every stream.
  const costMeter = initCostMeter({
    inputPerM: CONFIG.pricing.inputPerM ?? DEFAULT_PRICING.inputPerM,
    cachedInputPerM: CONFIG.pricing.cachedInputPerM ?? DEFAULT_PRICING.cachedInputPerM,
    outputPerM: CONFIG.pricing.outputPerM ?? DEFAULT_PRICING.outputPerM,
  });

  // SessionStart hooks run once, here. Their stdout is injected as context the
  // model sees on its first turn — e.g. inject the current git branch, an
  // on-call rota, today's deploy freeze status. (exit 2 here is ignored: there
  // is no tool to block, only context to add.)
  const sessionStart = await runHooks("SessionStart", {});
  if (sessionStart.stdout) messages.push({ role: "user", content: `[SessionStart hook]\n${sessionStart.stdout}` });

  // Per-task interrupt state. `running` decides what Ctrl+C means right now.
  let running = false; // is a task currently executing?
  let interrupted = false; // has the current task been interrupted?
  let controller = new AbortController(); // aborts the in-flight API request

  // ---- One-shot print mode -------------------------------------------------------
  // The same loop, the same permission gate (fail closed without a TTY), no REPL.
  // Designed for scripts: the exit code distinguishes success from every failure.
  if (printTask !== null) {
    process.on("SIGINT", () => {
      if (interrupted) process.exit(130); // second press: force quit
      interrupted = true; // first press: wind down
      controller.abort(); // cancel the in-flight request
    });
    messages.push({ role: "user", content: printTask }); // the single task
    const result = await runLoop(messages, {
      client,
      model: CONFIG.model,
      signal: controller.signal,
      isInterrupted: () => interrupted,
      subAgentModel: CONFIG.subAgentModel, // delegated work may run on a different tier
      judge, // auto-allow clearly-safe commands even unattended (safer than blanket AUTO_APPROVE)
      // Print mode never prompts: unattended means nobody can say yes.
      // MINI_AGENT_AUTO_APPROVE=1 still works for scripted use; hard denies
      // were enforced in permissions.ts long before this runs.
      confirm: async (q) => {
        if (process.env.MINI_AGENT_AUTO_APPROVE === "1") return true; // explicit bypass
        console.error(chalk.dim(`[print mode] declined (no prompt available): ${q.split("\n")[0]}`)); // visible in stderr, not stdout
        return false; // fail closed
      },
    });
    saveSession(sessionId, CONFIG.model, messages); // print-mode runs are resumable too
    emit("agent_session_end"); // close the books
    if (result.reason !== TerminateReason.Done) {
      console.error(chalk.yellow(EXIT_NOTES[result.reason])); // human note on stderr
      if (result.detail) console.error(chalk.dim(result.detail.slice(0, 300))); // raw detail on stderr
      process.exitCode = result.reason === TerminateReason.UserInterrupt ? 130 : 1; // scripts can branch on this
    }
    return; // the answer itself already streamed to stdout
  }

  // ---- Interactive session (REPL) -------------------------------------------------
  // The welcome box: who am I, which model and host am I on, and the basics.
  console.log(banner(pkg.version, CONFIG.model, new URL(CONFIG.baseURL).host));

  // ONE readline interface for the whole session — the task prompt and the
  // permission prompts share it. Two interfaces on one stdin fight each other.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(""); // a TTY edits via our editor (not rl), so blank readline's default "> " — it would otherwise flash on resume()

  // Input plumbing: a line QUEUE instead of rl.question(). With piped stdin
  // all lines arrive at once — question() would catch the first and lose the
  // rest. The queue catches every line; asking pops one (or waits for one).
  // Bonus: in a terminal, lines typed while a task runs queue up as the next
  // commands instead of vanishing.
  const pendingLines: string[] = []; // lines that arrived before anyone asked
  const lineWaiters: ((line: string) => void)[] = []; // askers waiting for a line
  let stdinDone = false; // has stdin ended?
  const history: string[] = []; // past prompts, for ↑/↓ recall in the editor
  let editing = false; // true while our line editor owns stdin (so the running-key handler stands down)
  rl.on("line", (line) => {
    // Only fires for NON-TTY (piped) input — a TTY goes through editLine, which
    // doesn't emit readline 'line' events. Piped input has no footer to clear.
    const waiter = lineWaiters.shift(); // is somebody waiting?
    if (waiter) waiter(line); // hand the line over directly
    else pendingLines.push(line); // nobody waiting — queue it
  });
  rl.on("close", () => {
    stdinDone = true; // no more input will ever come
    while (lineWaiters.length) lineWaiters.shift()!("exit"); // wake every waiter with a polite "exit"
  });
  // Get the next line of user input, showing a prompt if we have to wait.
  const readUserLine = async (prompt: string, footer?: string): Promise<string> => {
    if (pendingLines.length) return pendingLines.shift()!; // typed-ahead (or piped) line — use it
    if (stdinDone) return "exit"; // stdin is gone — leave politely
    if (process.stdin.isTTY) {
      // Our editor owns the whole input block (prompt + wrapped input + footer),
      // so the status bar stays pinned below however the line wraps.
      editing = true;
      try {
        const res = await editLine(rl, { prompt, footer, history, onTab: () => toggleLastCollapsed(), onReveal: () => revealReasoning(), transformPaste: normalizeDroppedPaths });
        if (res.type === "line") {
          if (res.value.trim()) history.push(res.value); // remember non-empty entries for ↑/↓
          return res.value;
        }
        if (res.type === "cancel") {
          // Ctrl+C at the prompt: exit the session (standard REPL behavior).
          console.log();
          process.exit(0);
        }
        return "exit"; // eof (Ctrl+D)
      } finally {
        editing = false;
      }
    }
    // Non-TTY (piped): the readline line queue, no prompt frame, no footer.
    rl.setPrompt(prompt);
    rl.prompt();
    return new Promise((resolve) => lineWaiters.push(resolve)); // wait for the next line
  };

  // Ctrl+C semantics, by state:
  // - at the prompt: exit the session (standard REPL behavior)
  // - while running: first press interrupts the task, second press force-quits
  const onSigint = () => {
    if (!running) {
      console.log(); // end the prompt line cleanly
      process.exit(0); // at the prompt, Ctrl+C = goodbye
    }
    if (interrupted) process.exit(130); // second press while running: force quit (130 = killed by SIGINT)
    interrupted = true; // first press: raise the flag...
    controller.abort(); // ...and cancel the in-flight API request
    console.log(chalk.yellow("\n(interrupt — finishing up, Ctrl+C again to force quit)")); // tell the user we heard them
  };
  process.on("SIGINT", onSigint); // covers non-TTY runs
  rl.on("SIGINT", onSigint); // covers TTY raw mode, where readline swallows the signal itself

  // Ask the human to approve a dangerous action — shares the session readline.
  // Fail closed: in a non-interactive session nobody can say yes, so the
  // answer is no. MINI_AGENT_AUTO_APPROVE=1 bypasses the QUESTION, but hard
  // denies were already enforced in permissions.ts before we get here.
  const confirm = async (question: string, toolName?: string): Promise<boolean> => {
    console.log(chalk.yellow(`\n⚠ approval needed — ${question}`)); // always show what is being asked
    if (process.env.MINI_AGENT_AUTO_APPROVE === "1") {
      console.log(chalk.dim("  auto-approved (MINI_AGENT_AUTO_APPROVE=1)")); // bypass mode — say so out loud
      return true; // approve without asking
    }
    if (!process.stdin.isTTY) {
      console.log(chalk.dim("  non-interactive session — denied by default (fail closed)")); // nobody can answer — refuse
      return false; // fail closed
    }
    // Selecting beats typing: ↑/↓ + Enter instead of "type y/N". The middle
    // option lets the user stop being asked about this tool for the session.
    const allowLabel = toolName ? `Yes, and don't ask again for ${toolName} this session` : "Yes, and don't ask again this session";
    const choice = await promptSelect(rl, ["Yes", allowLabel, "No — let me tell the agent what to do instead"]);
    const approved = choice === 0 || choice === 1;
    if (choice === 1 && toolName) {
      CONFIG.permissions.allow.push(`tool:${toolName}`); // remember the grant for the rest of the session
      console.log(chalk.dim(`  won't ask again for ${toolName} this session`));
    }
    console.log(approved ? chalk.green("  ✓ approved") : chalk.yellow("  ✗ declined"));
    return approved;
  };

  // The model's handle on the user: present a multi-question form and return the
  // selections. Null in a non-interactive session — the model is told to ask in
  // plain text instead.
  const askUser = async (questions: { question: string; options: string[] }[]) => {
    if (!process.stdin.isTTY) return null;
    return promptForm(rl, questions);
  };

  // Ask the endpoint what models it serves (the OpenAI-compatible /models API).
  // Empty list on any failure — not every endpoint implements it, and a failed
  // listing should never break the command.
  const listModels = async (): Promise<string[]> => {
    try {
      const page = await client.models.list();
      const ids = (page.data ?? []).map((m) => m.id).filter(Boolean);
      return [...new Set(ids)].sort();
    } catch {
      return [];
    }
  };

  // /model — show the current model, or switch. `/model <name>` sets it directly;
  // bare `/model` lists the endpoint's models and lets you pick one (Day 29 menu).
  // The switch takes effect next turn: the loop reads CONFIG.model each turn.
  const handleModelCommand = async (arg: string): Promise<void> => {
    // Switching is SESSION-ONLY by default — a quick "/model <name>" to try a
    // model must never permanently change your default. "/model save <name>"
    // (or save after picking) writes it to the global settings file.
    const save = arg === "save" || arg.startsWith("save ");
    const name = save ? arg.slice(4).trim() : arg;
    const apply = (next: string) => {
      const prev = CONFIG.model;
      CONFIG.model = next; // any string — the API errors on an unknown one, and the error layer reports it
      if (save) {
        saveGlobalSetting("model", next); // persist as the new default
        console.log(chalk.dim(`(model: ${prev} → ${next} · saved as your default)`));
      } else {
        console.log(chalk.dim(`(model: ${prev} → ${next} · this session only — use "/model save ${next}" to keep it)`));
      }
    };

    if (name) {
      apply(name);
      return;
    }
    // No name: show the current model and a picker.
    console.log(
      chalk.dim(
        `model: ${CONFIG.model}\n` +
          (CONFIG.subAgentModel ? `sub-agent model: ${CONFIG.subAgentModel} (delegated task work)\n` : "") +
          `endpoint: ${CONFIG.baseURL}\ncontext window: ${CONFIG.contextWindow} tokens (compaction at ~${COMPACT_AT})`,
      ),
    );
    if (!process.stdin.isTTY) return; // no picker without a TTY — switch with: /model <name>
    const models = await listModels();
    if (!models.length) {
      console.log(chalk.dim("(couldn't list models from this endpoint — switch with: /model <name>)"));
      return;
    }
    console.log(chalk.dim("switch model (this session):"));
    const choice = await promptSelect(rl, formatModelChoices(models, CONFIG.model));
    if (choice < 0 || models[choice] === CONFIG.model) {
      console.log(chalk.dim("(model unchanged)"));
      return;
    }
    apply(models[choice]); // picker is session-only too; "/model save <name>" to persist
  };

  // Handle a /slash command. Returns true if the line was a command.
  const handleCommand = async (line: string): Promise<boolean> => {
    // /model takes an optional argument (/model <name>), so it can't be a plain
    // switch case — handle it before the exact-match switch.
    if (line === "/model" || line.startsWith("/model ")) {
      await handleModelCommand(line.slice("/model".length).trim());
      return true;
    }
    // /skill <name> runs a skill on the user's behalf — inject its instructions
    // as a turn so the model follows them. Works for user-only skills too.
    if (line === "/skill" || line.startsWith("/skill ")) {
      const name = line.slice("/skill".length).trim();
      if (!name) {
        console.log(chalk.dim(skills.length ? `usage: /skill <name> — available: ${skills.map((s) => s.name).join(", ")}` : "(no skills in this project — add one at .mini-agent/skills/<name>/SKILL.md)"));
        return true;
      }
      const s = findSkill(skills, name);
      if (!s) {
        console.log(chalk.yellow(`(no skill named "${name}")`));
        return true;
      }
      messages.push({ role: "user", content: `Run the "${s.name}" skill.\n\n${skillInstructions(s)}` });
      console.log(chalk.dim(`(running skill: ${s.name})`));
      running = true;
      interrupted = false;
      controller = new AbortController();
      const r = await runLoop(messages, { client, model: CONFIG.model, signal: controller.signal, isInterrupted: () => interrupted, confirm, askUser, subAgentModel: CONFIG.subAgentModel, judge });
      running = false;
      saveSession(sessionId, CONFIG.model, messages);
      if (r.reason !== TerminateReason.Done) console.log(chalk.yellow(`\n⚠️ ${EXIT_NOTES[r.reason]}`));
      return true;
    }
    switch (line) {
      case "/skills": {
        if (!skills.length) {
          console.log(chalk.dim("(no skills — add one at .mini-agent/skills/<name>/SKILL.md or ~/.config/mini-agent/skills/)"));
          return true;
        }
        console.log(chalk.dim(`skills in this project:`));
        for (const s of skills) {
          const who = s.disableModelInvocation ? chalk.yellow("user-only") : chalk.green("model+user");
          console.log(chalk.dim(`  ${s.name} [${who}${chalk.dim("]")} — ${(s.whenToUse || s.description).slice(0, 70)}`));
        }
        return true;
      }
      case "/help":
        console.log(chalk.dim(SESSION_HELP)); // the command reference
        return true;
      case "/clear":
        messages = [{ role: "system", content: systemMessage }]; // drop everything but the constitution
        forgetFilesExcept([]); // the file read-state belongs to the conversation — clear it too
        clearUndo(); // a fresh conversation should not undo the previous one's writes
        clearTodos(); // the plan belonged to the old task — drop it
        resetTeam(); // the team belonged to the old task — forget it (mailboxes re-wipe on next use)
        resetBoard(); // and the shared task board (Day 40)
        clearReasoning(); // drop the collapsed thinking too
        sessionId = newSessionId(); // a fresh conversation is a fresh session file
        console.log(chalk.dim("(history cleared)")); // confirm the reset
        return true;
      case "/todos": {
        const todos = getTodos(); // the agent's current checklist for this task
        console.log(todos.length ? renderTodos(todos) : chalk.dim("(no plan yet — the agent writes one with todo_write on multi-step tasks)"));
        return true;
      }
      case "/bg": {
        // The background jobs (run_bash_background) started this session — what's
        // still running, what finished, and with what exit status.
        const bg = listBackground();
        if (!bg.length) {
          console.log(chalk.dim("(no background tasks — the agent starts them with run_bash_background for slow commands)"));
          return true;
        }
        const icon = { running: chalk.yellow("●"), completed: chalk.green("✓"), failed: chalk.red("✗"), killed: chalk.dim("∅") };
        console.log(chalk.dim(`background tasks this session:`));
        for (const t of bg) {
          console.log(chalk.dim(`  ${icon[t.status]} ${t.id} [${t.status}, ${t.elapsed}s] — ${t.command.slice(0, 70)}`));
        }
        return true;
      }
      case "/team": {
        // The agent team (spawn_teammate): who's running, who's done, and how
        // many messages still sit unread in each one's on-disk inbox.
        const team = listTeam();
        if (!team.length) {
          console.log(chalk.dim("(no team — the agent forms one with spawn_teammate for large parallel tasks)"));
          return true;
        }
        // Day 39: a running teammate reports as active (working) or idle (waiting).
        const icon: Record<string, string> = { active: chalk.yellow("●"), idle: chalk.cyan("◐"), done: chalk.green("✓"), failed: chalk.red("✗") };
        console.log(chalk.dim(`agent team this session:`));
        for (const t of team) {
          const inbox = t.pending ? chalk.yellow(` · ${t.pending} unread`) : "";
          console.log(chalk.dim(`  ${icon[t.status] ?? "?"} ${t.name} [${t.status}, ${t.elapsed}s] — ${t.role.slice(0, 60)}${inbox}`));
        }
        return true;
      }
      case "/tasks": {
        // The shared task board (create_task/claim_task/complete_task): what's
        // pending, claimed, and done, and who owns what.
        const summary = boardSummary();
        console.log(summary === "(the task board is empty)" ? chalk.dim("(no tasks — the lead adds them with create_task; teammates claim them autonomously)") : chalk.dim(`task board:\n${summary}`));
        return true;
      }
      case "/stats":
        console.log(chalk.dim(statsReport())); // local counters, busiest first
        return true;
      case "/memory": {
        const entries = readMemoryTyped(); // the durable, typed facts carried across sessions
        console.log(
          chalk.dim(
            entries.length
              ? `long-term memory (${MEMORY_PATH}):\n${entries.map((e) => `  [${e.type}] ${e.fact}`).join("\n")}`
              : `(no long-term memory yet — the model saves facts with the remember tool${CONFIG.memory.autoExtract ? "" : "; turn on settings.memory.autoExtract to capture them automatically"})`,
          ),
        );
        return true;
      }
      case "/cost":
        console.log(chalk.dim(costMeter.report())); // tokens, cache hit rate, estimated spend (local)
        return true;
      case "/undo": {
        // Revert the most recent write. This is a USER action on the filesystem,
        // not a turn for the model — the conversation is untouched. If the model
        // later edits a file it thinks it changed, edit_file's read-before-edit +
        // exact-match guards will catch the staleness and ask it to re-read.
        const undone = undoLast();
        if (!undone) {
          console.log(chalk.dim("(nothing to undo — no file writes recorded this session)"));
          return true;
        }
        console.log(chalk.dim(`↩ ${undone.summary}`));
        // Show the diff of what was put back (from the current state to the
        // restored one), reusing the Day 21 renderer.
        console.log(renderDiff(undone.after ?? "", undone.before ?? ""));
        return true;
      }
      case "/resume": {
        // List recent sessions in this project and switch to the chosen one.
        // Swapping mid-conversation is fine: we rebuild from the constitution +
        // the saved messages, and reset the per-conversation state (read-state,
        // undo history) so the resumed session behaves like a fresh start of it.
        const sessions = listSessions(10);
        if (!sessions.length) {
          console.log(chalk.dim("(no saved sessions in this project yet)"));
          return true;
        }
        console.log(chalk.dim("recent sessions in this project:"));
        sessions.forEach((s, i) => {
          const when = s.savedAt.slice(0, 16).replace("T", " "); // 2026-06-15 10:30
          console.log(chalk.dim(`  ${i + 1}. ${when} · ${s.messageCount} msg · ${s.title.slice(0, 60)}`));
        });
        const answer = (await readUserLine("  resume which? [number, or Enter to cancel] ")).trim();
        if (!answer) {
          console.log(chalk.dim("(cancelled)"));
          return true;
        }
        const idx = Number(answer) - 1;
        if (!Number.isInteger(idx) || idx < 0 || idx >= sessions.length) {
          console.log(chalk.dim("(not a valid choice — cancelled)"));
          return true;
        }
        const chosen = loadSession(sessions[idx].id);
        if (!chosen) {
          console.log(chalk.yellow("(could not load that session — it may be corrupt)"));
          return true;
        }
        messages = [{ role: "system", content: systemMessage }, ...chosen.messages]; // fresh constitution + saved turns
        sessionId = chosen.id; // keep appending to the resumed session's file
        forgetFilesExcept([]); // a resumed conversation must re-read files before editing them
        clearUndo(); // the previous session's writes are not ours to undo
        clearTodos(); // the resumed task starts without the old session's stale plan
        resetTeam(); // a resumed conversation starts with no live team
        resetBoard(); // ...and an empty task board (Day 40)
        console.log(chalk.dim(`(resumed ${chosen.id} — ${chosen.messages.length} messages; files must be re-read before editing)`));
        return true;
      }
      case "/diff": {
        // A read-only review of the net effect of this session on the
        // filesystem — every file whose content differs from where it started,
        // shown as a diff from baseline → now. Reuses the Day 21 renderer.
        const changes = sessionChanges();
        if (!changes.length) {
          console.log(chalk.dim("(no file changes this session)"));
          return true;
        }
        const verb = { created: chalk.green("created"), modified: chalk.yellow("modified"), deleted: chalk.red("deleted") };
        console.log(chalk.dim(`${changes.length} file${changes.length === 1 ? "" : "s"} changed this session:`));
        for (const c of changes) {
          const short = path.relative(process.cwd(), c.path) || c.path;
          console.log(`\n${verb[c.status]} ${short}`);
          console.log(renderDiff(c.baseline, c.current));
        }
        return true;
      }
      case "/plan":
        // A toggle. Turning it on injects the rules of the mode as a user turn so
        // the model adopts them; the gate (permissions.ts) enforces them either way.
        if (isPlanMode()) {
          setPlanMode(false);
          console.log(chalk.dim("(plan mode OFF — writing and executing tools enabled again)"));
        } else {
          setPlanMode(true);
          messages.push({ role: "user", content: PLAN_MODE_NOTICE });
          console.log(chalk.dim("(plan mode ON — read-only research; the agent will present a plan for you to approve)"));
        }
        return true;
      case "/compact": {
        if (messages.length <= 1) {
          console.log(chalk.dim("(nothing to compact yet)")); // only the system message so far
          return true;
        }
        try {
          await compactHistory(messages, client, CONFIG.model, new AbortController().signal); // same machinery as automatic compaction
        } catch (err) {
          console.log(chalk.yellow(`compaction failed: ${(err as Error).message}`)); // report, don't crash
        }
        return true;
      }
      default:
        if (line.startsWith("/")) {
          console.log(chalk.dim(`unknown command: ${line} — try /help`)); // typo guard
          return true; // still consumed — don't send typos to the model
        }
        return false; // a normal task line
    }
  };

  // The session loop: ask → run → render → ask again. This is what makes it
  // a conversation instead of a one-shot command.

  // Raw-stdin key handling that applies while a task is RUNNING. At the prompt
  // the line editor owns stdin (and handles its own keys, incl. Tab → collapse),
  // so we stand down whenever `editing` is true to avoid double-processing.
  //   Esc → interrupt the current operation and return to the prompt (like the
  //         first Ctrl+C, but without the "press again to force-quit" escalation).
  // A LONE Esc is one byte (0x1b); arrow keys etc. are multi-byte escape
  // sequences starting with 0x1b — the length check tells them apart.
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.on("data", (buf: Buffer) => {
      if (editing) return; // the editor is in charge of these keys
      if (buf.length === 1 && buf[0] === 0x1b) {
        // Esc: stop the current operation, keep the session alive and typeable.
        if (running && !interrupted) {
          interrupted = true; // the loop polls this between steps
          controller.abort(); // cancel the in-flight API request
          console.log(chalk.yellow("\n(esc — interrupted; back at the prompt)"));
        }
      }
    });
  }

  while (true) {
    // The input area, Claude-Code style: a top rule, the "❯" you type on, then a
    // bottom rule + status line (model · 📁 dir · 🌿 branch · ctx% · $ · time)
    // pinned BELOW the input. readUserLine draws the footer under the prompt and
    // keeps the cursor on the ❯ line, so the status reads like a real bottom bar.
    // Only in a TTY; piped input stays clean.
    let footer: string | undefined;
    if (process.stdin.isTTY) {
      const ctxPct = Math.min(100, Math.round((estimateHistoryTokens(messages) / CONFIG.contextWindow) * 100));
      console.log("\n" + inputRule()); // top rule above the prompt
      footer = inputRule() + "\n" + statusLine(CONFIG.model, path.basename(process.cwd()), gitBranch(), ctxPct, costMeter.cost(), Date.now() - sessionStartedAt); // bottom rule + status, pinned below
    }
    const line = (await readUserLine(framedPrompt(isPlanMode()), footer)).trim(); // next input, or "exit" on EOF
    if (!line) continue; // empty line — just re-prompt
    if (line === "exit" || line === "quit") {
      if (hasRunningBackground()) console.log(chalk.yellow("(stopping background tasks still running — see /bg)")); // Day 37: they're about to be SIGKILLed on exit
      break; // explicit goodbye
    }
    if (await handleCommand(line)) continue; // slash commands never reach the model

    // UserPromptSubmit hook: a chance to validate/inject before the model sees
    // the prompt. exit 2 DROPS the prompt entirely (e.g. block a forbidden ask);
    // stdout becomes extra context for this turn (e.g. inject the current ticket).
    const submit = await runHooks("UserPromptSubmit", { prompt: line });
    if (submit.block) {
      console.log(chalk.yellow(`(prompt blocked by a UserPromptSubmit hook: ${submit.feedback.slice(0, 150)})`));
      continue; // the prompt is erased — never reaches the model
    }
    const injected = submit.stdout ? `\n\n[context added by a UserPromptSubmit hook]\n${submit.stdout}` : "";

    // @file mentions: if the line references files (@src/loop.ts), attach their
    // content to the message so the model sees them directly. Secret files are
    // refused here, exactly as read_file would refuse them.
    const { augmented, mentions } = expandMentions(line);
    const attached = mentions.filter((m) => m.status === "ok").map((m) => m.raw);
    const refused = mentions.filter((m) => m.status === "denied").map((m) => m.raw);
    if (attached.length) console.log(chalk.dim(`(attached ${attached.length} file${attached.length === 1 ? "" : "s"}: ${attached.join(", ")})`));
    if (refused.length) console.log(chalk.yellow(`(refused secret file${refused.length === 1 ? "" : "s"}: ${refused.join(", ")})`));

    messages.push({ role: "user", content: augmented + injected }); // the new turn (with any attached files + hook context) joins the shared history
    clearReasoning(); // Ctrl+R should reveal THIS turn's thinking, not the previous answer's
    running = true; // Ctrl+C now means "interrupt the task"
    interrupted = false; // fresh interrupt state for this task
    controller = new AbortController(); // fresh abort signal for this task

    const result: LoopResult = await runLoop(messages, {
      client, // the configured API client
      model: CONFIG.model, // whatever the user configured — must support function calling
      signal: controller.signal, // for aborting requests
      isInterrupted: () => interrupted, // for stopping between steps
      confirm, // for permission prompts
      askUser, // the multi-question form the model can pop
      subAgentModel: CONFIG.subAgentModel, // delegated work may run on a different tier
      judge, // optional LLM classifier for the "ask" middle ground
    });
    running = false; // back at the prompt — Ctrl+C means "exit" again
    saveSession(sessionId, CONFIG.model, messages); // snapshot after every turn — crash-safe by construction

    // Auto-extract memories (opt-in: settings.memory.autoExtract). A cheap pass
    // that saves durable facts — especially user corrections — so memory
    // captures itself instead of relying on the model to call `remember`.
    if (CONFIG.memory.autoExtract && result.reason === TerminateReason.Done) {
      try {
        const got = await extractMemories(client, CONFIG.subAgentModel || CONFIG.model, messages);
        if (got.length) console.log(chalk.dim(`(remembered ${got.length}: ${got.map((g) => g.fact.slice(0, 50)).join("; ")})`));
      } catch {
        /* memory extraction must never break the session */
      }
    }

    // Done already streamed its answer to the screen; everything else gets a
    // one-line human explanation. The session continues either way — except a
    // fatal API error, which no amount of chatting will fix.
    if (result.reason !== TerminateReason.Done) {
      console.log(chalk.yellow(`\n⚠️ ${EXIT_NOTES[result.reason]}`)); // the human explanation
      if (result.detail) console.log(chalk.dim(`   ${result.detail.slice(0, 300)}`)); // raw detail for the curious
      if (result.reason === TerminateReason.FatalApiError) break; // a bad key won't fix itself mid-session
    }
  }

  await runHooks("SessionEnd", {}); // cleanup hooks (tiny 1.5s budget — the user may be leaving via Ctrl+C)
  emit("agent_session_end"); // close the books
  rl.close(); // release stdin
  tuiCleanup(); // restore terminal
  console.log(chalk.dim("bye.")); // a clean goodbye
}

main(); // kick everything off

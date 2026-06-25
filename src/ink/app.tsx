import React, { useState, useEffect, useRef } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import chalk from "chalk";
import { formatElapsed, renderMenu, MENU_HINT, formatModelChoices } from "../ui.js"; // status format + the SAME pure menu renderer the readline REPL uses
import { renderMarkdown } from "../markdown.js"; // model speaks markdown → ANSI, same as the non-Ink REPL
import { initFormState, reduceForm, renderForm, collectAnswers, type FormQuestion, type FormState, type FormAnswer } from "../form.js"; // the ask_user form: pure state machine + renderer
import { CONFIG, saveGlobalSetting } from "../config.js"; // session allowlist + /model save
import { TerminateReason, type LoopResult } from "../loop.js"; // how a turn can end
import { compactHistory, COMPACT_AT } from "../context.js"; // /compact
import { forgetFilesExcept } from "../tools.js"; // /clear resets the file read-state
import { clearUndo } from "../undo.js";
import { clearTodos } from "../todos.js";
import { resetTeam } from "../team.js";
import { resetBoard } from "../board.js";
import { clearReasoning, clearToolCalls, cleanup as tuiCleanup } from "../tui.js";
import { newSessionId, saveSession, listSessions, loadSession } from "../session.js";
import { isPlanMode, setPlanMode } from "../permissions.js";
import { findSkill, skillInstructions } from "../skills.js";
import { extractMemories } from "../memory.js";
import { runHooks } from "../hooks.js";
import { emit } from "../telemetry.js";
import { makeInkSink, type Item } from "./sink.js"; // turns the loop's output into React state
import { runInfoCommand, SESSION_HELP } from "./commands.js"; // the non-interactive slash commands
import type { TurnHooks } from "./chat.js"; // what one turn needs from the App
import type { InkSession } from "./setup.js"; // the bootstrapped session context

// What the bottom status bar needs, recomputed live (ctx% grows with history,
// cost accrues from the stream, the clock ticks).
export interface StatusData {
  ctxPct: number;
  cost: number;
  elapsedMs: number;
}

// A prompt the loop (or a slash command) is waiting on. `select` is a one-of-N
// menu — approvals, /model, /resume — driven by the same pure renderMenu the
// readline REPL uses; onChoose(-1) means cancelled. `form` is the ask_user
// multi-question form (form.ts's pure state machine).
type Pending =
  | { kind: "select"; header: string; options: string[]; onChoose: (index: number) => void }
  | { kind: "form"; questions: FormQuestion[]; resolve: (answers: FormAnswer[] | null) => void };

// Injected when plan mode turns on, so the model knows the rules it now lives in.
const PLAN_MODE_NOTICE = `[plan mode ON] Investigate this request using only read-only tools — read_file, search, and safe read-only shell (ls, cat, git status). Do NOT write files, edit, or run mutating commands; the permission gate will block them. When you have a concrete, ordered plan, call the exit_plan_mode tool with that plan. The user reviews and approves it before you make any change.`;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; // the braille spinner ora uses, hand-rolled for Ink

function Spinner() {
  const [f, setF] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setF((x) => (x + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <Text color="cyan">{SPINNER_FRAMES[f]}</Text>;
}

// One committed line of conversation. `user` is a highlight bar; `answer` is a
// finished reply rendered as markdown; `note` is already-formatted narration.
function ItemView({ item }: { item: Item }) {
  if (item.kind === "user") {
    return (
      <Box marginTop={1}>
        <Text backgroundColor="gray" color="whiteBright">{`> ${item.text}`}</Text>
      </Box>
    );
  }
  if (item.kind === "answer") {
    return (
      <Box marginTop={1} flexDirection="row">
        <Text color="green">⏺ </Text>
        <Box flexGrow={1}>
          <Text>{renderMarkdown(item.text)}</Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box>
      <Text>{item.text}</Text>
    </Box>
  );
}

// The bottom status bar — same content + colours as the non-Ink statusLine():
// [model] · 📁 dir · 🌿 branch · ctx N% · $cost · ⏱ time.
function StatusBar({ model, dir, branch, status }: { model: string; dir: string; branch: string | null; status: StatusData }) {
  const parts: React.ReactNode[] = [
    <Text key="m" color="cyan">[{model}]</Text>,
    <Text key="d" dimColor>📁 {dir}</Text>,
    ...(branch ? [<Text key="b" color="green">🌿 {branch}</Text>] : []),
    <Text key="c" dimColor>ctx {status.ctxPct}%</Text>,
    <Text key="$" color="yellow">${status.cost.toFixed(status.cost < 1 ? 4 : 2)}</Text>,
    <Text key="t" dimColor>⏱ {formatElapsed(status.elapsedMs)}</Text>,
  ];
  return (
    <Box>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text dimColor>{"  ·  "}</Text>}
          {p}
        </React.Fragment>
      ))}
    </Box>
  );
}

// One human note per non-Done ending, so the user always learns why a turn stopped.
const EXIT_NOTES: Partial<Record<TerminateReason, string>> = {
  [TerminateReason.CircuitBreaker]: "3 API failures in a row — stopping here.",
  [TerminateReason.RetryBudgetExhausted]: "Too many failed API calls — giving up. Check your network.",
  [TerminateReason.RateLimitBudgetExhausted]: "The provider keeps rate-limiting us. Wait a minute, then retry.",
  [TerminateReason.ContextTooLong]: "The conversation no longer fits the context window. Use /clear.",
  [TerminateReason.CompactionFailed]: "Automatic compaction kept failing. Use /clear to start fresh.",
  [TerminateReason.FatalApiError]: "Unrecoverable API error — check your API key and request.",
  [TerminateReason.UserInterrupt]: "Interrupted — back at the prompt.",
};

export function App({ session, runTurn }: { session: InkSession; runTurn: (input: string, hooks: TurnHooks) => Promise<LoopResult> }) {
  const { client, messages, systemMessage, costMeter, skills, judge, model, dir, branch, getStatus } = session;

  // Seed the scrollback with the welcome banner + the dim startup notices.
  const [items, setItems] = useState<Item[]>(() => [{ kind: "note", text: session.bannerText }, ...session.notices.map((n) => ({ kind: "note" as const, text: chalk.dim(n) }))]);
  const [status, setStatus] = useState<string | null>(null); // the live spinner line
  const [live, setLive] = useState<string | null>(null); // the streaming answer
  const [input, setInput] = useState(""); // the current input buffer
  const [busy, setBusy] = useState(false); // a turn is in flight
  const [pending, setPending] = useState<Pending | null>(null); // a prompt/menu blocking input
  const [menuSel, setMenuSel] = useState(0); // the select menu's cursor
  const [formState, setFormState] = useState<FormState | null>(null); // the ask_user form's state
  const [sessionId, setSessionId] = useState(session.initialSessionId); // changes on /clear, /resume
  const [planMode, setPlan] = useState(isPlanMode()); // mirrored into the prompt frame
  const [, setTick] = useState(0); // forces a re-render once a second so the clock / cost tick
  const { exit } = useApp();

  const pushItem = useRef((it: Item) => setItems((xs) => [...xs, it])).current;
  const note = (text: string) => pushItem({ kind: "note", text });
  const sink = useRef(makeInkSink({ setStatus, setLive, pushItem })).current;

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Open a one-of-N menu and run `onChoose` with the picked index (-1 = cancel).
  const openSelect = (header: string, options: string[], onChoose: (i: number) => void) => {
    setMenuSel(0);
    setPending({ kind: "select", header, options, onChoose });
  };

  // Run one conversation turn through the real loop. `display` is what scrolls up
  // as the prompt (a user highlight bar, or a note for /skill); the loop appends
  // `content` to `messages` itself. The permission menu + ask_user form raise a
  // `pending` prompt that returns a promise the loop awaits.
  const runConversationTurn = (content: string, display: Item) => {
    pushItem(display);
    clearReasoning(); // Ctrl+R should reveal THIS turn's thinking
    clearToolCalls(); // ...and Ctrl+T THIS turn's tool calls
    setBusy(true);
    const controller = new AbortController();
    const hooks: TurnHooks = {
      output: sink,
      confirm: (question, toolName) =>
        new Promise<boolean>((resolve) => {
          const allowLabel = toolName ? `Yes, and don't ask again for ${toolName} this session` : "Yes, and don't ask again this session";
          openSelect(`⚠ approval needed — ${question}`, ["Yes", allowLabel, "No — let me tell the agent what to do instead"], (i) => {
            const approved = i === 0 || i === 1;
            if (approved && i === 1 && toolName) CONFIG.permissions.allow.push(`tool:${toolName}`); // "don't ask again" → session allowlist
            note(`${chalk.yellow("⚠ approval")} — ${question.split("\n")[0]} → ${approved ? chalk.green("✓ approved") : chalk.yellow("✗ declined")}`);
            resolve(approved);
          });
        }),
      askUser: (questions) =>
        new Promise<FormAnswer[] | null>((resolve) => {
          if (!questions.length) return resolve(null);
          setFormState(initFormState(questions));
          setPending({ kind: "form", questions, resolve });
        }),
      signal: controller.signal,
      isInterrupted: () => false,
      judge,
    };
    runTurn(content, hooks)
      .then(async (result: LoopResult) => {
        if (result.reason !== TerminateReason.Done) note(chalk.yellow(`⚠️ ${EXIT_NOTES[result.reason] ?? result.reason}`));
        saveSession(sessionId, model, messages); // snapshot after every turn — crash-safe by construction
        if (CONFIG.memory.autoExtract && result.reason === TerminateReason.Done) {
          try {
            const got = await extractMemories(client, CONFIG.subAgentModel || model, messages);
            if (got.length) note(chalk.dim(`(remembered ${got.length}: ${got.map((g) => g.fact.slice(0, 50)).join("; ")})`));
          } catch {
            /* memory extraction must never break the session */
          }
        }
      })
      .catch((e: unknown) => note(chalk.red(`[error] ${(e as Error).message}`)))
      .finally(() => {
        setBusy(false);
        setStatus(null);
        setLive(null);
      });
  };

  // Handle a /slash command. Returns true if the line was a command (handled).
  const handleCommand = async (line: string): Promise<boolean> => {
    const info = runInfoCommand(line, { skills, costMeter }); // /help /cost /memory /stats /todos /bg /team /tasks /skills /undo /diff
    if (info !== null) {
      note(info);
      return true;
    }

    // /model [name|save <name>]
    if (line === "/model" || line.startsWith("/model ")) {
      const arg = line.slice("/model".length).trim();
      const save = arg === "save" || arg.startsWith("save ");
      const name = save ? arg.slice(4).trim() : arg;
      const apply = (next: string) => {
        const prev = CONFIG.model;
        CONFIG.model = next;
        if (save) {
          saveGlobalSetting("model", next);
          note(chalk.dim(`(model: ${prev} → ${next} · saved as your default)`));
        } else {
          note(chalk.dim(`(model: ${prev} → ${next} · this session only — use "/model save ${next}" to keep it)`));
        }
      };
      if (name) {
        apply(name);
        return true;
      }
      note(chalk.dim(`model: ${CONFIG.model}\nendpoint: ${CONFIG.baseURL}\ncontext window: ${CONFIG.contextWindow} tokens (compaction at ~${COMPACT_AT})`));
      let models: string[] = [];
      try {
        const page = await client.models.list();
        models = [...new Set((page.data ?? []).map((m) => m.id).filter(Boolean))].sort();
      } catch {
        /* not every endpoint lists models */
      }
      if (!models.length) {
        note(chalk.dim("(couldn't list models from this endpoint — switch with: /model <name>)"));
        return true;
      }
      openSelect("switch model (this session):", formatModelChoices(models, CONFIG.model), (i) => {
        if (i < 0 || models[i] === CONFIG.model) return note(chalk.dim("(model unchanged)"));
        apply(models[i]);
      });
      return true;
    }

    // /skill <name> — run a skill on the user's behalf (works for user-only skills)
    if (line === "/skill" || line.startsWith("/skill ")) {
      const name = line.slice("/skill".length).trim();
      if (!name) {
        note(chalk.dim(skills.length ? `usage: /skill <name> — available: ${skills.map((s) => s.name).join(", ")}` : "(no skills in this project — add one at .mini-agent/skills/<name>/SKILL.md)"));
        return true;
      }
      const s = findSkill(skills, name);
      if (!s) {
        note(chalk.yellow(`(no skill named "${name}")`));
        return true;
      }
      runConversationTurn(`Run the "${s.name}" skill.\n\n${skillInstructions(s)}`, { kind: "note", text: chalk.dim(`(running skill: ${s.name})`) });
      return true;
    }

    switch (line) {
      case "/clear":
        messages.length = 0; // mutate in place — same array ref the loop holds
        messages.push({ role: "system", content: systemMessage });
        forgetFilesExcept([]);
        clearUndo();
        clearTodos();
        resetTeam();
        resetBoard();
        clearReasoning();
        clearToolCalls();
        setSessionId(newSessionId());
        note(chalk.dim("(history cleared)"));
        return true;
      case "/plan":
        if (isPlanMode()) {
          setPlanMode(false);
          setPlan(false);
          note(chalk.dim("(plan mode OFF — writing and executing tools enabled again)"));
        } else {
          setPlanMode(true);
          setPlan(true);
          messages.push({ role: "user", content: PLAN_MODE_NOTICE });
          note(chalk.dim("(plan mode ON — read-only research; the agent will present a plan for you to approve)"));
        }
        return true;
      case "/compact": {
        if (messages.length <= 1) {
          note(chalk.dim("(nothing to compact yet)"));
          return true;
        }
        setBusy(true);
        try {
          await compactHistory(messages, client, CONFIG.model, new AbortController().signal, note);
        } catch (err) {
          note(chalk.yellow(`compaction failed: ${(err as Error).message}`));
        } finally {
          setBusy(false);
        }
        return true;
      }
      case "/resume": {
        const sessions = listSessions(10);
        if (!sessions.length) {
          note(chalk.dim("(no saved sessions in this project yet)"));
          return true;
        }
        const labels = sessions.map((s) => `${s.savedAt.slice(0, 16).replace("T", " ")} · ${s.messageCount} msg · ${s.title.slice(0, 60)}`);
        openSelect("recent sessions in this project:", labels, (i) => {
          if (i < 0) return note(chalk.dim("(cancelled)"));
          const chosen = loadSession(sessions[i].id);
          if (!chosen) return note(chalk.yellow("(could not load that session — it may be corrupt)"));
          messages.length = 0;
          messages.push({ role: "system", content: systemMessage }, ...chosen.messages);
          setSessionId(chosen.id);
          forgetFilesExcept([]);
          clearUndo();
          clearTodos();
          resetTeam();
          resetBoard();
          note(chalk.dim(`(resumed ${chosen.id} — ${chosen.messages.length} messages; files must be re-read before editing)`));
        });
        return true;
      }
      default:
        if (line.startsWith("/")) {
          note(chalk.dim(`unknown command: ${line} — try /help`));
          return true; // consumed — don't send typos to the model
        }
        return false; // a normal task line
    }
  };

  // Graceful exit: SessionEnd hooks (tiny budget — the user may be leaving), then unmount.
  const doExit = async () => {
    try {
      await runHooks("SessionEnd", {});
    } catch {
      /* never block exit on a hook */
    }
    emit("agent_session_end");
    tuiCleanup();
    exit();
  };

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      tuiCleanup();
      return exit(); // Ctrl+C quits immediately (process.on exit cleans up MCP/background)
    }

    // A select menu is up (approval / model / resume): ↑↓ move, Enter choose, Esc cancel.
    if (pending?.kind === "select") {
      const n = pending.options.length;
      if (key.upArrow) setMenuSel((i) => (i - 1 + n) % n);
      else if (key.downArrow) setMenuSel((i) => (i + 1) % n);
      else if (key.return || key.escape) {
        const choice = key.escape ? -1 : menuSel;
        const onChoose = pending.onChoose;
        setPending(null);
        onChoose(choice);
      }
      return;
    }

    // The ask_user form is up: reuse form.ts's pure state machine verbatim.
    if (pending?.kind === "form" && formState) {
      if (key.upArrow) setFormState(reduceForm(pending.questions, formState, "up").state);
      else if (key.downArrow || key.tab) setFormState(reduceForm(pending.questions, formState, "down").state);
      else if (key.return || char === " ") {
        const next = reduceForm(pending.questions, formState, "select");
        setFormState(next.state);
        if (next.done) {
          pending.resolve(collectAnswers(pending.questions, next.state));
          setPending(null);
          setFormState(null);
        }
      } else if (key.escape) {
        pending.resolve(null);
        setPending(null);
        setFormState(null);
      }
      return;
    }

    if (busy) return; // a turn in flight with no prompt — ignore typing for now (type-ahead is later)
    if (key.return) {
      const text = input.trim();
      setInput("");
      if (!text) return;
      if (text === "exit" || text === "quit") {
        void doExit();
        return;
      }
      void handleCommand(text).then((handled) => {
        if (!handled) runConversationTurn(text, { kind: "user", text });
      });
    } else if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
    } else if (char && !key.ctrl && !key.meta) {
      setInput((s) => s + char); // ordinary typing
    }
  });

  return (
    <Box flexDirection="column">
      {/* committed conversation — rendered once each, then left in the scrollback */}
      <Static items={items}>{(item, i) => <ItemView key={i} item={item} />}</Static>

      {/* the live, streaming reply (moves into <Static> when it finishes) */}
      {live !== null && (
        <Box marginTop={1} flexDirection="row">
          <Text color="green">⏺ </Text>
          <Box flexGrow={1}>
            <Text>{live === "" ? chalk.dim("…") : live}</Text>
          </Box>
        </Box>
      )}

      {/* the "thinking" / "running tool" spinner */}
      {status !== null && (
        <Box marginTop={live === null ? 1 : 0}>
          <Spinner />
          <Text> {status}</Text>
        </Box>
      )}

      {/* a select menu the loop or a slash command is blocked on */}
      {pending?.kind === "select" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">{pending.header}</Text>
          <Text>{renderMenu(pending.options, menuSel)}</Text>
          <Text>{MENU_HINT}</Text>
        </Box>
      )}

      {/* the ask_user multi-question form */}
      {pending?.kind === "form" && formState && (
        <Box marginTop={1}>
          <Text>{renderForm(pending.questions, formState)}</Text>
        </Box>
      )}

      {/* the pinned input box — stays at the bottom, conversation scrolls above it */}
      <Box borderStyle="round" borderColor={planMode ? "magenta" : "cyan"} paddingX={1} marginTop={1}>
        <Text color={planMode ? "magenta" : "cyan"}>{planMode ? "plan ❯ " : "❯ "}</Text>
        <Text>{input}</Text>
        <Text inverse> </Text>
      </Box>
      <StatusBar model={model} dir={dir} branch={branch} status={getStatus()} />
    </Box>
  );
}

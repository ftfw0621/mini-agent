import React, { useState, useEffect, useRef } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import chalk from "chalk";
import { formatElapsed, renderMenu, MENU_HINT, formatModelChoices } from "../ui.js"; // status format + the SAME pure menu renderer the readline REPL uses
import { renderMarkdown } from "../markdown.js"; // model speaks markdown → ANSI, same as the non-Ink REPL
import { initFormState, reduceForm, renderForm, collectAnswers, type FormQuestion, type FormState, type FormAnswer } from "../form.js"; // the ask_user form: pure state machine + renderer
import { CONFIG, saveGlobalSetting } from "../config.js"; // session allowlist + /model save
import { TerminateReason, type LoopResult, listAgentViews } from "../loop.js"; // how a turn can end
import { compactHistory, COMPACT_AT } from "../context.js"; // /compact
import { forgetFilesExcept } from "../tools.js"; // /clear resets the file read-state
import { clearUndo } from "../undo.js";
import { clearTodos } from "../todos.js";
import { resetTeam } from "../team.js";
import { resetBoard } from "../board.js";
import { clearReasoning, clearToolCalls, getReasoning, getToolCalls, getToolActivity, getToolCallCount, cleanup as tuiCleanup } from "../tui.js";
import { expandMentions } from "../mentions.js"; // @file mentions → attach file contents
import { normalizeDroppedPaths } from "../drop.js"; // drag-and-drop a file → its absolute path in the input
import { cronItemsPending, consumeCronQueue, cronTriggerContent } from "../cron.js"; // cron scheduler (Day s14): fire scheduled jobs autonomously while idle
import { newSessionId, saveSession, listSessions, loadSession, setSessionTitle } from "../session.js";
import { generateSessionTitle, setTerminalTitle } from "../title.js"; // concise session name, generated after the first message + the terminal tab that shows it
import { isPlanMode, setPlanMode } from "../permissions.js";
import { findSkill, skillInstructions } from "../skills.js";
import { extractMemories } from "../memory.js";
import { displayWidth } from "../editor.js"; // display-width measurement (CJK-aware)
import { runHooks } from "../hooks.js";
import { emit } from "../telemetry.js";
import { reviewDebugCommand } from "../auto-debug.js";
import type { ClipboardSource } from "../clipboard.js";
import { readClipboard, imageLabel, imagesInInput, userContent, MAX_IMAGES, type ImageAttachment } from "../images.js";
import { FollowUpQueue } from "../follow-up.js";
import { AgentList, moveAgentFocus } from "./agents.js";
import { detailPage, summarizeActivity } from "./activity.js";
import { useTerminalSize } from "./viewport.js";
import { makeInkSink, type Item } from "./sink.js"; // turns the loop's output into React state
import { runInfoCommand, SESSION_HELP, mcpStatusText } from "./commands.js"; // the non-interactive slash commands + /mcp status
import { listMcpServers, mcpActionsFor, runMcpAction } from "../mcp.js"; // /mcp: list + per-server actions
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

const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

// Cap the live streaming preview to a terminal-aware tail. THIS IS LOAD-BEARING:
// Ink redraws the whole dynamic region (everything below <Static>) on every
// token, and when that region grows TALLER than the terminal, Ink can no longer
// erase its previous frame — committed lines get reprinted (duplicate messages)
// and the cursor math drifts (sudden blank gaps). So we never let the in-flight
// answer render more than the rows we can spare; the FULL reply still commits to
// <Static> (formatted as markdown) the moment it finishes.
function liveTail(s: string, rows: number, columns: number, queued: boolean): string {
  // Keep the preview SMALL (≤10 lines) even on a tall terminal: Ink repaints this
  // whole region on every (throttled) update, and a smaller block repaints with
  // far less flicker. The full reply still lands in <Static> on commit.
  const maxLines = Math.max(1, Math.min(10, rows - (queued ? 26 : 20)));
  const page = detailPage(s, 0, maxLines, Math.max(1, columns - 2));
  return (page.pages > 1 ? "… " : "") + page.text;
}

function Spinner() {
  const [f, setF] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setF((x) => (x + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);
  return <Text color="#D77757">{SPINNER_FRAMES[f]}</Text>;
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
    <Text wrap="truncate-end">
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text dimColor>{"  ·  "}</Text>}
          {p}
        </React.Fragment>
      ))}
    </Text>
  );
}

// One human note per non-Done ending, so the user always learns why a turn stopped.
const EXIT_NOTES: Partial<Record<TerminateReason, string>> = {
  [TerminateReason.CircuitBreaker]: "3 API failures in a row — stopping here.",
  [TerminateReason.RetryBudgetExhausted]: "Too many failed API calls — giving up. Check your network.",
  [TerminateReason.RateLimitBudgetExhausted]: "The provider keeps rate-limiting us. Wait a minute, then retry.",
  [TerminateReason.ContextTooLong]: "The conversation no longer fits the context window. Use /clear.",
  [TerminateReason.CompactionFailed]: "Automatic compaction kept failing. Use /clear to start fresh.",
  [TerminateReason.ImageInputRejected]: "The provider rejected this image request. Check image limits and use /model to select a vision-capable model at your current vendor, then retry (images remain in the conversation).",
  [TerminateReason.FatalApiError]: "Unrecoverable API error — check your API key and request.",
  [TerminateReason.UserInterrupt]: "Interrupted — back at the prompt.",
};

export function App({ session, runTurn, clipboard }: { clipboard?: ClipboardSource; session: InkSession; runTurn: (input: string | null, hooks: TurnHooks) => Promise<LoopResult> }) {
  const { rows, columns } = useTerminalSize();
  const { client, messages, systemMessage, costMeter, skills, judge, autoMode, model, dir, branch, getStatus } = session;

  // Seed the scrollback with the welcome banner + the dim startup notices.
  const [items, setItems] = useState<Item[]>(() => [{ kind: "note", text: session.bannerText }, ...session.notices.map((n) => ({ kind: "note" as const, text: chalk.dim(n) }))]);
  const [status, setStatus] = useState<string | null>(null); // the live spinner line
  const [details, setDetails] = useState<"tools" | "reasoning" | null>(null);
  const [detailOffset, setDetailOffset] = useState(0);
  const [live, setLive] = useState<string | null>(null); // the streaming answer
  const [input, setInput] = useState(""); // the current input buffer
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const pasting = useRef(false);
  const imageSeq = useRef(0);
  const [cursor, setCursor] = useState(0); // caret position WITHIN `input` (0..input.length), for ←/→ editing
  const [busy, setBusy] = useState(false); // a turn is in flight
  const [pending, setPending] = useState<Pending | null>(null); // a prompt/menu blocking input
  const [menuSel, setMenuSel] = useState(0); // the select menu's cursor
  const [formState, setFormState] = useState<FormState | null>(null); // the ask_user form's state
  const [sessionId, setSessionId] = useState(session.initialSessionId); // changes on /clear, /resume
  const [planMode, setPlan] = useState(isPlanMode()); // mirrored into the prompt frame
  const [autoEnabled, setAutoEnabled] = useState(autoMode.enabled);
  const [histIdx, setHistIdx] = useState<number | null>(null); // ↑/↓ recall position (null = editing a fresh line)
  const [subAgentFocus, setSubAgentFocus] = useState<string | null>(null); // which sub-agent is highlighted (null = none)
  const [agentPage, setAgentPage] = useState(0);
  const [subAgentDetail, setSubAgentDetail] = useState<string | null>(null); // the id of the sub-agent whose output is shown in detail
  const [, setTick] = useState(0); // forces a re-render once a second so the clock / cost tick
  const followUps = useRef(new FollowUpQueue(() => setTick((t) => t + 1))).current;
  const submitting = useRef(false);
  const { exit } = useApp();

  const pushItem = useRef((it: Item) => setItems((xs) => [...xs, it])).current;
  const note = (text: string) => pushItem({ kind: "note", text });
  const sink = useRef(makeInkSink({ setStatus, setLive, pushItem })).current;
  const history = useRef<string[]>([]).current; // past prompts, for ↑/↓ recall
  const turn = useRef<{ controller: AbortController; interrupted: boolean } | null>(null); // the in-flight turn, for Esc-interrupt
  const titleAttempted = useRef(false); // one-shot: name the session once, after the first real message
  const pendingTitle = useRef<string | undefined>(undefined); // the generated title, passed into the next save

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Name the terminal tab from the first frame: the resumed session's title,
  // or just "mini-agent" until the first message earns a real one.
  useEffect(() => {
    setTerminalTitle(session.initialTitle);
  }, [session.initialTitle]);

  // Open a one-of-N menu and run `onChoose` with the picked index (-1 = cancel).
  const openSelect = (header: string, options: string[], onChoose: (i: number) => void) => {
    setDetails(null);
    setMenuSel(0);
    setPending({ kind: "select", header, options, onChoose });
  };

  // Run one conversation turn through the real loop. `display` is what scrolls up
  // as the prompt (a user highlight bar, or a note for /skill); the loop appends
  // `content` to `messages` itself. The permission menu + ask_user form raise a
  // `pending` prompt that returns a promise the loop awaits.
  const runConversationTurn = (content: string | null, display?: Item, attachments: readonly ImageAttachment[] = []) => {
    setDetails(null);
    setDetailOffset(0);
    if (display) pushItem(display);
    clearReasoning(); // Ctrl+R should reveal THIS turn's thinking
    clearToolCalls(); // ...and Ctrl+T THIS turn's tool calls
    setBusy(true);
    const controller = new AbortController();
    const tstate = { controller, interrupted: false };
    turn.current = tstate; // expose it so Esc can interrupt this turn
    const hooks: TurnHooks = {
      images: attachments,
      output: sink,
      confirm: (question, toolName) =>
        new Promise<boolean>((resolve) => {
          const allowLabel = toolName ? `Yes, and don't ask again for ${toolName} this session` : "Yes, and don't ask again this session";
          const options = autoMode.enabled ? ["Yes, once", "No — let me tell the agent what to do instead"] : ["Yes", allowLabel, "No — let me tell the agent what to do instead"];
          openSelect(`⚠ approval needed — ${question}`, options, (i) => {
            const approved = i === 0 || (!autoMode.enabled && i === 1);
            if (!autoMode.enabled && approved && i === 1 && toolName) CONFIG.permissions.allow.push(`tool:${toolName}`); // "don't ask again" → session allowlist
            note(`${chalk.yellow("⚠ approval")} — ${question.split("\n")[0]} → ${approved ? chalk.green("✓ approved") : chalk.yellow("✗ declined")}`);
            resolve(approved);
          });
        }),
      askUser: (questions) =>
        new Promise<FormAnswer[] | null>((resolve) => {
          if (!questions.length) return resolve(null);
          setDetails(null);
          setFormState(initFormState(questions));
          setPending({ kind: "form", questions, resolve });
        }),
      signal: controller.signal,
      isInterrupted: () => tstate.interrupted, // polled between steps for a clean stop
      judge,
      autoMode,
      followUps,
      onFollowUp: (text) => pushItem({ kind: "user", text }),
    };
    runTurn(content, hooks)
      .then(async (result: LoopResult) => {
        if (result.reason !== TerminateReason.Done && !(result.reason === TerminateReason.UserInterrupt && followUps.size)) note(chalk.yellow(`⚠️ ${EXIT_NOTES[result.reason] ?? result.reason}`));
        saveSession(sessionId, model, messages, pendingTitle.current); // snapshot after every turn — crash-safe by construction
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
        turn.current = null;
        setBusy(false);
        setStatus(null);
        setLive(null);
      });
  };

  // Covers immediate interruption and a message arriving as the turn finishes.
  // The queue survives the old turn; the new controller has a fresh abort signal.
  useEffect(() => {
    if (!busy && !pending && !turn.current && followUps.size) runConversationTurn(null);
  });

  // The cron IDLE PROCESSOR (Day s14): the scheduler fires jobs into a queue, but
  // injectCronMessages only drains it mid-turn — so a job that fires while you're
  // at the prompt would never run on its own. Here, while idle (no turn, no menu),
  // we poll the queue and start a turn for any fired job: the agent does the work
  // and reports the result into the conversation, autonomously — like Claude Code.
  // Effect re-subscribes on busy/pending changes so the closure always sees the
  // current `runConversationTurn`; it only installs the poll when truly idle.
  useEffect(() => {
    if (busy || pending || followUps.size) return; // human follow-ups take priority
    const id = setInterval(() => {
      if (!cronItemsPending()) return;
      const fired = consumeCronQueue();
      if (!fired.length) return;
      const content = fired.map(cronTriggerContent).join("\n\n---\n\n");
      const label = fired.length === 1 ? `⏰ cron ${fired[0].id} fired (${fired[0].cron})` : `⏰ ${fired.length} cron jobs fired`;
      runConversationTurn(content, { kind: "note", text: chalk.cyan(label) }); // a cron NOTE (not a user bar); the agent runs it + reports
    }, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, pending]);

  // A normal (non-command) prompt: run UserPromptSubmit hooks, expand @file
  // mentions, then start the turn. Mirrors agent.ts's submit path.
  const submitLine = async (text: string, attachments: readonly ImageAttachment[] = [], immediate = false) => {
    if (turn.current && (text.startsWith("/") || text === "exit" || text === "quit")) {
      note(chalk.dim("Commands are available when the agent is idle; use Esc to interrupt."));
      return;
    }
    if (text === "exit" || text === "quit") return doExit();
    if (await handleCommand(text)) return; // slash commands never reach the model
    const hook = await runHooks("UserPromptSubmit", { prompt: text });
    if (hook.block) return note(chalk.yellow(`(prompt blocked by a UserPromptSubmit hook: ${hook.feedback.slice(0, 150)})`));
    const injected = hook.stdout ? `\n\n[context added by a UserPromptSubmit hook]\n${hook.stdout}` : "";
    const { augmented, mentions } = expandMentions(text);
    const attached = mentions.filter((m) => m.status === "ok").map((m) => m.raw);
    const refused = mentions.filter((m) => m.status === "denied").map((m) => m.raw);
    if (attached.length) note(chalk.dim(`(attached ${attached.length} file${attached.length === 1 ? "" : "s"}: ${attached.join(", ")})`));
    if (refused.length) note(chalk.yellow(`(refused secret file${refused.length === 1 ? "" : "s"}: ${refused.join(", ")})`));

    // Name the session once, after the first real user message. A cheap model
    // call distills the prompt into a 3-7 word title (like Claude Code's aiTitle);
    // it runs fire-and-forget so it never delays the turn, and a failure just
    // leaves the raw first prompt as the title. Resumed sessions that already
    // have a title are left alone.
    if (!titleAttempted.current) {
      titleAttempted.current = true;
      if (!loadSession(sessionId)?.title) {
        void generateSessionTitle(client, CONFIG.subAgentModel || CONFIG.model, text)
          .then((title) => {
            if (title) {
              pendingTitle.current = title;
              setSessionTitle(sessionId, title);
              setTerminalTitle(title); // and rename the terminal tab, like Claude Code does
            }
          })
          .catch(() => {});
      }
    }

    if (turn.current || followUps.size) {
      followUps.enqueue({ text, content: userContent(augmented + injected, attachments) });
      if (immediate) interruptForFollowUp();
      return;
    }
    autoMode.recordRequest(text); // before attached files or hook output can masquerade as user intent
    runConversationTurn(augmented + injected, { kind: "user", text }, attachments); // show the original line; send the augmented content
  };

  const interruptForFollowUp = () => {
    const current = turn.current;
    if (!current || current.interrupted || !followUps.size) return;
    current.interrupted = true;
    current.controller.abort();
    note(chalk.dim("(interrupting the current step to process your follow-up)"));
  };

  // Handle a /slash command. Returns true if the line was a command (handled).
  // /mcp — list configured servers + status, then pick one to manage it.
  const handleMcpCommand = async (arg: string) => {
    const parts = arg.trim().split(/\s+/).filter(Boolean);

    // Direct subcommands (scriptable, matching Claude Code): /mcp reconnect|auth|enable|disable <name>
    if (parts.length >= 2 && ["reconnect", "auth", "authenticate", "enable", "disable"].includes(parts[0])) {
      const name = parts.slice(1).join(" ");
      setBusy(true);
      try {
        const action = parts[0] === "auth" || parts[0] === "authenticate" ? "authenticate" : (parts[0] as "reconnect" | "enable" | "disable");
        const msg = await runMcpAction(name, action, (url) => note(chalk.dim(`authenticate in your browser: ${url}`)));
        note(chalk.dim(msg));
      } catch (err) {
        note(chalk.yellow((err as Error).message));
      } finally {
        setBusy(false);
      }
      return;
    }

    const servers = listMcpServers();
    if (!servers.length) {
      note(chalk.dim("(no MCP servers configured — add an mcpServers map to .mini-agent/settings.json or ~/.config/mini-agent/settings.json)"));
      return;
    }
    const labels = servers.map((s) => `${s.name}  ·  ${mcpStatusText(s)}${s.tools ? `  ·  ${s.tools} tool${s.tools === 1 ? "" : "s"}` : ""}${s.transport === "http" ? "  ·  http" : "  ·  stdio"}`);
    openSelect("MCP servers (pick one to manage):", labels, (i) => {
      if (i < 0) return note(chalk.dim("(cancelled)"));
      const server = servers[i];
      const actions = mcpActionsFor(server);
      openSelect(`${server.name} — ${mcpStatusText(server)}`, actions.map((a) => a.label), (j) => {
        if (j < 0) return note(chalk.dim("(cancelled)"));
        setBusy(true);
        runMcpAction(server.name, actions[j].action, (url) => note(chalk.dim(`authenticate in your browser: ${url}`)))
          .then((msg) => note(chalk.dim(msg)))
          .catch((err) => note(chalk.yellow((err as Error).message)))
          .finally(() => setBusy(false));
      });
    });
  };

  const handleCommand = async (line: string): Promise<boolean> => {
    const debug = reviewDebugCommand(line);
    if (debug !== null) { note(chalk.dim(debug)); return true; }
    if (line === "/auto") {
      note(chalk.dim(autoMode.toggle()));
      setAutoEnabled(autoMode.enabled);
      return true;
    }
    const info = runInfoCommand(line, { skills, costMeter }); // /help /cost /memory /stats /todos /bg /team /tasks /skills /undo /diff
    if (info !== null) {
      note(info);
      return true;
    }

    // /mcp [reconnect|auth|enable|disable <name>]
    if (line === "/mcp" || line.startsWith("/mcp ")) {
      await handleMcpCommand(line.slice("/mcp".length).trim());
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
      autoMode.recordRequest(`Run the "${s.name}" skill.`);
      runConversationTurn(`Run the "${s.name}" skill.\n\n${skillInstructions(s)}`, { kind: "note", text: chalk.dim(`(running skill: ${s.name})`) });
      return true;
    }

    switch (line) {
      case "/clear":
        autoMode.clearRequests();
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
        titleAttempted.current = false; // a fresh session gets its own title on its first message
        pendingTitle.current = undefined;
        setTerminalTitle(undefined); // the tab no longer describes the old conversation
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
          autoMode.clearRequests();
          messages.push({ role: "system", content: systemMessage }, ...chosen.messages);
          setSessionId(chosen.id);
          titleAttempted.current = false; // a resumed session without a title gets one on its next message
          pendingTitle.current = chosen.title;
          setTerminalTitle(chosen.title ?? sessions[i].title.slice(0, 40)); // the tab follows the resumed session (raw prompt if never titled)
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

    if (key.ctrl && char === "v" && !pending && subAgentFocus === null) {
      if (pasting.current) return;
      pasting.current = true;
      const id = ++imageSeq.current;
      void readClipboard(id, clipboard).then((clipboard) => {
        if (clipboard.image) {
          if (imagesInInput(input, images).length >= MAX_IMAGES) {
            note(chalk.yellow(`Attach at most ${MAX_IMAGES} images per message.`));
            return;
          }
          const label = imageLabel(id);
          setImages((current) => [...imagesInInput(input, current), clipboard.image!]);
          setInput((current) => current.slice(0, cursor) + label + current.slice(cursor));
          setCursor(cursor + label.length);
        } else if (clipboard.text) {
          setInput((current) => current.slice(0, cursor) + clipboard.text + current.slice(cursor));
          setCursor(cursor + clipboard.text.length);
        } else note(chalk.dim("Clipboard has no image or text."));
      }).catch(() => note(chalk.yellow("Could not read the clipboard. Check clipboard access and image size (5 MB max). Linux requires wl-paste or xclip.")))
        .finally(() => { pasting.current = false; });
      return;
    }
    if (pasting.current) return; // keep the insertion position stable during native clipboard access

    // Details stay in the transient viewport: toggling never appends history.
    if (!pending && key.ctrl && (char === "r" || char === "t")) {
      const next = char === "t" ? "tools" : "reasoning";
      setDetails((current) => current === next ? null : next);
      setDetailOffset(0);
      setSubAgentDetail(null);
      setSubAgentFocus(null);
      return;
    }
    if (details && !pending) {
      if (key.escape) { setDetails(null); return; }
      if (key.pageUp || key.upArrow) { setDetailOffset((n) => Math.min(n + 1, detailView.pages - 1)); return; }
      if (key.pageDown || key.downArrow) { setDetailOffset((n) => Math.max(0, n - 1)); return; }
    }

    // Esc while a sub-agent detail is open: close it, don't interrupt.
    if (key.escape && (subAgentDetail || subAgentFocus !== null) && !pending) {
      setSubAgentDetail(null);
      setSubAgentFocus(null);
      return;
    }

    // Esc while a turn runs (and no menu is up): interrupt it — like the first
    // Ctrl+C of the readline REPL, without the force-quit escalation.
    if (key.escape && busy && !pending) {
      if (followUps.size) { interruptForFollowUp(); return; }
      const t = turn.current;
      if (t && !t.interrupted) {
        t.interrupted = true; // the loop polls this between steps
        t.controller.abort(); // cancel the in-flight API request
        note(chalk.yellow("(esc — interrupting; back at the prompt)"));
      }
      return;
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

    // Agent navigation has its own focus. Typing/history keeps arrow keys
    // until Tab, left at the input boundary, or down from an empty input.
    const ids = ["main", ...listAgentViews().map((a) => a.id)];
    if (ids.length > 1) {
      if (subAgentFocus !== null) {
        if (key.escape || key.rightArrow) { setSubAgentFocus(null); setSubAgentDetail(null); return; }
        if (key.upArrow || key.downArrow || key.tab) {
          const next = moveAgentFocus(ids, subAgentFocus, key.upArrow || (key.tab && key.shift) ? -1 : 1);
          setSubAgentFocus(next);
          if (subAgentDetail) setSubAgentDetail(next === "main" ? null : next);
          setAgentPage(0);
          return;
        }
        if (key.pageUp || key.pageDown) {
          setAgentPage((n) => Math.max(0, Math.min(agentDetailView.pages - 1, n + (key.pageUp ? 1 : -1))));
          return;
        }
        if (key.return) {
          setSubAgentDetail(subAgentFocus === "main" ? null : subAgentFocus);
          if (subAgentFocus === "main") setSubAgentFocus(null);
          setDetails(null);
          setAgentPage(0);
          return;
        }
        return; // the input buffer stays untouched while selecting an agent
      }
      if (key.tab || (key.leftArrow && cursor === 0) || (key.downArrow && !input && histIdx === null)) {
        setSubAgentFocus("main");
        setDetails(null);
        return;
      }
    }

    // Ink 5 strips the leading ESC from CSI-u / modifyOtherKeys sequences.
    const modifiedReturn = char === "[13;5u" || char === "[27;5;13~";
    if (key.return || modifiedReturn) {
      if (submitting.current || (busy && !turn.current)) return;
      const immediate = key.ctrl || modifiedReturn;
      if (!input.trim() && immediate && followUps.size) { interruptForFollowUp(); return; }
      // Dismiss the sub-agent detail/focus on a normal submit.
      setDetails(null);
      setSubAgentDetail(null);
      setSubAgentFocus(null);
      const text = input.trim();
      setInput("");
      setCursor(0);
      setHistIdx(null);
      const attachments = imagesInInput(text, images);
      setImages([]);
      if (!text) return;
      if (text.trim()) history.push(text); // remember non-empty entries for ↑/↓
      submitting.current = true;
      void submitLine(text, attachments, immediate)
        .catch((error) => note(chalk.yellow(`Could not submit message: ${error instanceof Error ? error.message : String(error)}`)))
        .finally(() => { submitting.current = false; });
    } else if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1)); // move the caret left within the line
    } else if (key.rightArrow) {
      setCursor((c) => Math.min(input.length, c + 1)); // ...and right
    } else if (key.ctrl && char === "a") {
      setCursor(0); // Home — jump to the start of the line
    } else if (key.ctrl && char === "e") {
      setCursor(input.length); // End — jump to the end of the line
    } else if (key.upArrow) {
      // ↑ recall an earlier prompt (newest-first), like a shell; caret to its end.
      if (!history.length) return;
      const idx = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setInput(history[idx]);
      setCursor(history[idx].length);
    } else if (key.downArrow) {
      // ↓ walk back toward the fresh line.
      if (histIdx === null) return;
      const idx = histIdx + 1;
      if (idx >= history.length) {
        setHistIdx(null);
        setInput("");
        setCursor(0);
      } else {
        setHistIdx(idx);
        setInput(history[idx]);
        setCursor(history[idx].length);
      }
    } else if (key.backspace || key.delete) {
      // Delete the char BEFORE the caret. Both Backspace and macOS DEL land here,
      // so this is always a backward delete (forward-delete is rare; we skip it).
      const attachment = images.find((image) => input.slice(0, cursor).endsWith(imageLabel(image.id)));
      if (attachment) {
        const length = imageLabel(attachment.id).length;
        setInput(input.slice(0, cursor - length) + input.slice(cursor));
        setCursor(cursor - length);
        setImages(images.filter((image) => image.id !== attachment.id));
      } else if (cursor > 0) {
        setInput(input.slice(0, cursor - 1) + input.slice(cursor));
        setCursor(cursor - 1);
      }
    } else if (char && !key.ctrl && !key.meta) {
      // Insert at the caret (a bulk chunk — paste / dropped file path — is
      // normalized: a dropped file becomes a clean absolute path; prose unchanged).
      const add = char.length > 1 ? normalizeDroppedPaths(char) : char;
      setHistIdx(null);
      setInput(input.slice(0, cursor) + add + input.slice(cursor));
      setCursor(cursor + add.length);
    }
  });

  const agents = listAgentViews();
  const selectedAgent = agents.find((a) => a.id === subAgentDetail);
  const agentDetailView = detailPage(selectedAgent?.transcript || "(Waiting for activity…)", agentPage, Math.max(1, Math.min(10, rows - 10)), Math.max(1, columns - 4));
  const detailView = detailPage(details === "tools" ? getToolCalls() ?? "No tool calls this turn." : details === "reasoning" ? getReasoning() ?? "No thinking recorded this turn." : "", detailOffset, Math.max(1, Math.min(12, rows - 9)), Math.max(1, columns - 4));
  const activity = rows >= 20 && busy && !details && !pending && !subAgentDetail && !followUps.size ? summarizeActivity(getToolActivity(), Date.now(), rows >= 30 && !agents.length ? 2 : 1) : [];

  return (
    <Box flexDirection="column">
      {/* committed conversation — rendered once each, then left in the scrollback */}
      <Static items={items}>{(item, i) => <ItemView key={i} item={item} />}</Static>

      {/* Ink must be able to erase this entire region. Static scrollback is
          outside the bound; dynamic panels can never grow to a full screen. */}
      <Box flexDirection="column" height={!pending && (details || selectedAgent) ? Math.max(1, rows - 1) : undefined} overflow="hidden">

      {/* the live, streaming reply (moves into <Static> when it finishes) */}
      {live !== null && !details && !pending && !selectedAgent && (
        <Box marginTop={rows >= 20 ? 1 : 0} flexDirection="row">
          <Text color="green">⏺ </Text>
          <Box flexGrow={1}>
            <Text>{live === "" ? chalk.dim("…") : liveTail(live, rows, columns, followUps.size > 0)}</Text>
          </Box>
        </Box>
      )}

      {/* Recent tool groups replace themselves in place, never in <Static>. */}
      {activity.map((group, i) => (
        <Box key={i} flexDirection="column" marginTop={i === 0 ? 1 : 0}>
          <Text wrap="truncate-end"><Text color={group.failed ? "yellow" : group.running ? "cyan" : "green"}>● </Text><Text bold>{group.title}</Text></Text>
          <Text dimColor wrap="truncate-end">  ⎿ {group.detail}</Text>
        </Box>
      ))}

      {/* The animation remains active while calling a model or executing tools. */}
      {!details && !pending && !selectedAgent && (status !== null || busy) && (
        <Box marginTop={rows >= 20 ? 1 : 0}>
          <Spinner />
          <Text color="#D77757" wrap="truncate-end"> {status?.replace("Ctrl+C to interrupt", "Esc to interrupt") ?? (live !== null ? "Writing…" : "Working…")}</Text>
        </Box>
      )}
      {rows >= 20 && !details && !selectedAgent && !pending && (busy || getToolCallCount() > 0) && (
        <Text dimColor wrap="truncate-end">  {getToolCallCount()} tool calls · Ctrl+T details · Ctrl+R thinking{busy ? " · Esc interrupt" : ""}</Text>
      )}

      {details && !pending && (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text dimColor wrap="truncate-end">{details === "tools" ? "Tool details" : "Thinking"} · {detailView.pages - detailView.page}/{detailView.pages} · ↑↓ page · Esc close{followUps.size ? ` · ${followUps.size} queued` : ""}</Text>
          <Text>{detailView.text}</Text>
        </Box>
      )}

      {selectedAgent && !pending && (
        <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1}>
          <Text bold color="cyan" wrap="truncate-end">{selectedAgent.name} · {selectedAgent.model} · {selectedAgent.status} · Esc main</Text>
          <Box>{selectedAgent.status === "running" && <Spinner />}<Text dimColor wrap="truncate-end"> {selectedAgent.activity} · {selectedAgent.toolCalls} tools · PgUp/PgDn details</Text></Box>
          <Text>{agentDetailView.text}</Text>
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

      {/* the pinned input box — stays at the bottom, conversation scrolls above it.
          The caret is drawn AT its position: the char under it is inverted (a block
          cursor), with the text before and after around it; at end-of-line the
          inverted cell is a space. This is what makes ←/→ visibly move the cursor.
          Input is manually wrapped into visual lines so the cursor tracks correctly
          when text exceeds the terminal width. */}
      {!details && !selectedAgent && !pending && followUps.size > 0 && (
        <Box flexDirection="column" marginTop={rows >= 20 ? 1 : 0}>
          <Text dimColor wrap="truncate-end">Messages queued for the next tool boundary · Esc / Ctrl+Enter interrupt and send</Text>
          {followUps.pending.slice(rows >= 20 ? -2 : -1).map((message, i) => <Text key={i} dimColor wrap="truncate-end">  ↳ {message.text}</Text>)}
          {followUps.size > 2 && <Text dimColor>  … {followUps.size - 2} earlier messages queued</Text>}
        </Box>
      )}
      <Box borderStyle="round" borderColor={planMode ? "magenta" : autoEnabled ? "yellow" : "cyan"} paddingX={1} marginTop={rows >= 20 ? 1 : 0} flexDirection="column" flexShrink={0}>
        {(() => {
          const prompt = planMode ? "plan ❯ " : autoEnabled ? "auto ❯ " : "❯ ";
          const promptColor = planMode ? "magenta" : autoEnabled ? "yellow" : "cyan";
          const cols = columns;
          const innerWidth = Math.max(10, cols - 4); // border(2) + paddingX(2)
          const promptW = displayWidth(prompt);
          const firstW = Math.max(1, innerWidth - promptW);

          // Build visual lines display-width-aware (CJK, emoji = 2 cols).
          const lines: string[] = [""];
          let row = 0;
          let col = 0;
          // Cursor tracking: map code-unit offset → (line, display-column).
          let cursorLine = 0;
          let cursorCol = 0;
          let set = false;
          let cu = 0; // code-unit offset, for matching `cursor`

          for (const ch of input) {
            if (!set && cu === cursor) { cursorLine = row; cursorCol = col; set = true; }
            const cw = displayWidth(ch);
            const limit = row === 0 ? firstW : innerWidth;
            if (col + cw > limit) { row++; col = 0; lines[row] = ""; }
            lines[row] += ch;
            col += cw;
            cu += ch.length;
          }
          if (!set) { cursorLine = row; cursorCol = col; } // cursor at end
          // Cursor exactly at edge → wrap to start of next line for visibility
          const edge = cursorLine === 0 ? firstW : innerWidth;
          if (cursorCol >= edge) { cursorLine++; cursorCol = 0; if (lines.length <= cursorLine) lines.push(""); }

          // Map display-column back to code-unit offset within the target line.
          const cursorLineText = lines[cursorLine] ?? "";
          let cuOff = 0;  // code-unit offset into cursorLineText that matches cursorCol
          let dcol = 0;
          for (const ch of cursorLineText) {
            if (dcol >= cursorCol) break;
            dcol += displayWidth(ch);
            cuOff += ch.length;
          }

          // Long drafts must not grow the redraw region. Keep the cursor's
          // neighborhood visible; the complete draft remains in input state.
          const visibleRows = details || selectedAgent || followUps.size || rows < 20 ? 1 : 3;
          const startLine = Math.max(0, cursorLine - visibleRows + 1);
          return lines.slice(startLine, startLine + visibleRows).map((line, offset) => {
            const i = startLine + offset;
            if (i === cursorLine) {
              const before = line.slice(0, cuOff);
              const at = line.slice(cuOff, cuOff + 1) || " ";
              const after = line.slice(cuOff + 1);
              return (
                <Box key={i}>
                  {i === 0 && <Text color={promptColor}>{prompt}</Text>}
                  <Text>{before}</Text>
                  <Text inverse>{at}</Text>
                  <Text>{after}</Text>
                </Box>
              );
            }
            return (
              <Box key={i}>
                {i === 0 && <Text color={promptColor}>{prompt}</Text>}
                <Text>{line}</Text>
              </Box>
            );
          });
        })()}
      </Box>
      {rows >= 20 && busy && !details && !selectedAgent && !pending && <Text dimColor wrap="truncate-end">Enter queue follow-up · Ctrl+Enter interrupt and send now</Text>}

      {rows >= 20 && !details && !selectedAgent && !pending && <AgentList agents={agents} focus={subAgentFocus} viewing={subAgentDetail} mainBusy={busy} maxRows={Math.max(2, Math.min(3, rows - 24))} />}
      <StatusBar model={CONFIG.model} dir={dir} branch={branch} status={getStatus()} />
      </Box>
    </Box>
  );
}

import React, { useState, useEffect, useRef } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import chalk from "chalk";
import { formatElapsed, renderMenu, MENU_HINT } from "../ui.js"; // elapsed-time format + the SAME pure menu renderer the readline REPL uses
import { renderMarkdown } from "../markdown.js"; // model speaks markdown → ANSI, same as the non-Ink REPL
import { initFormState, reduceForm, renderForm, collectAnswers, type FormQuestion, type FormState, type FormAnswer } from "../form.js"; // the ask_user form: pure state machine + renderer
import { CONFIG } from "../config.js"; // for the session allowlist ("don't ask again for <tool>")
import { TerminateReason, type LoopResult } from "../loop.js"; // how a turn can end
import { makeInkSink, type Item } from "./sink.js"; // turns the loop's output into React state
import type { TurnHooks } from "./chat.js"; // what one turn needs from the App

// A prompt the loop is waiting on: a yes/no/allow approval, or the multi-question
// ask_user form. Each carries the promise resolver the loop is awaiting, so a
// keystroke here unblocks the loop. Same UX as the readline REPL (promptSelect /
// promptForm), driven by Ink's useInput instead of raw keypress events.
type Pending =
  | { kind: "confirm"; question: string; options: string[]; toolName?: string; resolve: (approved: boolean) => void }
  | { kind: "form"; questions: FormQuestion[]; resolve: (answers: FormAnswer[] | null) => void };

// The Ink REPL. Claude Code's layout — a conversation that scrolls ABOVE a pinned
// input box — is what a full-screen TUI framework is FOR. <Static> commits each
// finished line to the scrollback once (it never re-renders); the streaming reply,
// the "thinking" spinner, the input box, and the status bar live in the dynamic
// area below, so the box stays put at the bottom and the conversation grows above
// it. The REAL agent loop drives this through the Ink output sink (sink.ts), so
// tools / retries / sub-agents all render here — no hand-rolled scroll regions,
// no fighting readline over stdin.

// What the bottom status bar needs, recomputed live (ctx% grows with history,
// cost accrues from the stream, the clock ticks).
export interface StatusData {
  ctxPct: number;
  cost: number;
  elapsedMs: number;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; // the braille spinner ora uses, hand-rolled for Ink

// A small animated spinner — Ink redraws it every frame, so we just cycle an index.
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
  // note — already chalk-formatted (tool tally, "💭 thought…", retries, team logs)
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

export function App({ model, dir, branch, getStatus, runTurn }: { model: string; dir: string; branch: string | null; getStatus: () => StatusData; runTurn: (input: string, hooks: TurnHooks) => Promise<LoopResult> }) {
  const [items, setItems] = useState<Item[]>([]); // committed scrollback (<Static>)
  const [status, setStatus] = useState<string | null>(null); // the live spinner line
  const [live, setLive] = useState<string | null>(null); // the streaming answer
  const [input, setInput] = useState(""); // the current input buffer
  const [busy, setBusy] = useState(false); // a turn is in flight
  const [pending, setPending] = useState<Pending | null>(null); // a permission/ask_user prompt the loop is blocked on
  const [menuSel, setMenuSel] = useState(0); // the confirm menu's cursor
  const [formState, setFormState] = useState<FormState | null>(null); // the ask_user form's state
  const [, setTick] = useState(0); // forces a re-render once a second so the clock / cost tick
  const { exit } = useApp();

  // The output sink + a pushItem helper, built ONCE (the setters are stable).
  const pushItem = useRef((it: Item) => setItems((xs) => [...xs, it])).current;
  const sink = useRef(makeInkSink({ setStatus, setLive, pushItem })).current;

  // Tick the clock so the status bar's time (and live cost) stay current.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Run one turn through the real loop. The permission prompt and the ask_user
  // form raise a `pending` prompt and return a promise the loop awaits; a keystroke
  // in useInput resolves it. Read-only tools never reach confirm (the gate allows
  // them silently); writes/bash do, and now get a real menu.
  const submit = (text: string) => {
    pushItem({ kind: "user", text });
    setBusy(true);
    const controller = new AbortController();
    const hooks: TurnHooks = {
      output: sink,
      confirm: (question, toolName) =>
        new Promise<boolean>((resolve) => {
          const allowLabel = toolName ? `Yes, and don't ask again for ${toolName} this session` : "Yes, and don't ask again this session";
          setMenuSel(0);
          setPending({ kind: "confirm", question, toolName, options: ["Yes", allowLabel, "No — let me tell the agent what to do instead"], resolve });
        }),
      askUser: (questions) =>
        new Promise<FormAnswer[] | null>((resolve) => {
          if (!questions.length) return resolve(null);
          setFormState(initFormState(questions));
          setPending({ kind: "form", questions, resolve });
        }),
      signal: controller.signal,
      isInterrupted: () => false,
    };
    runTurn(text, hooks)
      .then((result: LoopResult) => {
        if (result.reason !== TerminateReason.Done) pushItem({ kind: "note", text: chalk.yellow(`⚠️ ${EXIT_NOTES[result.reason] ?? result.reason}`) });
      })
      .catch((e: unknown) => pushItem({ kind: "note", text: chalk.red(`[error] ${(e as Error).message}`) }))
      .finally(() => {
        setBusy(false);
        setStatus(null);
        setLive(null);
      });
  };

  useInput((char, key) => {
    if (key.ctrl && char === "c") return exit(); // Ctrl+C quits

    // A permission prompt is up: ↑/↓ to move, Enter to choose, Esc = decline.
    if (pending?.kind === "confirm") {
      const n = pending.options.length;
      if (key.upArrow) setMenuSel((i) => (i - 1 + n) % n);
      else if (key.downArrow) setMenuSel((i) => (i + 1) % n);
      else if (key.return || key.escape) {
        const approved = !key.escape && (menuSel === 0 || menuSel === 1);
        if (approved && menuSel === 1 && pending.toolName) CONFIG.permissions.allow.push(`tool:${pending.toolName}`); // "don't ask again" → session allowlist
        pushItem({ kind: "note", text: `${chalk.yellow("⚠ approval")} — ${pending.question.split("\n")[0]} → ${approved ? chalk.green("✓ approved") : chalk.yellow("✗ declined")}` });
        pending.resolve(approved);
        setPending(null);
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
          pending.resolve(collectAnswers(pending.questions, next.state)); // submitted with all answered
          setPending(null);
          setFormState(null);
        }
      } else if (key.escape) {
        pending.resolve(null); // cancelled — the model is told to ask in prose instead
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
      if (text === "exit" || text === "quit") return exit();
      submit(text);
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

      {/* a permission prompt the loop is blocked on — reuses the readline REPL's menu */}
      {pending?.kind === "confirm" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">⚠ approval needed — {pending.question}</Text>
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
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
        <Text color="cyan">❯ </Text>
        <Text>{input}</Text>
        <Text inverse> </Text>
      </Box>
      <StatusBar model={model} dir={dir} branch={branch} status={getStatus()} />
    </Box>
  );
}

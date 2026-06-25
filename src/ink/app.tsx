import React, { useState, useEffect, useRef } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import chalk from "chalk";
import { formatElapsed } from "../ui.js"; // reuse the same elapsed-time formatting as the non-Ink status line
import { renderMarkdown } from "../markdown.js"; // model speaks markdown → ANSI, same as the non-Ink REPL
import { TerminateReason, type LoopResult } from "../loop.js"; // how a turn can end
import { makeInkSink, type Item } from "./sink.js"; // turns the loop's output into React state
import type { TurnHooks } from "./chat.js"; // what one turn needs from the App

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

  // Run one turn through the real loop. 2b: the permission prompt isn't wired into
  // Ink yet, so confirm declines (read-only tools still flow through — the gate
  // allows them without asking); the interactive menu/form arrive next increment.
  const submit = (text: string) => {
    pushItem({ kind: "user", text });
    setBusy(true);
    const controller = new AbortController();
    const hooks: TurnHooks = {
      output: sink,
      confirm: async (question) => {
        pushItem({ kind: "note", text: chalk.yellow(`⚠ approval needed — ${question.split("\n")[0]} — declined (the Ink approval prompt isn't wired yet)`) });
        return false;
      },
      askUser: undefined,
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
    if (busy) return; // 2b: no typing while the agent responds (type-ahead is a later increment)
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

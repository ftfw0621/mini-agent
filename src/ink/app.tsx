import React, { useState, useEffect } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import { formatElapsed } from "../ui.js"; // reuse the same elapsed-time formatting as the non-Ink status line

// The Ink REPL (increment 1 + status bar). Claude Code's layout — a conversation
// that scrolls ABOVE a pinned input box — is what a full-screen TUI framework is
// FOR. <Static> commits each finished message to the scrollback once (it never
// re-renders), while the streaming reply + the input box + the status bar live in
// the dynamic area below, so the box stays put at the bottom and the conversation
// grows above it. No hand-rolled scroll regions, no fighting readline over stdin.
export interface Msg {
  role: "user" | "assistant";
  text: string;
}

// What the bottom status bar needs, recomputed live (ctx% grows with history,
// cost accrues from the stream, the clock ticks).
export interface StatusData {
  ctxPct: number;
  cost: number;
  elapsedMs: number;
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

export function App({ model, dir, branch, getStatus, runTurn }: { model: string; dir: string; branch: string | null; getStatus: () => StatusData; runTurn: (input: string, onToken: (t: string) => void) => Promise<string> }) {
  const [history, setHistory] = useState<Msg[]>([]); // finished turns → <Static> (scrollback)
  const [input, setInput] = useState(""); // the current input buffer
  const [streaming, setStreaming] = useState<string | null>(null); // the live, not-yet-finished reply
  const [busy, setBusy] = useState(false); // a turn is in flight
  const [, setTick] = useState(0); // forces a re-render once a second so the clock / cost tick
  const { exit } = useApp();

  // Tick the clock so the status bar's time (and live cost) stay current.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useInput((char, key) => {
    if (key.ctrl && char === "c") return exit(); // Ctrl+C quits
    if (busy) return; // increment 1: no typing while the agent responds (type-ahead is a later increment)
    if (key.return) {
      const text = input.trim();
      setInput("");
      if (!text) return;
      if (text === "exit" || text === "quit") return exit();
      setHistory((h) => [...h, { role: "user", text }]); // your message scrolls up into the conversation
      setBusy(true);
      setStreaming("");
      void runTurn(text, (tok) => setStreaming((s) => (s ?? "") + tok)).then((final) => {
        setHistory((h) => [...h, { role: "assistant", text: final }]); // commit the finished reply
        setStreaming(null);
        setBusy(false);
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
      <Static items={history}>
        {(m, i) => (
          <Box key={i} flexDirection="column" marginTop={1}>
            {m.role === "user" ? <Text backgroundColor="gray" color="whiteBright">{`> ${m.text}`}</Text> : <Text color="green">{`⏺ ${m.text}`}</Text>}
          </Box>
        )}
      </Static>

      {/* the live, streaming reply (moves into <Static> when it finishes) */}
      {streaming !== null && (
        <Box marginTop={1}>
          <Text color="green">{streaming === "" ? "⏺ thinking…" : `⏺ ${streaming}`}</Text>
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

import React, { useState } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";

// The Ink REPL (increment 1). The whole point of moving to Ink: Claude Code's
// layout — a conversation that scrolls ABOVE a pinned input box — is what a
// full-screen TUI framework is FOR. <Static> commits each finished message to
// the scrollback once (it never re-renders), while the streaming reply + the
// input box live in the dynamic area below, so the box stays put at the bottom
// and the conversation grows above it. No hand-rolled scroll regions, no
// fighting readline over stdin.
export interface Msg {
  role: "user" | "assistant";
  text: string;
}

export function App({ model, runTurn }: { model: string; runTurn: (input: string, onToken: (t: string) => void) => Promise<string> }) {
  const [history, setHistory] = useState<Msg[]>([]); // finished turns → <Static> (scrollback)
  const [input, setInput] = useState(""); // the current input buffer
  const [streaming, setStreaming] = useState<string | null>(null); // the live, not-yet-finished reply
  const [busy, setBusy] = useState(false); // a turn is in flight
  const { exit } = useApp();

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
          <Text color="green">{`⏺ ${streaming}`}</Text>
        </Box>
      )}

      {/* the pinned input box — stays at the bottom, conversation scrolls above it */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
        <Text color="cyan">❯ </Text>
        <Text>{input}</Text>
        <Text inverse> </Text>
      </Box>
      <Text dimColor>{busy ? "  thinking…" : `  ${model} · type a message · Enter to send · 'exit' to quit`}</Text>
    </Box>
  );
}

import React, { useEffect, useState } from "react";
import { Box, Text, type Key } from "ink";
import { slashCompletions, type CompletionContext } from "../completion.js";

// Keep the full list in state, but render only a window around the selection.
// Long lists must never grow Ink's redraw region beyond the terminal height.
export function useSlashCompletion(input: string, enabled: boolean, context: CompletionContext, maxRows: number, columns = 80) {
  const [selection, setSelection] = useState({ input: "", index: 0 });
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => { setDismissed(null); }, [input]);
  const menu = enabled && dismissed !== input ? slashCompletions(input, context) : null;
  const items = menu?.items ?? [];
  const selected = Math.min(selection.input === input ? selection.index : 0, Math.max(0, items.length - 1));
  const count = Math.max(1, Math.min(6, maxRows)); // Claude Code shows at most 6, centred on the selection
  const start = Math.max(0, Math.min(selected - Math.floor(count / 2), items.length - count));
  const nameWidth = Math.min(Math.max(0, ...items.map((item) => item.value.length)) + 2, Math.floor(columns * 0.4));

  return {
    visible: menu !== null,
    handleKey: (key: Key, replace: (value: string) => void): { handled: boolean; submit?: string } => {
      if (!menu) return { handled: false };
      if (key.escape) { setDismissed(input); return { handled: true }; }
      if (!items.length) return { handled: false };
      if (key.upArrow || key.downArrow) {
        setSelection({ input, index: (selected + (key.upArrow ? -1 : 1) + items.length) % items.length });
        return { handled: true };
      }
      if (key.tab || (key.return && !key.ctrl && !key.meta)) {
        const item = items[selected];
        // Tab always just fills it in. Enter runs it — unless it takes
        // arguments (a skill with `arguments`, or a command with sub-choices),
        // then it fills "/name " so you can type them. (Claude Code's rule.)
        if (key.tab || item.children) replace(item.value + " ");
        else return { handled: true, submit: item.value };
        return { handled: true };
      }
      return { handled: false };
    },
    view: menu && (
      <Box flexDirection="column" paddingX={1}>
        {items.slice(start, start + count).map((item, i) => {
          const on = start + i === selected;
          // Names in one column (at most 40% of the width); the description is one line, cut to fit.
          return (
            <Text key={item.value} color={on ? "#B1B9F9" : undefined} dimColor={!on} wrap="truncate-end">
              {on ? "› " : "  "}{item.value.padEnd(nameWidth)}{item.description.replace(/\s+/g, " ")}
            </Text>
          );
        })}
        <Text dimColor wrap="truncate-end">{items.length ? `↑↓ choose · Tab complete · Enter select · Esc close · ${selected + 1}/${items.length}` : menu.hint || "No matching commands"}</Text>
      </Box>
    ),
  };
}

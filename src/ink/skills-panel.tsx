import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { nextSkillMode, nextSkillSort, setSkillMode, skillListingTokens, skillLocked, skillMode, skillPanelRows, skillSource, type Skill, type SkillMode, type SkillSort } from "../skills.js";

// /skills — Claude Code's skill manager. One row per skill on disk:
//   ❯ ✔ on         grill-me · user · ~20 tok
//     🔒 user-only  deploy · project · ~30 tok · locked by author
// Enter/space cycles on → user-only → off (saved at once, live on the next
// model call), "/" searches, "t" changes the sort, Esc closes. The panel owns
// its keys while it is open; the app's main handler stands aside.

const LAVENDER = "#B1B9F9";
const SORT_LABEL: Record<SkillSort, string> = { name: "name", tokens: "tokens", source: "source" };

function ModeCell({ mode, locked }: { mode: SkillMode; locked: boolean }) {
  if (locked) return <Text dimColor>{"🔒 user-only "}</Text>;
  if (mode === "on") return <Text color="green">{"✔ on        "}</Text>;
  if (mode === "user-only") return <Text color="yellow">{"◐ user-only "}</Text>;
  return <Text dimColor>{"○ off       "}</Text>;
}

export function SkillsPanel({ skills, maxRows, onClose }: { skills: Skill[]; maxRows: number; onClose: (summary: string) => void }) {
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<SkillSort>("name");
  const [, setVersion] = useState(0); // re-render after a mode change (modes live in CONFIG)
  const initial = useRef(new Map(skills.map((s) => [s.name, skillMode(s)]))).current; // for the summary on close

  const rows = skillPanelRows(skills, query, sort);
  const at = Math.min(cursor, Math.max(0, rows.length - 1));

  useInput((char, key) => {
    if (searching) {
      if (key.escape || key.return) { setSearching(false); if (key.escape) setQuery(""); return; }
      if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); setCursor(0); return; }
      if (key.upArrow || key.downArrow) { setSearching(false); } // fall through to navigation
      else if (char && !key.ctrl && !key.meta) { setQuery((q) => q + char); setCursor(0); return; }
      else return;
    }
    if (key.escape) {
      const changes = skills.filter((s) => initial.get(s.name) !== skillMode(s)).map((s) => `${s.name} → ${skillMode(s)}`);
      return onClose(changes.length ? `Skills updated: ${changes.join(", ")}` : "No changes");
    }
    if (key.upArrow) return setCursor((c) => (rows.length ? (Math.min(c, rows.length - 1) - 1 + rows.length) % rows.length : 0));
    if (key.downArrow) return setCursor((c) => (rows.length ? (Math.min(c, rows.length - 1) + 1) % rows.length : 0));
    if (char === "/") return setSearching(true);
    if (char === "t") return setSort((s) => nextSkillSort(s));
    if (key.return || char === " ") {
      const s = rows[at];
      if (!s || skillLocked(s)) return; // the author pinned it — nothing to cycle
      setSkillMode(s.name, nextSkillMode(skillMode(s)));
      setVersion((v) => v + 1);
    }
  });

  // A window of rows around the cursor, so a long list never outgrows the terminal.
  const count = Math.max(3, Math.min(rows.length, maxRows));
  const start = Math.max(0, Math.min(at - Math.floor(count / 2), rows.length - count));
  const shown = rows.slice(start, start + count);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={LAVENDER}>Skills</Text>
      <Text dimColor>{skills.length} skill{skills.length === 1 ? "" : "s"} · enter/space to cycle, / to search, t to sort ({SORT_LABEL[sort]}), Esc to close</Text>
      <Box borderStyle="round" borderColor={searching ? LAVENDER : "gray"} paddingX={1} marginTop={1}>
        <Text dimColor={!query && !searching}>⌕ {query || (searching ? "" : "Search skills…")}{searching ? <Text inverse> </Text> : null}</Text>
      </Box>
      {start > 0 && <Text dimColor>  ↑ {start} more above</Text>}
      {shown.map((s, i) => {
        const selected = start + i === at;
        const locked = skillLocked(s);
        return (
          <Text key={s.path || s.name} wrap="truncate-end">
            <Text color={LAVENDER}>{selected ? "❯ " : "  "}</Text>
            <ModeCell mode={skillMode(s)} locked={locked} />
            <Text bold={!selected} color={selected ? LAVENDER : undefined}> {s.name}</Text>
            <Text dimColor> · {skillSource(s)} · ~{skillListingTokens(s)} tok{locked ? " · locked by author" : ""}</Text>
          </Text>
        );
      })}
      {!rows.length && <Text dimColor>  {skills.length ? `No skills match "${query}"` : "No skills — add one at .mini-agent/skills/<name>/SKILL.md or ~/.config/mini-agent/skills/"}</Text>}
      {start + count < rows.length && <Text dimColor>  ↓ {rows.length - start - count} more below</Text>}
    </Box>
  );
}

import React from "react";
import { Box, Text } from "ink";
import type { AgentView } from "../agent-progress.js";
import { formatElapsed, formatTokens } from "../ui.js";

// Use stable IDs so a newly spawned worker cannot move keyboard focus.
export function moveAgentFocus(ids: readonly string[], current: string | null, delta: number): string | null {
  const index = current === null ? -1 : ids.indexOf(current);
  const next = index + delta;
  return next < 0 ? null : ids[Math.min(next, ids.length - 1)] ?? null;
}

export function AgentList({ agents, focus, viewing, mainBusy, maxRows = 5 }: {
  agents: readonly AgentView[]; focus: string | null; viewing: string | null; mainBusy: boolean; maxRows?: number;
}) {
  if (!agents.length) return null;
  const rows = [{ id: "main", name: "main", description: "", right: mainBusy ? "working" : "idle", failed: false }, ...agents.map((a) => ({
    id: a.id, name: a.name, description: a.description, failed: a.status === "failed",
    right: `${a.status === "running" ? a.activity : a.status} · ${formatElapsed(a.elapsedMs)} · ↓ ${a.estimated ? "~" : ""}${formatTokens(a.tokens)} tokens`,
  }))];
  const selected = Math.max(0, rows.findIndex((r) => r.id === (focus ?? viewing ?? "main")));
  const start = Math.max(0, Math.min(selected - maxRows + 1, rows.length - maxRows));
  return <Box flexDirection="column">
    <Text dimColor wrap="truncate-end">agents · Tab/← select · ↑↓ switch · Enter view · Esc back{rows.length > maxRows ? ` · ${start + 1}–${Math.min(rows.length, start + maxRows)}/${rows.length}` : ""}</Text>
    {rows.slice(start, start + maxRows).map((row) => {
      const highlighted = focus === row.id;
      const active = (viewing ?? "main") === row.id;
      return <Box key={row.id}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end" color={highlighted ? "cyan" : row.failed ? "yellow" : undefined} bold={active || highlighted} dimColor={!active && !highlighted}>
            {highlighted ? "❯" : active ? "●" : "○"} {row.name}{row.description ? ` · ${row.description}` : ""}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}><Text dimColor color={row.failed ? "yellow" : undefined}>{row.right}</Text></Box>
      </Box>;
    })}
  </Box>;
}

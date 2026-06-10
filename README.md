# mini-agent

A Claude Code-style CLI agent built from scratch in TypeScript, powered by the DeepSeek API.

10 days, one commit per day. **The commit history is the table of contents**: `git log --oneline` shows the outline, `git checkout dayN` gives you the complete code as it was at the end of day N.

## Quick start

```bash
npm install
cp .env.example .env   # fill in your DeepSeek API key
npm start
```

## Progress

| Tag | What's inside |
|---|---|
| `day1` | A raw tool-calling loop in ~50 lines: one tool, one loop, two safety nets |
| `day2` | The five core tools (read/write/edit/search/bash): read-before-edit, old_string uniqueness, a dispatch that never throws, four-element tool descriptions |

(updated daily)

## Companion tutorial (Chinese)

Each tag pairs with one tutorial chapter: why the code is written this way, what Claude Code itself does, and the pitfalls you would hit. Available on Xiaohongshu @(TBD).

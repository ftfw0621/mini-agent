# mini-agent

**跟着 AI,从零搓一个自己的 Claude Code**——一个能读文件、改代码、跑命令的命令行 Agent。TypeScript 实现,默认 DeepSeek 驱动(任何 OpenAI 兼容模型可配)。

人定方向、做决策、验收,AI 写大部分代码——这既是本仓库的诞生方式,也是这门课教你的工作方式。

课程共 35 天——主线 10 天搓出一个能用的 agent,进阶 25 天打磨成工业级 CLI(MCP / 权限裁判 / 长期记忆 / 成本核算 / 调用校验 / 计划模式 / diff 预览 / 撤销 / 模型分级 / 远程 MCP / 会话改动总览 / @file 引用 / 会话选择器 / 终端 UI / 方向键审批 / 多问题表单 / 模型切换 / 推理流 / Skill 系统 / 记忆深化 / Hook 深化);一天一个 commit、一晚一章的节奏跟做。**commit 历史就是课程目录**:`git log --oneline` 看大纲,`git checkout dayN` 拿到第 N 天对应的完整代码。

> **设计有出处,不是凭感觉搭的**:蓝本是《Harness Engineering:从 Claude Code 看 AI 编码工程》提炼的 22 个工程模式——博主在公众号用 30+ 篇拆完了全书(本仓库就是那次拆解的实践篇)。书的收官章,作者用 800 行 Rust 写了一个代码审查 Agent,验证这些模式能跨语言、跨场景活下来;**这个仓库是同一套模式的又一次迁移**:场景换成 Claude Code 式的 CLI 编码 agent,语言换成 TypeScript——不跟着用 Rust,是因为新手教程的第一原则是别让语言难度挡路。
>
> **用 AI 搓出一个类 Claude Code,这件事本身就是这套方法最好的 demo**——教程里每个「踩过的坑」都真实发生在开发过程中,不是编的。
>
> 代码、注释、commit message 用英文——模型的工具调用主要在英文数据上训练,英文指令引导更稳,也方便国际读者;配套教程是中文。

## 快速开始

最简方式(npm 包,包名 `agent-from-zero`,装完命令叫 `mini-agent`):

```bash
echo 'DEEPSEEK_API_KEY=sk-你的key' > .env   # key 在 platform.deepseek.com 获取
npx agent-from-zero
```

从源码跑:

```bash
git clone https://github.com/Michael-crazyman/mini-agent.git && cd mini-agent
npm install
cp .env.example .env   # 填入你的 DeepSeek API Key
npm start              # 跑最新版
npm run eval           # 10 道题的回归考试
```

## 换个模型用

默认 DeepSeek,但任何 **OpenAI 兼容接口**都能跑,三个环境变量搞定:

```bash
MINI_AGENT_API_KEY=sk-...
MINI_AGENT_BASE_URL=https://api.openai.com/v1   # OpenAI / Kimi / Qwen / GLM / OpenRouter / Ollama 均可
MINI_AGENT_MODEL=gpt-4.1-mini
```

各家 base URL 见 [.env.example](.env.example)。两个注意:模型必须支持 function calling;窗口比 DeepSeek 小的话设 `MINI_AGENT_CONTEXT_WINDOW`(单位 token)。换完跑一遍 `npm run eval`——同样 10 道题,正好当模型横评。

## 进度

| Tag | What it adds |
|---|---|
| `day1` | ~50-line raw tool-calling loop: one tool, one loop, two safety nets (errors fed back, a round cap) |
| `day2` | The five core tools (read/write/edit/search/bash): read-before-edit, `old_string` uniqueness, a `dispatch` that never throws, the four-part tool manual |
| `day3` | Main loop as a state machine: error classification, exponential backoff (with jitter), dual retry budgets, a circuit breaker, 8 terminal states each with a plain-English note, graceful Ctrl+C exit |
| `day4` | Permission system (allow/ask/deny): hard-blocked no-fly zones (.git/.ssh/.env), deny always wins (even bypass can't override), fail-closed when non-interactive, bash risk graded by the command, secret files kept out of context |
| `day5` | Context management: token estimation (byte-based, err high), an 80% trigger line, a 6-section structured summary (tools double-disabled), file recovery (last 5, re-read from disk), proactive + reactive compaction, a compaction circuit breaker |
| `day6` | Multi-turn REPL (line-queue input, `/clear`, three-state Ctrl+C), a system-prompt constitution (number anchors / negative prohibitions / no false claims), AGENT.md project memory, streaming output + a dual watchdog (90s stall / 30s warn-only) |
| `day7` | Sub-agents (the `task` tool: isolated context, one level deep with no nesting, the report is material not the verdict, file-state snapshot isolation) + a minimal eval (10 fixed tasks, evidence-based scoring, 8/10 pass bar, `npm run eval`) |
| `day8` | Packaging & release: a `bin` entry + tsc build, one-line `npx` launch (package `agent-from-zero`); built-in .env loading; a plain-English error when the key is missing |
| `day9` | The tutorial itself: 11 Chinese chapters open-sourced into [docs/](docs/README.md) |
| `day10` | Bring your own model: three env vars swap in any OpenAI-compatible endpoint; `npm run eval` doubles as a model bake-off |
| `day11` | Industrial-grade CLI surface: two-layer settings.json (user permission rules, deny always wins), slash commands (/help /model /compact), `-p` one-shot mode, `--version`, a test suite in the repo (`npm test`, 60 cases) |
| `day12` | Session persistence (`--resume`, snapshot-style + atomic writes) + local telemetry (event JSONL + `/stats`, never leaves the machine, off via `MINI_AGENT_NO_TELEMETRY=1`) |
| `day13` | Async execution: run_bash switched to spawn (no UI freeze, instant Ctrl+C, 30s timeout then SIGKILL), oversized output spilled to disk, read-only tools run in parallel; `npm test` 65 cases |
| `day14` | Hook lifecycle system: PreToolUse (intercept a tool) / PostToolUse (append checks) / SessionStart (inject context) / Stop (test-driven AI), exit-code protocol, stderr fed back to the model; `npm test` 76 cases |
| `day15` | MCP integration: a stdio JSON-RPC client (handshake / line buffering / id pairing), external-server tools registered just like built-ins (same dispatch + permission gate, ask by default); `npm test` 84 cases |
| `day16` | Optional LLM permission judge: only for the ask gray-zone the rules left undecided, can only ask→allow, a rigid prompt format, fail-closed parsing, its own circuit breaker, off by default; `npm test` 98 cases |
| `day17` | Long-term memory: a cross-session MEMORY.md (human-readable) + a remember tool, injected as "background" (vs AGENT.md's "commands"), bounded at 30 entries / 8KB and self-healing; `npm test` 114 cases |
| `day18` | Cost accounting: capture usage from the stream (include_usage), smooth over DeepSeek/OpenAI format differences, pure-function cost + cache-hit-rate math, `/cost` to see spend (the hit rate doubles as a cache-bust warning); `npm test` 130 cases |
| `day19` | Tool-call validation: just-enough schema checks (required / type / shape), pinned at dispatch's single entry, batched precise fix-it guidance, auto-covering built-in + MCP tools (bad args caught before they're sent); `npm test` 146 cases |
| `day20` | Plan mode: read-only research, think it through, hand you a plan to approve; one outer filter in the permission layer (only tightens, never loosens, overrides pre-approvals, keeps no-fly reasons) + an `exit_plan_mode` tool that borrows the ask flow to close approval + a `/plan` toggle; `npm test` 167 cases |
| `day21` | Diff preview: before a write, show the real change (green +/red -) for you to approve; a ~dozen-line LCS line-diff, collapsed unchanged lines, side-effect-free replay of tool semantics, never throws (fails to null); printed after the gate, before execution; `npm test` 189 cases |
| `day22` | `/undo` reverts the last write: stash a "before" snapshot ahead of each write (a bounded stack), `/undo` restores the content or deletes a newly created file, reusing the Day 21 diff to draw the undo; `/clear` also clears the stack; `npm test` 204 cases |
| `day23` | Sub-agent model tiering: a `subAgentModel` config runs delegation on a different tier (cheap model for chores / strong model as a reviewer), a pure `subAgentModelFor` defines the fallback, first end-to-end proof via a fake client that "orchestrate→delegate→regress" really switched models; `npm test` 212 cases |
| `day24` | Remote MCP (HTTP/SSE): peel Day 15's transport out of the protocol into a Transport interface, add an HTTP transport (POST → parse JSON/SSE by Content-Type, carry Mcp-Session-Id, AbortSignal timeout); set `url` to go remote; zero changes to the protocol / discovery / registration; `npm test` 218 cases |
| `day25` | `/diff` session change overview: alongside the undo ledger, a "session-start baseline" table (each file as first touched, recorded once), `/diff` compares each against disk, reuses Day 21 to render net changes, skips net-zero, three states created/modified/deleted; `npm test` 227 cases |
| `day26` | `@file` mentions: an `@path` in your question attaches the file's content to the message, saving a read_file round-trip; recognizes `@` at line start / after whitespace, strips trailing punctuation; each mention passes the read_file gate — secret files (.env/*.pem) are refused, refusals voiced, misses silent; `npm test` 244 cases |
| `day27` | `/resume` session picker: `session.ts` gains listSessions (summaries) / loadSession (by id) / sessionTitle (first line as title, strips @file attachments), a REPL list + pick-by-number + wholesale switch (rebuild the constitution, swap the id, clear read-state and the undo stack), sessions dir made lazy for testability; `npm test` 256 cases |
| `day28` | Terminal UI: a new `ui.ts` owns the look — a rounded welcome box, the `❯` prompt, `⏺`/`⎿` activity markers (replacing emoji), a ticking spinner (riding the watchdog); explains why "color codes pollute width math" so you align on plain text first, then color; `npm test` 277 cases |
| `day29` | Arrow-key approval menu: approval moves from "type y/N" to ↑↓ select (`menu.ts` borrows stdin into raw mode, redraws in place, hands it back), numbered + a footer hint; the middle "don't ask again this session" reuses the allow rule (run_bash only escalates ask, never touches hard deny); non-TTY falls back to typing; `npm test` 289 cases |
| `day30` | Multi-question form: give the model an `ask_user` tool that pops a form when it needs your decision (`form.ts` pure state machine: flat cursor + reduce + submit validation + jump-to-gap, `promptForm` a thin keyboard layer), collected into question→answer fed back; the input area becomes Claude-Code-style "rule + ❯"; `npm test` 309 cases |
| `day31` | Switch models at runtime: `/model` upgrades from read-only to switchable — `/model <name>` sets it, bare `/model` pulls the endpoint's `/models` list into the Day 29 menu; the switch only changes `CONFIG.model` and takes effect immediately via the loop re-reading it each round; `npm test` 314 cases |
| `day32` | Make a model switch visible: the streaming loop also reads `reasoning_content`, streaming a reasoning model's (R1) thinking dimmed (render-only, never into history, never sent back); the spinner shows the current model as proof the switch took; `npm test` 324 cases |
| `day33` | Skill system (Markdown as a plugin): a `SKILL.md` (frontmatter + body) = one plugin, executed by the model; progressive disclosure (the listing in context / the body loaded on demand), the `skill` tool manual is the listing, `disableModelInvocation` splits model-callable vs user-only, `/skills` `/skill <name>`; `npm test` 360 cases |
| `day34` | Deeper memory: four types (user/feedback/project/reference, feedback the most valuable), auto-extraction each turn (a cheap model reads the conversation and stores "what the user corrected", off by default, never throws), grouped injection by type, backward-compatible with the old format; `npm test` 375 cases |
| `day35` | Deeper hooks: 4→10 events (adding UserPromptSubmit/SessionEnd/Pre·PostCompact/Subagent*), config becomes an open record, exit-2 meaning interpreted per-event by the caller, an extra-short SessionEnd timeout; **`PreToolUse` can rewrite a tool's arguments** (the "side road" the three-state permission can't do, strictly after the safety check); `npm test` 381 cases |
| `day36` | TodoWrite: a `todo_write` tool that lets the agent keep its own checklist (whole-list replace, at most one in_progress, ✓/▶/○ render, `/todos` to view) — planning, not new powers; plus a nag that injects a reminder when an unfinished plan goes stale for N rounds, so long tasks don't drift off the original goal; `npm test` 474 cases |
| `day37` | Background tasks: a `run_bash_background` tool spawns a slow command (install/build/test/dev server) and returns a `bg_*` id immediately instead of blocking on run_bash's 30s watchdog — the agent keeps reasoning while it runs; when it finishes the loop injects a `<task_notification>` as the next turn (once per task), a `bash_output` tool polls a job's new output (essential for servers that never "finish"), `/bg` lists them and they're SIGKILLed on exit; same permission gate as run_bash, so the danger rules are identical; `npm test` 502 cases |

## 📖 配套教程(免费开源)

**[完整教程在 docs/ 目录](docs/README.md)**——主线 + 进阶共三十多章,每章对应一个 tag:为什么这么写、Claude Code 原版怎么做、你会踩的坑。每章五段结构:做完长什么样 → 跟着写 → 为什么 → 坑 → 小结。

想看更深的「为什么」:公众号的 **Harness Engineering 拆书系列**(30+ 篇)逐章拆了《Harness Engineering:从 Claude Code 看 AI 编码工程》——本仓库每个设计决策背后的原理、数据和事故案例都在那里。公众号 @老李是谁。

如果这个项目帮你搞懂了 agent,点个 ⭐ 就是最大的支持。

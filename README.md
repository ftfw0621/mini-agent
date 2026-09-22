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

## Auto mode

### Rule-based policy preview

新规则策略已可选启用，审核结果分为 `allow / deny / ask`，不再用授权和风险两个分数作为放行门槛：

```sh
MINI_AGENT_AUTO_POLICY=rules npm start -- --auto
```

也可在 settings 中设置 `autoMode.policy: "rules"`。配置 `JEV_API_KEY` 或
`TYPESAFE_API_KEY` 后先用 Jev 初筛；有疑点再用同一 vendor 的 `judge.model` 复核，
未指定则使用当前模型。没有 key 或 Jev 故障时直接走模型。普通任务内检查、测试、修改及明确要求的常规
commit/push 按实际效果审核；删除、丢弃工作、改写共享历史、基础设施写入和权限修改
仍要求人工确认。违反明确限制的操作直接拒绝，让 agent 改用合规方案；连续 3 次或
累计 20 次自动拒绝会停止，等待用户给出方向。子 agent 和中断恢复共用预算。

Jev 初筛要求每条阻断规则和不确定性概率均 `≤ 0.05`，否则交给模型复核一次，
不会直接因初筛分数弹人工审批。历史动作有缺失时也转模型。这个预览阈值尚未经过
真实数据校准，不代表整体误放率；新策略仍需显式选择，默认保留旧 `scores` 策略。
Jev 额度耗尽或出错会提示并在本会话回退到模型。使用 `/auto debug on` 可记录两阶段
实际上下文、分流原因与最终决定，详见 [策略设计及评测](docs/auto-mode-redesign.md)。

### Existing score policy (`scores`, default)

启动时加 `--auto`，或在会话中输入 `/auto` 开关自动审核。默认关闭；开启后，审核通过的工具操作自动执行，有风险、判断不确定或审核失败时仍会询问。Ink、readline 和 `-p` 模式共用同一条权限路径，后台 shell 和子 agent 的操作也会经过检查。

审核后端自动选择：

- 配置了 `JEV_API_KEY` 或 `TYPESAFE_API_KEY`：优先使用 Jev。
- 没有 Jev key：复用主 agent 的 API endpoint 和 key，默认使用当前模型；启动时显示一条 Jev 配置提示，不影响使用。
- 在 `.mini-agent/settings.json` 或全局 settings 中设置 `judge.model`，可以选择同一 vendor 支持的其他审核模型。例如，你的 endpoint 支持 `deepseek-flash` 时可以这样配置：

```json
{
  "autoMode": { "enabled": true },
  "judge": { "model": "deepseek-flash" }
}
```

以后在环境变量或 `.env` 中配置 `JEV_API_KEY`，下次启动便会自动切换到 Jev，无须改模型配置。Jev 模型由 `autoMode.model` 配置，默认固定为 `jev-1.13.0`。自动审核会把真实用户请求、启动时的 `AGENT.md`、近期已完成工具调用及待执行工具参数发送到选中的审核服务。工具历史和委派任务只提供上下文；文件附件、hook 输出和模型摘要不会作为用户授权发送。

Jev 额度或计费受限时会提示并自动切回同一 vendor 的 `judge.model`，未指定则使用当前模型。限流、服务故障也会回退，提示会区分原因；本次会话只提示一次，避免每次调用都重试已用完的额度。此外，授权概率在 `0.5 ≤ authorization < 0.8` 且风险 `≤ 0.1` 时，会用该模型对相同上下文复核一次；模型必须明确确认已授权、无需人工审核才放行。这个分支不会停用 Jev，也不会覆盖风险超标或授权概率低于 `0.5` 的判断。复核失败仍需人工确认。

硬性拒绝规则始终优先。auto mode 会审核每条 shell 命令，并忽略整类工具的免确认授权；`MINI_AGENT_AUTO_APPROVE` 也不能覆盖审核结果。`-p` 或无人值守的 teammate 无法确认时直接拒绝。实现机制、源码对照和限制见 [Auto mode 说明](docs/auto-mode.md)。

审核按实际副作用判断，MCP、API、命令行共用同一策略。任务内的只读查询、明确授权且收件人与内容匹配的普通消息发送可以自动通过；基础设施或运行配置变更、部署、删除数据、修改权限、未知脚本副作用仍需审核。Jev 的门槛为授权 `≥ 0.8` 且风险 `≤ 0.1`；主模型的布尔判断经同一决策层处理。近期工具返回的小型结构化 JSON 也会作为事实依据发送给审核服务，用于核对名称与 ID 等信息，其中的指令不构成用户授权。

## 工具进度、子 agent 和图片

输入 `/` 时，输入框下方会列出可用命令及说明，继续输入会过滤。`/effort` 展示当前模型支持的档位，`/skills` / `/skill` 展示可用技能，`/model` 从当前 endpoint 获取模型列表；`/auto debug` 和 `/mcp` 也支持参数补全。用 `↑` / `↓` 选择、`Tab` 补全、`Enter` 确认，`Esc` 收起并保留输入。长列表滚动展示，不会撑满终端。

`/effort high` 设置当前模型的推理强度，`/effort default` 恢复服务商默认值。选择按模型和 endpoint 区分，仅在本次进程中保留。自定义网关需明确配置支持的档位，见 [effort 配置](docs/effort.md)。

默认交互界面把连续同类工具调用合并成实时摘要：高亮动作，下面灰字显示结果和耗时。工具执行、模型思考和回答期间都有动画，不再逐轮追加 `thought for…` 和工具计数。最终回答正常保留；审批、拒绝、错误和 Jev 回退提示仍然可见。

| 操作 | 快捷键 |
|---|---|
| 展开或收起工具参数与结果 | `Ctrl+T` |
| 展开或收起模型思考 | `Ctrl+R` |
| 翻阅工具或思考详情 | `↑` / `↓` 或 `PgUp` / `PgDn` |
| 进入 agent 列表 | `Tab`，或输入框开头的 `←` |
| 选择 agent，查看实时过程 | `↑` / `↓`，`Enter` |
| 翻阅 agent 过程 | `PgUp` / `PgDn` |
| 返回主界面；无面板时中断任务 | `Esc` |
| 粘贴剪贴板图片或文字 | `Ctrl+V` |
| 工作中插入补充消息 | 输入后按 `Enter`，在下一个工具边界送入 |
| 中断当前步骤并优先处理补充消息 | `Ctrl+Enter`；已有排队消息时也可按 `Esc` |

工作中的补充消息先以灰字显示在待处理区，送入模型时转为正常用户消息。支持多条消息和图片，保持发送顺序；当前已执行的操作不会因此撤销，尚未启动的旧工具调用会跳过并按新消息重新规划。`Esc` 优先关闭详情面板。部分终端不能区分 `Ctrl+Enter` 和 `Enter`，此时可先按 `Enter` 排队，再按 `Esc`。

审批或问题选项出现时，输入框仍可输入文字；有文字时按 `Enter` 会取消当前选择并发送 follow-up，空输入时按 `Enter` 才确认选项。只有一个问题时，选中答案后按一次 `Enter` 即提交，不再显示额外的 Submit answers；多个问题仍统一提交。

粘贴至少 4 行或 1000 字符的文本时，会折成 `[Pasted text #1 +13 lines]` 之类的占位符；长单行文本显示字符数。左右方向键跨过整个占位符，Backspace 整块删除。可以混合输入文字、多个文本块和图片。发送及权限审核收到完整原文，输入历史仍可恢复文本块；补充消息和已发送消息保留简洁展示。

agent 列表竖排显示 `main`、subagent 和 teammate，右侧显示当前活动、`idle` / `done` / `failed`、耗时及输出 token。带 `~` 的 token 是流式估算；API 返回用量后使用实报数据。切换视图不会停止其他 agent，也不会把它们的详细过程塞进主对话。

粘贴图片后，输入框显示 `[Image #1]`；可以继续输入说明或粘贴多张图片。光标紧跟占位符时按 Backspace 可以删除附件。每条消息最多 4 张、每张最多 5 MB。发送时使用真实图像数据，当前模型须同时支持图片和工具调用；模型拒绝图片时会提示检查限制或用 `/model` 切换。图片随会话保存，恢复会话和后续追问可以继续引用。

剪贴板通过 `ClipboardSource` 接口接入：macOS 使用 AppKit，Windows 使用 PowerShell/Windows Forms，Linux Wayland 使用 `wl-paste`，X11 使用 `xclip`（Linux 需安装相应工具）。界面和图像消息构造不依赖操作系统。以上交互适用于默认 Ink 界面；`MINI_AGENT_NO_INK=1` 保留文字版 readline 界面。实现对照和验证范围见 [交互界面说明](docs/interactive-ui.md)。

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
| `day38` | Agent teams: past the one-shot sub-agent — a `spawn_teammate` tool starts PERSISTENT teammates that run concurrently (fire-and-forget async loops interleaving on the one event loop) and coordinate through `send_message`; mailboxes are real `.jsonl` files on disk (`.mini-agent/team/`, consumptive read = observable, no lock needed on a single event loop), the loop injects each agent's inbox as a turn and the lead WAITS on the team instead of ending early, teammates are bounded (round cap) with a focused toolset and a non-interactive permission policy (writes auto-proceed, risky bash declined, deny still wins), `/team` lists them; `npm test` 523 cases |
| `day39` | Team protocols: explicit message contracts, not vibes — every protocol is the same request→response correlated by a `request_id`, tracked as `ProtocolState` (pending→approved/rejected) with a `match_response` that rejects a mismatched reply (a shutdown_response can't approve a plan). Two contracts: **graceful shutdown** (lead `request_shutdown` → teammate finishes, confirms, exits — no orphans/half-writes) and **plan approval** (teammate `submit_plan` → lead `review_plan` before risky work runs). Teammates go from bounded auto-exit to an IDLE LOOP (wait for work, leave on the shutdown handshake; bounded backstop so an abandoned one self-exits), and the lead disbands the team gracefully when it finishes; the inbox-consume step routes protocol messages then hands the rest to the model; `npm test` 545 cases |
| `day40` | Autonomous agents: a shared TASK BOARD teammates pull from instead of being hand-fed work. `.mini-agent/tasks/<id>.json` files (on disk = observable), `Task {status, owner, blockedBy}` with `blockedBy` resolved by id OR subject; `create_task`/`list_tasks`/`claim_task`/`complete_task` tools, and `claimTask` is a synchronous read-check-write so two scanners can't both win the same task — no lock, same single-event-loop argument as the mailbox. The teammate IDLE loop now polls inbox-first (shutdown priority) then auto-claims the next ready task (`claimNextAvailable`) and resumes WORK; the lead lays out a dependency graph and teammates respect it (schema → routes → tests), `/tasks` shows the board; `npm test` 574 cases |

## 📖 配套教程(免费开源)

**[完整教程在 docs/ 目录](docs/README.md)**——主线 + 进阶共三十多章,每章对应一个 tag:为什么这么写、Claude Code 原版怎么做、你会踩的坑。每章五段结构:做完长什么样 → 跟着写 → 为什么 → 坑 → 小结。

想看更深的「为什么」:公众号的 **Harness Engineering 拆书系列**(30+ 篇)逐章拆了《Harness Engineering:从 Claude Code 看 AI 编码工程》——本仓库每个设计决策背后的原理、数据和事故案例都在那里。公众号 @老李是谁。

如果这个项目帮你搞懂了 agent,点个 ⭐ 就是最大的支持。

# mini-agent

一个照着 Claude Code 做出来的命令行 coding agent，TypeScript 实现，默认接 DeepSeek（任何支持 function calling 的 OpenAI 兼容模型都能换上）。

## 这是什么

mini-agent 是我模仿 Claude Code 自己搓的。从终端 UI 的样子，到背后的各种机制，基本都是照着 Claude Code 的做法来实现的：

- **交互界面**：Ink 终端 UI、方向键审批菜单、多问题表单、`@file` 引用、diff 预览、推理过程流式展示
- **Skill**：`SKILL.md` 按需加载，项目级放 `.mini-agent/skills/`，全局放 `~/.config/mini-agent/skills/`。和 Claude Code 一样，skill 列表通过带 `<system-reminder>` 的 user message 告诉模型，新增或修改 skill 不用重启；可以用 `/skill <名字> [参数]` 或 `/<名字> [参数]` 手动运行
- **MCP**：stdio 和 HTTP 两种传输都支持，远程服务器走 OAuth
- **权限**：allow / ask / deny 三档，deny 永远优先；另外有 plan 模式、auto 模式（交给模型审核）、`--dangerously-skip-permissions`
- **其他**：上下文压缩、长期记忆、hooks、子 agent、后台任务、todo、撤销、会话续接、成本统计、非交互的 `-p` 模式

这个版本是我自己一直在 dogfooding、边用边改出来的，到现在已经挺顺手了。我把自己工作用的 **Slack** 和 **Linear** MCP 都接了进来，底层模型用的是 DeepSeek。平时主要让它干这些活：

- 查 bug、看日志、定位问题
- 回 Slack 消息
- 跑数据 backfill 之类的脏活

## 用下来的感受

老实说，跟 Claude Code 比体验还是差一截。但跟我直接用 DeepSeek 自带的 harness 相比，mini-agent 好用太多了。

说句题外话：我对 A 社这家公司的人品不太认可，但产品确实做得好。至少从 Claude Code 的体验来看，我觉得它远远好过 Codex 和 DeepSeek 的 harness。所以与其从头去想一个 agent 该长什么样，不如直接照着最好的那个来做。

## 安装与配置

### 安装

需要 Node >= 20.6。不用 clone 仓库，直接用 npx 运行 npm 包（包名是 `agent-from-zero`）：

```bash
npx agent-from-zero
```

### 配置 API key

推荐把 API key 写进 **shell 的启动配置文件**（zsh 是 `~/.zshrc`，bash 是 `~/.bashrc`），这样在任何目录启动 mini-agent 都能用。默认用 DeepSeek，只需要一个 key（在 [platform.deepseek.com](https://platform.deepseek.com) 获取），变量名是 `DEEPSEEK_API_KEY`：

```bash
# ~/.zshrc 或 ~/.bashrc
export DEEPSEEK_API_KEY=sk-你的key
```

改完运行 `source ~/.zshrc`（或 `source ~/.bashrc`），或者新开一个终端。

如果某个项目想单独用一个 key，也可以在那个目录下放一个 `.env` 文件，写 `DEEPSEEK_API_KEY=sk-...`，不带 `export`。mini-agent 启动时会读当前目录的 `.env`，但**环境变量优先**：shell 配置文件里已经导出的变量，`.env` 里的同名值会被忽略。

### 配置审核模型 judge.model

开启 auto 模式（会话里输入 `/auto`，或启动时加 `--auto`）后，每个需要审批的工具调用会先交给一个审核模型判断：安全的直接执行，有风险或拿不准的仍然问你。审核模型只有两种选择：

1. **主 agent 用的模型**（默认）：和主 agent 共用同一个 API key 和 base URL。没配 `judge.model` 就直接用主 agent 当前的模型。
2. **Jev**：配好 Jev 的 key 后自动优先用它（见下一节）。

`judge.model` 写在 `~/.config/mini-agent/settings.json`（全局）或 `.mini-agent/settings.json`（项目级）：

```json
{
  "judge": { "model": "deepseek-flash" }
}
```

注意：`judge.model` 走的是主 agent 的 API 端点，所以只能填主 agent 那个服务商下的模型，不能填别家的模型，也不能在这里填 Jev。不确定的话就不要配，默认用主 agent 的模型最稳妥。

### 配置 Jev（可选）

**Jev 不是必须的**，不配也能正常使用 auto 模式，审核会用上面说的主 agent 模型。

Jev 是 TypeSafe 提供的审核模型。想用的话，和 DeepSeek 的 key 放在同一个地方，加上 Jev 的 key（两个变量名都可以，二选一）：

```bash
# ~/.zshrc 或 ~/.bashrc
export JEV_API_KEY=你的key
# 或者
export TYPESAFE_API_KEY=你的key
```

配了 key 之后，下次启动会自动优先用 Jev 审核；Jev 额度用完或出错时，会自动退回主 agent 的模型。Jev 的模型版本默认是 `jev-1.13.0`，要换的话在 settings.json 里设置 `autoMode.model`：

```json
{
  "autoMode": { "model": "jev-1.13.0" }
}
```

### 换别的模型

和 API key 放在同一个地方，设置这三个变量就行，各家的 base URL 写在 [.env.example](.env.example) 里：

```bash
export MINI_AGENT_API_KEY=sk-...
export MINI_AGENT_BASE_URL=https://api.openai.com/v1
export MINI_AGENT_MODEL=gpt-4.1-mini
```

模型必须支持 function calling。如果它的上下文窗口比 DeepSeek 小（默认按约 1M 算），在 settings.json 里按模型配置窗口大小，`/model` 切换模型时会跟着变：

```json
{
  "contextWindows": { "gpt-4.1-mini": 1000000, "deepseek-v4-pro": 1000000 }
}
```

也可以用环境变量 `MINI_AGENT_CONTEXT_WINDOW` 统一覆盖所有模型。

### 上下文和自动压缩

上下文大小用的是 API 每次返回的真实 `prompt_tokens`，再加上之后新增消息的估算值，所以基本是准的。快满时自动压缩：触发点是窗口减去给回复预留的 20k 和 13k 安全余量（约 1M 的窗口大概在 97% 左右）。状态栏的 `ctx N%` 表示离自动压缩还有多远，到 100% 时下一次调用模型前就会先压缩。也可以随时手动 `/compact`。不管是手动还是自动，压缩时都会像 Claude Code 一样显示 `Compacting conversation…` 和进度条。

### 配置 MCP

在 `~/.config/mini-agent/settings.json`（全局）或 `.mini-agent/settings.json`（项目级）的 `mcpServers` 里添加服务器，写法和 Claude Code 一样。保存后会话里自动生效，不用重启：新加的服务器会连上，删掉的会断开，改过的会重连。也可以手动运行 `/mcp reload`。服务器自己的工具有增减时（MCP 的 `tools/list_changed` 通知），工具列表也会自动更新。启动时 MCP 在后台并行连接，不会卡住输入框，哪个连上了它的工具就马上可用；有连接失败的，状态栏右下角会用红色标出是哪个（需要登录的是黄色）。

输入 `/mcp` 选一个服务器，会看到和 Claude Code 一样的详情（状态、登录、协议版本、URL、配置文件位置、能力、工具数）和操作：View tools、Re-authenticate、Clear authentication、Reconnect、Disable。也可以直接敲 `/mcp tools|auth|clear-auth|reconnect|disable|enable <名字>`。

### 多开实例互相通信

在几个终端里各开一个 mini-agent（比如一个在后端仓库、一个在前端仓库），它们会自动互相发现，不用配置。

- `/peers` 列出本机其他实例：名字、空闲/忙、目录和分支、在哪个终端（比如 `iTerm2 · ttys003`，tmux 里会显示 pane）、正在做什么。选一个之后可以：
  - **Talk to**：输入框变成 `→ web ❯`，你打的字直接发给那个实例，它处理完会把回答发回你这个窗口。按 Esc 回到当前 agent。
  - **Identify**：让那个实例响铃、刷一条横幅、让标签页标题闪几秒，用来确认它是哪个窗口。
- 实例名跟着它在做的事走：发出第一条消息后会生成会话标题（比如 “Fix login bug”），实例名随之变成 `fix-login-bug`，标签页标题就是 `✳ Fix login bug`，和 `/peers` 里看到的一致。还没有标题时用目录名。`/rename <名字>` 可以手动指定名字，指定后标签页显示 `✳ 名字 · 标题`，之后不会再跟着标题变。
- agent 之间也能自己沟通：模型有 `list_peers` 工具，`send_message` 可以直接发给其他实例。对方空闲时会自动开一轮处理；忙的话，在它当前这一步工具调用结束后插进对话。你在 Talk 模式里打的字则会等对方这一轮结束再处理，因为回答要发回给你。另一个 agent 发来的消息不算用户的授权。为了防止两个 agent 互相回复停不下来，连续自动处理 5 轮之后会暂停，等你输入任何内容再继续。

所有数据都存在 `~/.config/mini-agent/sessions/` 下，只在本机，不经过网络。

### 非交互模式

```bash
npx agent-from-zero -p "总结当前改动"
cat error.log | npx agent-from-zero -p "分析这份日志"
npx agent-from-zero -p "总结当前改动" --output-format json
```

## 常用命令

在会话里输入 `/help` 可以看到全部命令，比较常用的有：`/model` `/effort` `/plan` `/auto` `/skills` `/mcp` `/peers` `/memory` `/compact` `/diff` `/undo` `/resume` `/status` `/cost`。

## 开发

```bash
git clone https://github.com/ftfw0621/mini-agent.git && cd mini-agent
npm install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
npm start           # 从源码运行
npm run typecheck   # 类型检查
npm test            # 单元测试
npm run eval        # 回归评测
```

各个功能的实现思路见 [docs/](docs/)。

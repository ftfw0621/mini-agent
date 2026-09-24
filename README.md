# mini-agent

一个照着 Claude Code 做出来的命令行 coding agent，TypeScript 实现，默认接 DeepSeek（任何支持 function calling 的 OpenAI 兼容模型都能换上）。

## 这是什么

mini-agent 是我模仿 Claude Code 自己搓的。从终端 UI 的样子，到背后的各种机制，基本都是照着 Claude Code 的做法来实现的：

- **交互界面**：Ink 终端 UI、方向键审批菜单、多问题表单、`@file` 引用、diff 预览、推理过程流式展示
- **Skill**：`SKILL.md` 按需加载，项目级放 `.mini-agent/skills/`，全局放 `~/.config/mini-agent/skills/`
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

## 快速开始

```bash
git clone https://github.com/ftfw0621/mini-agent.git && cd mini-agent
npm install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
npm start
```

也可以直接用 npm 包（包名 `agent-from-zero`，装完的命令叫 `mini-agent`）：

```bash
echo 'DEEPSEEK_API_KEY=sk-你的key' > .env
npx agent-from-zero
```

需要 Node >= 20.6。

### 换别的模型

在 `.env` 里设置这三个变量就行，各家的 base URL 写在 [.env.example](.env.example) 里：

```bash
MINI_AGENT_API_KEY=sk-...
MINI_AGENT_BASE_URL=https://api.openai.com/v1
MINI_AGENT_MODEL=gpt-4.1-mini
```

模型必须支持 function calling。如果它的上下文窗口比 DeepSeek 小，记得设置 `MINI_AGENT_CONTEXT_WINDOW`。

### 配置 MCP

在 `~/.config/mini-agent/settings.json`（全局）或 `.mini-agent/settings.json`（项目级）的 `mcpServers` 里添加服务器，写法和 Claude Code 一样。会话里输入 `/mcp` 可以查看连接状态。

### 非交互模式

```bash
mini-agent -p "总结当前改动"
cat error.log | mini-agent -p "分析这份日志"
mini-agent -p "总结当前改动" --output-format json
```

## 常用命令

在会话里输入 `/help` 可以看到全部命令，比较常用的有：`/model` `/effort` `/plan` `/auto` `/skills` `/mcp` `/memory` `/compact` `/diff` `/undo` `/resume` `/status` `/cost`。

## 开发

```bash
npm run typecheck   # 类型检查
npm test            # 单元测试
npm run eval        # 回归评测
```

各个功能的实现思路见 [docs/](docs/)。

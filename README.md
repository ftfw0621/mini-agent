# mini-agent

**跟着 AI,从零搓一个自己的 Claude Code**——一个能读文件、改代码、跑命令的命令行 Agent。TypeScript 实现,默认 DeepSeek 驱动(任何 OpenAI 兼容模型可配)。

人定方向、做决策、验收,AI 写大部分代码——这既是本仓库的诞生方式,也是这门课教你的工作方式。

课程拆成 10 个 Day,一个 Day 一个 commit,按一晚一章的节奏跟做。**commit 历史就是课程目录**:`git log --oneline` 看大纲,`git checkout dayN` 拿到第 N 章对应的完整代码。

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

| Tag | 内容 |
|---|---|
| `day1` | ~50 行 raw tool-calling loop:一个工具、一个循环、两条保险 |
| `day2` | 工具五件套(read/write/edit/search/bash):编辑前必须先读、old_string 唯一性、永不抛异常的 dispatch、四要素工具说明书 |
| `day3` | 主循环状态机:错误分类、指数退避(带抖动)、双重重试预算、熔断器,8 种终态各配人话提示,Ctrl+C 体面退出 |
| `day4` | 权限系统(allow/ask/deny):禁飞区硬拦(.git/.ssh/.env)、deny 永远赢(bypass 也压不过)、非交互 fail closed、bash 按输入定危险等级、秘密文件不进上下文 |
| `day5` | 上下文管理:token 估算(字节法,宁多勿少)、80% 触发线、6 段结构化摘要(双保险禁工具)、文件恢复(最近 5 个,从磁盘重读)、主动+被动压缩、压缩熔断 |
| `day6` | 多轮 REPL(行队列输入、/clear、Ctrl+C 三态语义)、system prompt 宪法(数字锚/反面禁令/防虚报)、AGENT.md 项目记忆、流式输出 + 双重看门狗(90s 断流/30s 只警告) |
| `day7` | 子 agent(task 工具:独立上下文、一层分身不套娃、报告是材料不是结论、文件状态快照隔离)+ 最小 eval(10 道固定题、物证判分、8/10 及格线,`npm run eval`) |
| `day8` | 封装发布:`bin` 入口 + tsc 构建,npx 一行启动(包名 `agent-from-zero`);内置 .env 加载;缺 key 人话报错 |
| `day9` | 教程本身:11 章中文教程开源进 [docs/](docs/README.md) |

## 📖 配套教程(免费开源)

**[完整教程在 docs/ 目录](docs/README.md)**——11 章,每章对应一个 tag:为什么这么写、Claude Code 原版怎么做、你会踩的坑。每章五段结构:做完长什么样 → 跟着写 → 为什么 → 坑 → 小结。

想看更深的「为什么」:公众号的 **Harness Engineering 拆书系列**(30+ 篇)逐章拆了《Harness Engineering:从 Claude Code 看 AI 编码工程》——本仓库每个设计决策背后的原理、数据和事故案例都在那里。公众号 @老李是谁。

如果这个项目帮你搞懂了 agent,点个 ⭐ 就是最大的支持。

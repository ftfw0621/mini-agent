# mini-agent

**跟着 AI,从零搓一个自己的 Claude Code**——一个能读文件、改代码、跑命令的命令行 Agent。TypeScript 实现,默认 DeepSeek 驱动(任何 OpenAI 兼容模型可配)。

人定方向、做决策、验收,AI 写大部分代码——这既是本仓库的诞生方式,也是这门课教你的工作方式。

课程共 22 天——主线 10 天搓出一个能用的 agent,进阶 12 天打磨成工业级 CLI(MCP / 权限裁判 / 长期记忆 / 成本核算 / 调用校验 / 计划模式 / diff 预览 / 撤销);一天一个 commit、一晚一章的节奏跟做。**commit 历史就是课程目录**:`git log --oneline` 看大纲,`git checkout dayN` 拿到第 N 天对应的完整代码。

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
| `day10` | Bring your own model:三个环境变量换任意 OpenAI 兼容端点,`npm run eval` 兼职模型横评 |
| `day11` | 工业级 CLI 表面:settings.json 双层配置(用户权限规则,deny 永远赢)、slash 命令(/help /model /compact)、`-p` 单发模式、`--version`、测试套件进仓库(`npm test`,60 例) |
| `day12` | 会话持久化(`--resume`,快照式 + 原子写)+ 本地遥测(事件 JSONL + `/stats`,绝不出本机,`MINI_AGENT_NO_TELEMETRY=1` 关闭) |
| `day13` | 异步执行:run_bash 换 spawn(不冻 UI、Ctrl+C 秒杀、30s 超时 SIGKILL)、超长输出落盘、只读工具并行;`npm test` 65 例 |
| `day14` | Hook 生命周期系统:PreToolUse(拦截工具)/PostToolUse(追加校验)/SessionStart(注入上下文)/Stop(测试驱动 AI),退出码协议、stderr 喂回模型;`npm test` 76 例 |
| `day15` | MCP 接入:stdio JSON-RPC 客户端(握手/行缓冲/id 配对),外部 server 工具注册成内置同款(同一 dispatch + 权限闸门,默认 ask);`npm test` 84 例 |
| `day16` | 可选 LLM 权限裁判:只看规则判 ask 的灰色地带、只能 ask→allow、prompt 铁死格式、解析 fail closed、自带熔断、默认关闭;`npm test` 98 例 |
| `day17` | 长期记忆:跨会话的 MEMORY.md(人类可读)+ remember 工具,作为「背景」注入(区别于 AGENT.md 的「命令」),有界 30 条/8KB 且自修复;`npm test` 114 例 |
| `day18` | 成本核算:从流里捕获 usage(include_usage)、抹平 DeepSeek/OpenAI 格式差异、纯函数算成本与缓存命中率、`/cost` 看花销(命中率即缓存击穿预警);`npm test` 130 例 |
| `day19` | 工具调用校验:够用就好的 schema 校验(必填/类型/形状)、钉在 dispatch 唯一入口、批量返回精确修复指引、自动覆盖内置+MCP 工具(送出前拦下坏参数);`npm test` 146 例 |
| `day20` | 计划模式:只读研究、想清楚再交计划由你批准;权限层一个外层过滤器(只收紧不放松、盖过预批准、保留禁飞区理由)+ `exit_plan_mode` 工具借用 ask 流程闭合审批 + `/plan` 开关;`npm test` 167 例 |
| `day21` | diff 预览:写文件前把真实改动(绿 +/红 -)摊给你看再批准;十几行 LCS 行级 diff、折叠未变动行、复现工具语义无副作用推演、永不抛异常 fail 到 null;在闸门后执行前打印;`npm test` 189 例 |
| `day22` | `/undo` 撤销上一次写入:写入前埋一行存「之前」快照(有界栈),`/undo` 还原内容或删掉新建文件、复用 Day 21 diff 画出撤销结果;`/clear` 同时清栈;`npm test` 204 例 |

## 📖 配套教程(免费开源)

**[完整教程在 docs/ 目录](docs/README.md)**——主线 + 进阶共十几章,每章对应一个 tag:为什么这么写、Claude Code 原版怎么做、你会踩的坑。每章五段结构:做完长什么样 → 跟着写 → 为什么 → 坑 → 小结。

想看更深的「为什么」:公众号的 **Harness Engineering 拆书系列**(30+ 篇)逐章拆了《Harness Engineering:从 Claude Code 看 AI 编码工程》——本仓库每个设计决策背后的原理、数据和事故案例都在那里。公众号 @老李是谁。

如果这个项目帮你搞懂了 agent,点个 ⭐ 就是最大的支持。

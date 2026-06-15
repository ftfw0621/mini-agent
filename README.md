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
| `day23` | 子 agent 模型分级:`subAgentModel` 配置让委托跑在不同档位(便宜模型干杂活 / 强模型当顾问审查),纯函数 `subAgentModelFor` 定回落规则,首次用假 client 端到端验证「编排→委托→回归」真换了模型;`npm test` 212 例 |
| `day24` | 远程 MCP(HTTP/SSE):把 Day 15 的传输从协议里剥成 Transport 接口,新增 HTTP 传输(POST→按 Content-Type 分 JSON/SSE 解析、回带 Mcp-Session-Id、AbortSignal 超时),配置 `url` 即走远程;协议层/发现/注册零改动;`npm test` 218 例 |
| `day25` | `/diff` 会话改动总览:撤销账本旁加一张「会话起点基线」表(每个文件首次被碰的样子,只记一次),`/diff` 与磁盘现状逐个比、复用 Day 21 渲染净改动、净零跳过,三态 created/modified/deleted;`npm test` 227 例 |
| `day26` | `@file` 引用:提问里 `@路径` 即把文件内容附进消息省一次 read_file 往返;认行首/空白后的 `@`、剥句尾标点;每个提及过 read_file 权限闸门——密钥文件(.env/*.pem)拒绝不读、被拒出声、没命中静默;`npm test` 244 例 |
| `day27` | `/resume` 会话选择器:`session.ts` 加 listSessions(摘要)/loadSession(按 id)/sessionTitle(首句当标题、剥 @file 附件),REPL 列表+选号+整体切换(重建宪法、换 id、清读态与撤销栈),会话目录改惰性求值以可测;`npm test` 256 例 |
| `day28` | 终端 UI:新增 `ui.ts` 收拢外观——圆角欢迎框、`❯` 提示符、`⏺`/`⎿` 活动标记(替 emoji)、走秒 spinner(搭车看门狗);讲透「颜色码污染宽度计算」要先按纯文本对齐再上色;`npm test` 277 例 |
| `day29` | 方向键审批菜单:审批从「打 y/N」换成 ↑↓ 选(`menu.ts` 借 stdin 进 raw 模式、原地重绘、选完归还),带编号+底部操作提示;中间项「本会话别再问」复用 allow 规则(run_bash 只升 ask 不碰硬 deny);非 TTY 回退打字;`npm test` 289 例 |
| `day30` | 多问题选择表单:给模型一个 `ask_user` 工具,需用户决策时弹表单(`form.ts` 纯状态机:扁平光标+reduce+提交校验+缺口跳转,`promptForm` 薄键盘层),收集成 question→answer 喂回;输入区改成 Claude Code 式「分隔线+❯」;`npm test` 309 例 |
| `day31` | 运行时切换模型:`/model` 从只读升级成可切——`/model <name>` 直接设,裸 `/model` 拉端点 `/models` 列表用 Day 29 菜单选;切换只改 `CONFIG.model`、靠主循环每轮重读立即生效;`npm test` 314 例 |
| `day32` | 让换模型看得见:流式循环多读 `reasoning_content`,把推理模型(R1)的思考灰着流出来(只渲染不进历史,绝不回传);spinner 显示当前模型作为切换生效的证明;`npm test` 324 例 |
| `day33` | Skill 系统(Markdown 即插件):`SKILL.md`(frontmatter+正文)=一个插件、执行者是模型;渐进披露(列表进上下文/正文按需加载)、`skill` 工具说明书即列表、`disableModelInvocation` 分模型可调/仅用户、`/skills` `/skill <name>`;`npm test` 360 例 |
| `day34` | 记忆深化:四类型(user/feedback/project/reference,feedback 最值钱)、每轮自动提取(便宜模型读对话存「用户纠正过的」,默认关、永不抛异常)、按类型分组注入、向后兼容旧格式;`npm test` 375 例 |
| `day35` | Hook 深化:4→10 个时机(加 UserPromptSubmit/SessionEnd/Pre·PostCompact/Subagent*),配置改开放 record、exit 2 语义按事件由调用方解读、SessionEnd 极短超时;**`PreToolUse` 可改写工具参数**(权限三态做不到的「岔道」,严格在安全检查之后);`npm test` 381 例 |

## 📖 配套教程(免费开源)

**[完整教程在 docs/ 目录](docs/README.md)**——主线 + 进阶共十几章,每章对应一个 tag:为什么这么写、Claude Code 原版怎么做、你会踩的坑。每章五段结构:做完长什么样 → 跟着写 → 为什么 → 坑 → 小结。

想看更深的「为什么」:公众号的 **Harness Engineering 拆书系列**(30+ 篇)逐章拆了《Harness Engineering:从 Claude Code 看 AI 编码工程》——本仓库每个设计决策背后的原理、数据和事故案例都在那里。公众号 @老李是谁。

如果这个项目帮你搞懂了 agent,点个 ⭐ 就是最大的支持。

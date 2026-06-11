# Ch0 · 开篇:你将做出什么,以及 10 分钟环境准备

## 你将做出什么

10 天(实际代码量约 1200 行),你会从零写出一个在自己终端里干活的 AI Agent——类似 Claude Code,但每一行都是你写的:

```
mini-agent — deepseek-chat | "exit" to quit · "/clear" to reset · Ctrl+C interrupts

> 读一下 cart.js,它应该输出 40 但不对,修掉 bug 然后验证

🔧 read_file {"path": "cart.js"}
🔧 edit_file {"path": "cart.js", "old_string": "sum += it.price - it.qty", ...

⚠️ approval needed — edit_file (writes to your filesystem)
  Allow? [y/N] y

🔧 run_bash {"command": "node cart.js"}

🤖 输出是 40,符合预期。Bug 是第 4 行把乘法写成了减法。
```

它能做的(以及背后对应的章节):

| 能力 | 章 |
|---|---|
| 多轮对话,自己决定步骤、调工具、改文件、跑命令 | Ch1-2, Ch7 |
| 网络抖动自动退避重试,连续失败熔断,Ctrl+C 体面打断 | Ch4 |
| 危险操作弹确认,`.git`/`.env` 等禁飞区任何模式都拦 | Ch5 |
| 对话太长自动压缩,且不忘记正在改的文件 | Ch6 |
| 流式输出、卡死看门狗、AGENT.md 项目记忆 | Ch7 |
| 派子 agent 去独立上下文干脏活,只收报告 | Ch8 |
| 10 道题的回归考试,一条命令出分 | Ch8 |

更重要的是每一章的「为什么」:这些设计不是我发明的,全部来自对 Claude Code 的源码级拆解——你写的是迷你版,理解的是工业级。

## 这门课怎么学

配套仓库的 **commit 历史就是课程目录**:

```bash
git log --oneline        # 十行,就是十天的大纲
git checkout day3        # 第 3 天收工时的完整代码
```

每章教程对应一个 tag。推荐的学法是「跟做」:读一章,自己敲一遍,卡住了 checkout 当天的 tag 对照。每章固定五个部分——做完长什么样 → 跟着写 → 为什么这么写 → 你会踩的坑 → 小结。「坑」那一节别跳过,里面全是我写这份代码时真实踩过的。

**适合谁**:写过一点代码(任何语言),想搞懂 AI Agent 到底是怎么回事的人。TypeScript 不熟没关系,每一行都有注释,语法跟着读就会。

**不适合谁**:想直接调包(LangChain 三行跑 demo)的人——这门课的全部意义就是不调包;以及完全没写过代码的人。

## 环境准备(10 分钟)

三样东西:

**1. Node.js 20.6+**。终端跑 `node -v` 看版本;没有就用 nvm 装:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# 重开终端
nvm install --lts
node -v   # 应显示 v22 或更高
```

**2. DeepSeek API Key**。打开 platform.deepseek.com → 注册 → 充值 10 块钱 → API Keys 里创建一个,复制保存好(只显示一次)。

为什么是 DeepSeek:接口和 OpenAI 完全兼容(教程代码换个 baseURL 就能跑别家),价格大约是 Claude 的 1/10 到 1/20。**我把整个教程的代码全部开发并测试了一遍,API 总花费不到 5 块钱**——你跟着做一遍只会更少。

**3. 一个编辑器**。VS Code 即可。

验证环境:

```bash
mkdir test && cd test
echo 'DEEPSEEK_API_KEY=sk-你的key' > .env
npx mini-agent     # 装好发布版试一下手感(可选)
```

> 也可以直接克隆成品仓库感受终态:`git clone <repo>` → `npm install` → 填 `.env` → `npm start`。但跟做时建议从空目录开始,Ch1 见。

## 一个约定

代码、注释、commit message 全是英文,教程正文是中文。不是装洋气:模型的工具调用能力主要在英文数据上训练,英文指令(ALWAYS / NEVER / MUST)的遵守率实测更稳;而且这份代码会开源,英文是开源的通用语。你跟 agent 对话用中文完全没问题。

## 课程地图

| 天 | 内容 | 一句话 |
|---|---|---|
| Day 1 | 50 行 raw loop | agent 的本质是一个循环 |
| Day 2 | 工具五件套 | 编辑前必须先读 |
| Day 3 | 工具说明书 | 文字管概率,代码管底线 |
| Day 4 | 状态机与容错 | 任何自动行为都要有保险丝 |
| Day 5 | 权限边界 | deny 永远赢 |
| Day 6 | 上下文管理 | 压缩可忘对话,不忘文件 |
| Day 7 | REPL 与宪法 | 慢 ≠ 死 |
| Day 8 | 子 agent 与 eval | 没有 eval 永远是 demo |
| Day 9 | 刻意没做的事 | 砍功能也是工程 |

(Day 编号是构建进度,章节编号 Ch1-Ch9 与之对应,Ch3 是 Day 2 的设计篇。)

准备好了就翻到 Ch1——50 行代码,让 AI 第一次替你干活。

---

*环境就绪检查:`node -v` ≥ 20.6,`.env` 里有 key,能上网。就这些。*

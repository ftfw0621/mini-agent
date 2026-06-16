# Ch1 · 50 行代码,让 AI 第一次替你干活

> 本章完整代码:`git checkout day1`,或在 GitHub 仓库页左上角切到 tag `day1`。

## 这一章做完,你会得到什么

一个能在你电脑上自己干活的 AI。长这样:

```
$ npm start

What should the AI do?
> 看看当前目录有什么,挑一个文件总结一下内容

🔧 running: ls -la
🔧 running: cat README.md

🤖 这个目录是一个叫 mini-agent 的 Node.js 项目,从 package.json 看,
   它依赖 openai 这个包,入口脚本是 src/raw-loop.ts……
```


注意这里发生了什么:你没有告诉它「先执行 ls,再执行 cat」。你只说了一个目标,它自己决定先看目录、再挑文件、再读内容、最后总结。**决定下一步干什么的是模型,不是你。**

这就是 agent 和聊天机器人的分水岭:聊天机器人是你问一句它答一句;agent 是你给一个目标,它自己想办法走到终点。实现这件事,核心代码只要 50 行。

> 说明:这个项目的代码、注释、给模型看的文字全部用英文写——模型的工具调用训练数据以英文为主,英文指令引导更稳,开源仓库也更容易被国际读者看懂。你用中文跟它对话完全没问题,它会用中文回答你。

## 跟着写

### 第 1 步:环境(10 分钟)

需要三样东西:

1. **Node.js 20.6 以上**。终端输入 `node -v` 看版本;没装的话用 nvm 装:先 `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash`,重开终端,再 `nvm install --lts`。
2. **DeepSeek API Key**。打开 platform.deepseek.com,注册、充值 10 块钱、创建一个 key。10 块钱足够你跑完整个教程还有富余——这也是我们选 DeepSeek 的原因,同样的练习用别家 API 要贵一个数量级。
3. **一个空目录**:

```bash
mkdir mini-agent && cd mini-agent
npm init -y
npm i openai
npm i -D typescript tsx @types/node
git init -b main
```

装的包只需要解释两个:`openai` 是 OpenAI 官方 SDK——DeepSeek 的接口和 OpenAI 完全兼容,改一个地址就能用,不需要任何「DeepSeek 专用 SDK」;`tsx` 让你不写任何构建配置直接运行 .ts 文件。

把 key 写进项目根目录的 `.env` 文件:

```
DEEPSEEK_API_KEY=sk-your-key
```

然后**立刻**新建 `.gitignore`,写上:

```
node_modules/
.env
```

为什么是「立刻」,坑那一节再说。

### 第 2 步:把工具的「说明书」交给模型

新建 `src/raw-loop.ts`,先写上半部分:

```ts
import OpenAI from "openai";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";

// DeepSeek is fully OpenAI-compatible — just point baseURL at it
const client = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
});

// Our first (and only) tool: run a bash command
const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "run_bash",
      description: "Run a bash command on the user's machine and return its output.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to run" },
        },
        required: ["command"],
      },
    },
  },
];

function runBash(command: string): string {
  console.log(`\n🔧 running: ${command}`);
  try {
    const out = execSync(command, { encoding: "utf8", timeout: 30_000 });
    return out || "(command succeeded, no output)";
  } catch (err) {
    return `Command failed: ${(err as Error).message}`; // don't crash — feed the error back to the model
  }
}
```

这里要纠正一个最常见的误解:**模型从头到尾没有执行任何代码的能力。** 它能做的只有一件事——说话。

`tools` 数组不是「给模型一个函数」,是给模型一份**函数的说明书**:有个叫 run_bash 的东西,接受一个叫 command 的字符串参数,能干什么干什么。所谓 tool calling,是模型在回复里用结构化的方式说「我想调 run_bash,参数是 ls」——然后**你的代码**(`runBash` 函数)去真的执行,把结果贴回对话。模型负责想,你的代码负责干。记住这个分工,后面 9 天所有的设计都建立在它上面。

### 第 3 步:写循环

接着写下半部分:

```ts
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const task = await rl.question("What should the AI do?\n> ");
  rl.close();

  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: task }];

  // The essence of an agent is this loop: model → tool → model → … → final state
  for (let round = 1; round <= 10; round++) {
    const res = await client.chat.completions.create({ model: "deepseek-chat", messages, tools });
    const msg = res.choices[0].message;
    messages.push(msg);

    // No tool calls = the model considers the task done. That is the final state.
    if (!msg.tool_calls?.length) {
      console.log(`\n🤖 ${msg.content}`);
      return;
    }
    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue;
      const args = JSON.parse(call.function.arguments) as { command: string };
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: runBash(args.command).slice(0, 4000), // crude cap so huge outputs don't blow up the context
      });
    }
  }
  console.log("\n⚠️ Hit the 10-round cap, stopping."); // loop guard: stop at the cap, never burn money forever
}

main();
```

逐块看:

- `messages` 数组就是**对话历史**,也是模型的全部记忆。模型每次被调用都会重新读一遍整个数组——它本身不记得任何事。
- 每一轮:把历史发给模型 → 模型回复 → 把回复 push 进历史。
- 回复里**有** `tool_calls`:执行命令,把结果以 `role: "tool"` 的消息塞回历史,进入下一轮。
- 回复里**没有** `tool_calls`:模型认为任务完成了,打印它的总结,结束。

运行:

```bash
npx tsx --env-file=.env src/raw-loop.ts
```

`--env-file` 是 Node 自带的功能,会把 `.env` 里的 key 读进环境变量,连 dotenv 这种包都不用装。

## 为什么这么写

这 50 行里埋了三个设计决定,每一个背后都是 Claude Code 的真实做法——顺便说一句,Claude Code 本身就是 TypeScript 写的,我们用的是同款语言。

**一、agent 的本质是一个循环,值钱的是循环外面那层。** Anthropic 公开过一组对比:同一颗 Claude Opus 4.5,放在 Claude Code 里跑 benchmark 是 78 分,放在另一个开源 agent 框架里是 42 分。同样的模型、同样的题,差 36 分——差的全是循环外面这层工程,行话叫 harness。我们接下来 9 天要做的所有事——重试、权限、上下文压缩、子 agent——都是往今天这 50 行的循环上加东西。骨架始终是五根:loop、context、tool、sub-agent、eval,这个教程会全部覆盖一遍。

**二、命令失败不抛异常,把错误喂回给模型。** 注意 `runBash` 的 catch 里返回的是一个字符串,不是 `throw`。传统软件的逻辑是「出错就崩,人来修」;AI 软件的逻辑是「出错就恢复」——模型看到「Command failed: ...」之后,会自己换一个命令重试,这是它训练出来的本能。你要做的不是防止它出错,而是保证出错的信息能回到对话里。试一下就知道:让它「用 pythonn 打印 hello」(故意拼错),它会在下一轮自己改成 python。

**三、循环必须有上限。** for 循环写死 10 轮,到顶就停。没有这个上限会怎样?Claude Code 的真实事故数据:某段自动重试逻辑缺一个保险丝,单个会话连续失败重试了 3272 次——每一次都是真金白银的 API 调用。所以记一条铁律:**任何会「自动继续」的行为,都必须有「连续 N 次就停」的保险丝。** 今天先用最笨的 for 循环兜住,Day 3 我们把它升级成正经的熔断器。

## 你会踩的坑

**坑 1:API key 进了 git。** 这就是前面说「立刻写 .gitignore」的原因——必须在第一次 commit 之前。key 一旦 push 到 GitHub,几分钟内就会被扫库机器人抓走盗刷(公开仓库的 key 泄露平均存活时间以分钟计)。万一真泄露了:去 DeepSeek 后台删掉这个 key 重建一个,光删 commit 没用,历史里还在。

**坑 2:工具结果不截断。** 让它 cat 一个 10MB 的日志,整个文件会原样进对话历史,下一次 API 调用直接超长报错——或者更糟,没报错,token 全烧出去了。所以代码里有 `.slice(0, 4000)`。这个数字很粗暴,但「先有上限,再谈优雅」,Day 5 会换成正经的上下文管理。

**坑 3:配对错误。** `role: "tool"` 的消息必须跟在带 `tool_calls` 的 assistant 消息后面,一一对应 `tool_call_id`。新手最常见的报错就是漏了 `messages.push(msg)` 这一行——模型的回复没进历史,工具结果却进了,API 直接拒收。报错信息里看到 tool_call_id 几个字,先检查配对。

**坑 4:用错模型。** DeepSeek 有两个主力模型,主线全程用 `deepseek-chat`。`deepseek-reasoner` 推理能力强,但对工具调用的支持有限,放进这个循环里会让你莫名其妙。

## 小结

今天 50 行,三样东西:一个工具、一个循环、两条保险(错误喂回、轮数上限)。

你已经有了一个货真价实的 agent——给它目标,它自己决定步骤。它现在也很脆:只有一个工具,改不了文件,网络一抖就崩,Ctrl+C 退得也不体面。

明天(Ch2)给它装上一双真正的手:read_file、write_file、edit_file、search 四个专用工具,让它能直接修你的代码。到时候你会看到一个反直觉的事实:**工具好不好用,一半取决于代码,另一半取决于你给模型写的那份「说明书」**——Claude Code 光一个 Bash 工具的说明书就写了几千字。

---

*本章对应 commit:`Day 1: a raw tool-calling loop in ~50 lines`(tag `day1`)*

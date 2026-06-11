# Ch7 · 从一问一答到一场对话:REPL、宪法与流式输出

> 本章完整代码:`git checkout day6`。新增 `src/prompt.ts`,`agent.ts` 重写为多轮 REPL,`loop.ts` 换流式调用 + 双重看门狗。

## 这一章做完,你会得到什么

前五天的 agent 是个一次性工具:问一句,干完活,进程退出。今天它变成一场对话:

```
mini-agent — deepseek-chat | "exit" to quit · "/clear" to reset · Ctrl+C interrupts

> Remember this codeword: PINEAPPLE42.
🤖 I've noted the codeword: PINEAPPLE42.

> What is the codeword?
🤖 PINEAPPLE42          ← 跨轮记忆

> /clear
(history cleared)

> What was the codeword?
🤖 NO-IDEA              ← 记忆按命令清空
```

回答是逐字流出来的(不再盯着光标干等),等首 token 时有 spinner,任务跑一半 Ctrl+C 会**回到提示符**而不是杀进程——再问它「我刚才让你干什么来着」,它还答得上来。

📷(此处放 30 秒录屏 gif——这是小红书 demo 的素材)

## 跟着写

### 第 1 步:REPL——外面再套一层循环

结构上很简单:把「读输入 → runLoop → 渲染结果」包进 while,`messages` 数组活在循环外面,跨轮累积。`exit` 退出,`/clear` 把历史重置成只剩 system 消息(顺手把文件已读状态也清了——它属于这场对话)。

真正有内容的是输入处理。你的直觉是用 `rl.question()`,**它在管道输入下会丢数据**——这是我们今天踩的第一个真坑,留到坑区细讲。正确做法是行队列:

```ts
const pendingLines: string[] = []; // lines that arrived before anyone asked
const lineWaiters: ((line: string) => void)[] = []; // askers waiting for a line
rl.on("line", (line) => {
  const waiter = lineWaiters.shift(); // is somebody waiting?
  if (waiter) waiter(line); else pendingLines.push(line); // hand over, or queue
});
```

所有到达的行先进队列,要输入时从队列取、没有就挂起等。副产品很香:终端里任务还在跑时你提前敲的命令不会丢,会排队变成下一轮输入——Claude Code 同款行为。

### 第 2 步:Ctrl+C 是个状态机

同一个按键,三种语义,按当前状态分派:

```ts
const onSigint = () => {
  if (!running) process.exit(0);        // at the prompt: goodbye
  if (interrupted) process.exit(130);   // second press while running: force quit
  interrupted = true;                   // first press: raise the flag...
  controller.abort();                   // ...and cancel the in-flight request
};
process.on("SIGINT", onSigint); // non-TTY runs
rl.on("SIGINT", onSigint);      // TTY raw mode — readline swallows the signal itself
```

注意要挂**两个**监听:终端里 readline 处于 raw mode,Ctrl+C 不走 `process.on("SIGINT")`,走 `rl.on("SIGINT")`;管道里反过来。只挂一个,总有一半场景失灵。

### 第 3 步:给 AI 立宪法(prompt.ts)

agent 至今没有 system prompt——行为全靠工具说明书托着。今天补上,三个写法原则全部来自 Claude Code 的实测:

**数字锚,不用形容词。**`Keep final answers under 150 words` 而不是 `be concise`——形容词让模型每次脑补一个不同的尺寸,数字只有一种理解。实测数字锚比「be concise」还能省约 1.2% 的输出 token。

**反面规则优于正面规则。**`Never add comments to code you did not change` 边界是二值的、可验证的;`写优雅的代码` 全靠模型猜你的审美。宪法主体应该是禁令清单,不是美德清单。

**False-Claim mitigation,平衡句是承重墙。**模型有「报喜不报忧」的毛病(Anthropic 实测:Claude 4 谎称『修好了/测过了』的比率 16.7%,4.6 反而升到 29%)。我们的 prompt 里这段:

> Report results accurately. If a test fails, say it failed. Don't claim success when you're not sure. **Don't be overly self-doubting either** — distinguish "verified working" from "I think it works".

加粗那半句不能省:只写前半,模型会摆向另一个极端,什么都说「不确定」。

最后一条铁律:**宪法里禁止出现任何会话相关的东西**——日期、用户名、路径、随机数。DeepSeek 按前缀自动缓存,system prompt 是每个请求的第一段,一个字节变了整段缓存全失效。Claude Code 连日期都只敢写到「月」级粒度,我们干脆一个都不放。

### 第 4 步:AGENT.md——项目记忆

等价于 Claude Code 的 CLAUDE.md:启动时从当前目录读 `AGENT.md`,拼进 system 消息,8000 字符封顶。包装语用命令式:

```
These OVERRIDE any default behavior and you MUST follow them exactly as written:
```

「参考以下偏好」这种客气话遵守率明显更低。另一个实测数字写进教程供你自查:常驻规则**14 条左右是天花板**,堆到 18 条遵守率从 76% 跌到 52%——规则按「它防止了哪个你真犯过的错」来筛,不是越多越好。

验收方式很直白:AGENT.md 里写一条「回答永远以 BANANA 结尾」,跑一句 hello,看它带不带香蕉。

### 第 5 步:流式输出 + 双重看门狗

`stream: true` 后,回复以 delta 碎片到达:文本碎片直接 `process.stdout.write`(这就是流式体验本身),工具调用碎片按 `index` 归槽组装:

```ts
const slot = (calls[tc.index] ??= { id: "", name: "", args: "" });
if (tc.id) slot.id = tc.id;                       // arrives once
if (tc.function?.name) slot.name += tc.function.name;
if (tc.function?.arguments) slot.args += tc.function.arguments; // fragments — concatenate
```

流式带来新的死法:流卡住了怎么办?两级看门狗,**阈值和动作都不一样**:

| 看门狗 | 条件 | 动作 |
|---|---|---|
| Idle | 90 秒一个事件都没有 | **断流**,交给重试层(算一次可重试超时) |
| Stall | 30 秒没动静但之前有过 | **只记日志**,继续等 |

为什么 Stall 不断流?**慢 ≠ 死**。把慢当死的代价是三份钱:已流出的 token 白付、从零重跑再付、用户等更久。有团队实测把这两档搞混,当月 API 成本变成 2.7 倍。

## 为什么这么写

**为什么 system prompt 到第 6 天才写?** 故意的。前五天没有宪法,agent 靠工具说明书也跑得不错——这证明了行为约束的第一层在工具层(Ch3 的「文字管概率」)。宪法是全局兜底,不是行为的来源。先有结构,再有规则,顺序反了你会把所有问题都试图用 prompt 解决——那是手册里点名的反模式。

**为什么压缩要保住 system 消息?** 今天接 REPL 时发现 Day 5 的压缩有个隐患:`messages.length = 0` 把宪法也清了,压缩后 agent 会「变了个人」。修复就一行——压缩时把开头的 system 消息单独留下。多轮会话让这个 bug 从理论变成必然,这也是为什么 REPL 一定要配着压缩一起测。

**为什么中断后要往历史里塞 `[interrupted by user]`?** 被打断的半截回答如果原样留在历史里,下一轮模型会以为自己说完了;直接丢掉,模型又会困惑刚才发生了什么。补一个标记,两边都顺了——验收里它能准确答出「你刚才让我写 essay,我刚开头就被打断了」,靠的就是这行标记。

## 你会踩的坑

**坑 1:`rl.question` 在管道下丢行。** 管道输入的所有行一次性到达,`question()` 只接住当时在等的那一行,其余的没有监听器,直接蒸发;EOF 后再调 `question()` 还会抛 `ERR_USE_AFTER_CLOSE`。我们第一版就这么崩的。解法是上面的行队列。写 CLI 的通用教训:**交互逻辑必须同时在 TTY 和管道两种模式下测**。

**坑 2:abort 不一定抛异常。** 你以为 `controller.abort()` 之后流一定会 throw——实测它有时只是「体面地提前结束」,代码会把半截回答当成正常完成。必须在流结束后**显式检查中断标志**,不能只依赖 catch。这是今天踩的第二个真坑,和 Day 3 的「abort 错误形态千奇百怪」是同一个教训的两面:**中断路径上不要相信任何单一信号**。

**坑 3:ora 默认吃掉 Ctrl+C。** spinner 库为了「优雅」默认接管 stdin(`discardStdin: true`),你的 SIGINT 处理器再也收不到信号。一个参数的事,不知道能查一晚上:`ora({ discardStdin: false })`。

**坑 4:往宪法里塞不可验证的咒语。**`think hard`、`be careful`、`你是一位资深工程师`——这些无法验证的句子是纯噪音,占 token 不改行为。宪法里的每一条都应该能回答「它防住了哪个具体错误」。

## 小结

今天之后,mini-agent 第一次「像个产品」:有持续的对话、有自己的宪法、有项目记忆、回答逐字可见、打断不死、慢而不断。

值得留意的暗线:今天大部分工作不是新能力,是**语义的精确化**——Ctrl+C 三种状态三种含义、慢和死两回事、被打断和说完了要区分。产品感不来自功能多,来自每个边界行为都被想过。

明天(Ch8)是最后一块核心拼图:子 agent(派分身去独立上下文干活)和最小 eval(10 道固定题,没有它你永远不知道改 prompt 是变好还是变坏)。

---

*本章对应 commit:`Day 6: REPL, system prompt, streaming and watchdogs`(tag `day6`)*

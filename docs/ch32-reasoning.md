# Ch32 · 让换模型看得见:推理流与当前模型

> 本章完整代码:`git checkout day32`。流式循环里多读一个字段 `reasoning_content`,spinner 里多显一个模型名。

## 这一章做完,你会得到什么

Day 31 能切模型了,但有人切到 `deepseek-reasoner`(R1 推理模型)后说「没什么效果」。两个原因,这章都修掉:

**一**、推理模型会先「想」再「答」,而它的思考过程走的是一个**单独的字段** `reasoning_content`——我们之前只读 `content`,把思考全丢了。现在它会把思考过程灰着流出来:

```
❯ 这段代码为什么会死锁?

💭 thinking: 两个锁的获取顺序在两个线程里相反,A 拿了锁1 等锁2,B 拿了锁2 等锁1……
⏺ 这是经典的锁顺序反转死锁。线程 A 和 B……
```

**二**、切了模型却看不出在用哪个。现在 spinner 直接显示当前模型——一眼确认切换生效了:

```
deepseek-reasoner · Cogitating… (7s · Ctrl+C to interrupt)
```

## 跟着写

### 第 1 步:推理模型的「思考」在另一个字段里

OpenAI 的流式响应里,每个增量(delta)有 `content`。但推理模型(DeepSeek R1、o 系列的某些暴露方式)会在**答案之前**,先把思考链一段段塞进 `reasoning_content`。我们的循环只读了 `content`,所以:换到推理模型,你看到的还是只有最终答案——前面那一大段思考(往往是模型最值钱的部分)被静默丢弃了。

加上对它的处理。注意它不在 OpenAI 的类型里(是各家扩展),所以取的时候要 cast:

```ts
const reasoning = (delta as { reasoning_content?: string }).reasoning_content;
if (reasoning) {
  if (spinner?.isSpinning) spinner.stop();
  if (!opts.quiet && !opts.subAgent) {
    if (!printedThinking) { process.stdout.write("\n💭 thinking: "); printedThinking = true; }
    process.stdout.write(chalk.dim(reasoning));   // 灰着流,和正文答案区分开
  }
  // 注意:不累加进 content
}
```

### 第 2 步:思考可以看,但绝不能留

最关键的一行是那句注释:**`reasoning_content` 渲染出来给人看,但不存进对话历史**。

为什么?DeepSeek 的文档明确写了:推理模型的思考链**不要回传**给下一轮请求(回传反而会报错或降质)。而且从语义上,思考是「为了得出答案的草稿」,不是答案本身——存进历史只会污染上下文、白烧 token。所以 `content +=` 累加的永远只有答案,`reasoning_content` 只过一遍屏幕就丢。

这和我们一贯的区分一致:**给人看的**(进度、思考、diff)和**给模型留的**(答案、工具结果)是两回事,别混。

### 第 3 步:答案来之前,先收一下思考块

思考流完、答案开始时,得把那段灰色思考收个尾,免得答案接在思考后面糊成一团:

```ts
if (delta.content) {
  if (printedThinking && !printedPrefix) process.stdout.write("\n");  // 思考块换行收尾
  if (!printedPrefix) { process.stdout.write("\n" + mark.answer); printedPrefix = true; }
  process.stdout.write(delta.content);
  content += delta.content;
}
```

一个 `printedThinking` 标志,确保「思考 → 空行 → ⏺ 答案」的版式清楚。

### 第 4 步:把当前模型显在 spinner 上

第二个「没效果」其实是「看不出效果」——切了不知道有没有切。最省事的证明:让 spinner 显示当前模型。

```ts
export function spinnerText(word, elapsedSec, subAgent, model?) {
  const head = subAgent ? "sub-agent" : word;
  const tag = model && !subAgent ? chalk.dim(`${model} · `) : "";   // 顶层调用显示模型
  return `${tag}${head}… ${chalk.dim(`(${elapsedSec}s · Ctrl+C to interrupt)`)}`;
}
```

`loop.ts` 创建 spinner 和每秒更新时,都把 `opts.model` 传进去。于是每次等待时你都看到 `deepseek-reasoner · Cogitating…`——切换有没有生效,一目了然。子 agent 不显(它的档位 Day 23 已经在别处标了)。

## 为什么这么写

**为什么思考要灰着、还要单独标注?** 因为它和答案的「地位」不同:答案是给你的结论,思考是过程。视觉上拉开差距(灰色 + `💭 thinking:` 前缀),你一眼能分清「这是它在盘算」和「这是它给我的回答」。要是同样亮度糊在一起,推理模型那一大段思考反而会淹没真正的答案。

**为什么把模型显在 spinner,而不是做个底部状态栏?** 状态栏(Claude Code 那种常驻底部)要接管终端的一块固定区域,得用更重的渲染。而「你现在最想知道哪个模型在跑」的时刻,恰好就是它在跑、你在等的时候——spinner 正好在那时出现。用已有的 spinner 捎带一个模型名,零额外成本,正好够用。状态栏可以是以后的事。

**「没效果」到底是不是 bug?** 不是 `/model` 没切(Day 31 的切换是对的:主循环每轮重读 `CONFIG.model`)。是两件事让切换**显得**没用:推理模型的思考被丢了(看着和普通模型一样),以及没有任何地方告诉你当前在用哪个。两个都是「可见性」问题,不是「功能」问题——但对用户来说,看不见就等于没发生。**功能对了还不够,得让人看见它对了。**

## 你会踩的坑

**坑 1:把 `reasoning_content` 当 `content` 累加进历史。** 推理链回传给下一轮,DeepSeek 会报错或降质,还白烧 token。思考只渲染、不保留。

**坑 2:`reasoning_content` 不在 OpenAI 类型里。** 它是各家的扩展字段,TS 类型里没有,直接 `delta.reasoning_content` 编译不过。要 `(delta as { reasoning_content?: string })` 取。

**坑 3:思考和答案糊在一起。** 思考流完不收尾,答案直接贴在后面,分不清哪是过程哪是结论。用一个标志,在答案开始前给思考块补个换行。

**坑 4:子 agent 的 spinner 也显模型。** 子 agent 的内心活动本来就不该抢主视线(Day 7),它的模型档位 Day 23 已在「sub-agent [model]」那行标过。spinner 的模型标只给顶层。

## 小结

本章修掉「换模型看着没效果」:流式循环多读 `reasoning_content`,把推理模型的思考灰着流出来(只看不留,绝不回传);spinner 显示当前模型,让切换一眼可见。两处都很小——一个字段、一个标志、一个可选参数——但它们把 Day 31 那个「确实切了你却感觉不到」的功能,变成了「切了你立刻看得见」。

`npm test` 324 例,新增 9 个:spinner 的模型标(子 agent 不标)、用假 client 验证推理流被渲染但**不进历史**。

它收的是一条容易被忽略的尾:**一个用户感知不到的功能,等于没做。** 把"切换生效"这件事做得看得见,和把切换本身做对,同样重要。

---

*本章对应 commit:`Day 32: reasoning stream + visible active model`(tag `day32`)*

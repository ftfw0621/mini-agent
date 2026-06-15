# Ch28 · 让它看起来像个正经工具:终端 UI

> 本章完整代码:`git checkout day28`。新增 `src/ui.ts`,把散落在 agent.ts / loop.ts 的 emoji 和颜色收进一处。

## 这一章做完,你会得到什么

之前启动就一行灰字、提示符是个光秃秃的 `>`。现在:

```
╭────────────────────────────────────────────────────────────────╮
│ mini-agent  v0.19.0                                              │
│ deepseek-chat  ·  api.deepseek.com                               │
│                                                                  │
│ /help  commands     @file  attach a file     Ctrl+C  interrupt   │
╰────────────────────────────────────────────────────────────────╯

❯ 修一下 cart.js 的 bug

⏺ read_file {"path":"cart.js"}
⏺ edit_file {"path":"cart.js", ...}
⏺ 改好了,第 4 行把减号写成了乘号。
```

一个圆角欢迎框、一个 `❯` 提示符、统一的 `⏺`/`⎿` 活动标记、一个会走秒的 spinner——功能没变一行,但它从「玩具脚本」变成了「正经工具」。

## 跟着写

### 第 1 步:先把「外观」收进一个模块

动手改样式前,先意识到一个问题:颜色和 emoji 散落在 `agent.ts`(banner、提示符)和 `loop.ts`(`🔧`、`🤖`、`⛔`、spinner 文案)里,各写各的。想统一风格,得满仓库翻。

所以第一步不是改样式,是**归拢**:新建 `src/ui.ts`,让它独占「这个工具长什么样」。别处只管调用,不再自己拼颜色。这和 Day 24 把传输收进 Transport、Day 4 把权限收进一个闸门是同一个动作——**一类决策,收敛到一处**。

### 第 2 步:用 emoji 还是用字形?

老版本用 `🔧`(工具)、`🤖`(回答)。换成 `⏺`(一个动作/回答)、`⎿`(挂在它下面的细节)、`❯`(提示符)。为什么?

- **对齐**:emoji 是「宽字符」(占两格),`.length` 数成 1,画框、padding 一律错位;`⏺`/`❯` 是单格,宽度可控;
- **气质**:满屏 emoji 像玩具,克制的字形像工具。Claude Code 用的就是 `⏺`/`⎿` 这套。

这不只是审美。下一步画框就会发现,宽度算不准的字符根本没法对齐。

### 第 3 步:画一个圆角框

欢迎框的核心是「把若干行文字,套进一个等宽的圆角边框」。难点只有一个:**宽度怎么算**。

```ts
function box(lines: { text: string; style?: (s: string) => string }[]): string {
  const width = Math.max(...lines.map(l => l.text.length));   // 按【纯文本】算宽度
  const top = chalk.dim(`╭${"─".repeat(width + 2)}╮`);
  const bottom = chalk.dim(`╰${"─".repeat(width + 2)}╯`);
  const body = lines.map(l => {
    const cell = l.text.padEnd(width);                        // 先把纯文本补齐到等宽
    return chalk.dim("│ ") + (l.style ? l.style(cell) : cell) + chalk.dim(" │"); // 再上色
  });
  return [top, ...body, bottom].join("\n");
}
```

关键顺序:**先按纯文本算宽度、补齐,再上色**。为什么不能反过来?因为 `chalk.cyan("hi")` 产出的字符串里塞了 ANSI 转义码(`\x1b[36mhi\x1b[39m`),`.length` 会把这些看不见的码也数进去——你以为 2 个字符,实际 12 个,padding 全乱。所以:给 `box` 传**纯文本**,它量好宽度、补好空格,最后才把整个「补齐后的格子」包进颜色。颜色裹在 padding 外面,对齐就不会坏。

### 第 4 步:提示符与活动标记

提示符从 `> ` 换成带颜色的 `❯`,计划模式(Day 20)换个黄色的 `⏸ plan ❯`,让人一眼知道现在写操作被挡着:

```ts
export function promptString(planMode: boolean): string {
  return planMode ? chalk.yellow.bold("\n⏸ plan ❯ ") : chalk.cyan.bold("\n❯ ");
}
```

活动标记集中成一个 `mark` 对象,`loop.ts` 里那些 `console.log(chalk.cyan("🔧 ..."))` 全换成 `mark.tool(name, args)`:

```ts
export const mark = {
  tool: (name, args) => chalk.cyan("⏺ ") + chalk.bold(name) + (args ? chalk.dim(` ${args}`) : ""),
  answer: chalk.green("⏺ "),
  denied: (reason) => chalk.red("  ⎿ ") + chalk.red(`denied — ${reason}`),
  declined: chalk.yellow("  ⎿ declined"),
  subAgentStart: (desc, tier) => chalk.blue("  ⎿ sub-agent") + (tier ? chalk.dim(` [${tier}]`) : "") + chalk.blue(`: ${desc}`),
  // ...
};
```

改完之后,`loop.ts` 不再出现任何一个 emoji 或裸 `chalk.红(...)`——它说「这是一次工具调用」,至于工具调用长什么样,交给 `ui.ts` 定。

### 第 5 步:让等待「活」起来

老 spinner 永远是 `thinking...`,一动不动让人怀疑卡死了。新的:一个会轮换的词 + 实时秒数 + 怎么打断。

```ts
const WORDS = ["Thinking", "Pondering", "Cogitating", "Reasoning", "Working", ...];
export function thinkingWord(seed: number): string {
  return WORDS[((seed % WORDS.length) + WORDS.length) % WORDS.length];  // 按 seed 取,不用 Math.random
}
export function spinnerText(word, elapsedSec, subAgent): string {
  return `${subAgent ? "sub-agent" : word}… ${chalk.dim(`(${elapsedSec}s · Ctrl+C to interrupt)`)}`;
}
```

秒数从哪来?**白嫖已有的看门狗**。Day 3 的看门狗本来就每秒跑一次查流是否卡死——顺手在那一拍里更新 spinner 文案:

```ts
const watchdog = setInterval(() => {
  if (spinner?.isSpinning) spinner.text = spinnerText(word, Math.floor((Date.now() - startedAt) / 1000), !!opts.subAgent);
  // ...原来的 idle/stall 判断
}, 1000);
```

不用新开一个定时器——「每秒做点什么」的循环已经有了,加一行就行。轮换的词用一个**自增计数器**当 seed(`thinkingWord(modelCallSeq++)`),而不是 `Math.random`:既能每次换一个,又确定、可测。

## 为什么这么写

**为什么样式要收进一个模块,而不是就地改?** 因为「外观」是一类会反复一起变的决策。今天你想把 emoji 换字形,明天想换配色,后天想加个无颜色模式——散在两个文件里,每次都要全仓库翻、还容易漏。收进 `ui.ts`,换肤就是改一个文件。这不是洁癖,是把「会一起变的东西放在一起」(高内聚)落到实处。

**为什么先量宽度再上色,这点值得单独讲?** 因为它是终端 UI 最常见、最隐蔽的坑。ANSI 颜色码是「零宽度但占字符数」的幽灵:屏幕上看不见,`.length` 却算它。任何「先上色再对齐」的代码,在有颜色时必崩、无颜色时却正常——测试还容易漏(测试环境 chalk 默认关色)。记住:**对齐用纯文本算,颜色最后裹上去。**

**为什么 spinner 的词不用 `Math.random`?** 一来这门课里我们一直避开不确定性(它让测试不可复现);二来用一个自增计数器当 seed,效果一样(每次换),却能写出 `thinkingWord(0) === "Thinking"` 这种确定的断言。**能用确定性的地方,就别引入随机。**

## 你会踩的坑

**坑 1:用 `.length` 量带颜色的字符串。** `chalk.cyan("hi").length` 是 12 不是 2。画框、补齐、截断,只要涉及宽度,一律拿**纯文本**算,色最后上。

**坑 2:用 emoji 当对齐字符。** `🔧`、`🤖` 是宽字符,在框里、在缩进里都会错位。要对齐,用单格字形(`⏺`/`⎿`/`❯`)。

**坑 3:CJK 也是宽字符。** 同理,中文在框里按 `.length` 算也会错位——所以欢迎框的内容我们刻意只放 ASCII(模型名、URL)。要支持中文标题,得引入一个「显示宽度」函数,那是另一个故事;这一章先不踩。

**坑 4:为了走秒新开一个定时器。** 完全没必要。Day 3 的看门狗已经是个每秒一跳的循环,spinner 更新搭车进去就行。多一个定时器,多一个要清理、可能泄漏的东西。

## 小结

本章没加任何功能,只做了一件事:把这台 agent 的「外观」从散落各处收进 `src/ui.ts`——圆角欢迎框、`❯` 提示符、`⏺`/`⎿` 活动标记、会走秒的 spinner。沿途讲清了终端 UI 最容易栽的那个坑:颜色码会污染宽度计算,所以对齐用纯文本、颜色最后裹。

`npm test` 277 例,新增 21 个:banner 含版本/型号/边框、提示符区分计划模式、各活动标记、thinking 词的确定性与循环、spinner 的秒数与打断提示。

工具好不好用,功能是里子,样子是脸面。前 27 天搭里子,这一章给它一张能让人愿意天天打开的脸。**一个你愿意天天看的终端,本身就是生产力。**

---

*本章对应 commit:`Day 28: a coherent terminal UI`(tag `day28`)*

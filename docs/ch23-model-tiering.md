# Ch23 · 让杂活用便宜的模型:子 agent 模型分级

> 本章完整代码:`git checkout day23`。config 加一个字段、loop 加一个纯函数,子 agent 跑在自己的「档位」上。

## 这一章做完,你会得到什么

主 agent(编排者)和子 agent(干杂活的)可以跑在**不同的模型**上:

```json
// .mini-agent/settings.json
{
  "model": "deepseek-chat",
  "subAgentModel": "deepseek-chat-lite"
}
```

```
> 把整个 src 目录读一遍,告诉我每个文件是干嘛的

🔧 task {"description": "read every file under src/ and summarize each"}
  ⎿ sub-agent started: [deepseek-chat-lite] read every file under src/...
  ⎿ sub-agent done
🤖 这是各文件的职责:...
```

那个标着 `[deepseek-chat-lite]` 的子 agent,读几十个文件、做摘要这种**体力活**,用便宜快的模型;而需要全局判断、把摘要整合成结论的**编排**,留给强模型。一次任务,两个档位,各司其职。

反过来也成立:你可以把 `subAgentModel` 指向一个**更强**的模型,让它当「顾问」——主 agent 拿不准时,委托一个更聪明的脑子去核查。机制是同一个,方向由你定。

## 跟着写

### 第 1 步:一个配置字段

子 agent 用哪个模型,是**运维决策**(成本 vs 质量),不是模型该临场决定的事。所以它进配置,不进工具参数:

```ts
// config.ts
subAgentModel:
  process.env.MINI_AGENT_SUBAGENT_MODEL ||
  projectSettings.subAgentModel ||
  globalSettings.subAgentModel ||
  undefined,   // undefined = 不分级,子 agent 和主 agent 同模型
```

走的是 Day 11 那套老规矩:环境变量 > 项目 > 全局 > 默认。不配就是 `undefined`——一切照旧,子 agent 跟主 agent 一个模型。新功能默认不改变旧行为。

### 第 2 步:把「用哪个档位」抽成一个纯函数

分级规则就一句话:配了就用配的,没配就用主模型。但把它单独拎出来,而不是写成一行内联三元:

```ts
// loop.ts
export function subAgentModelFor(opts: { model: string; subAgentModel?: string }): string {
  return opts.subAgentModel?.trim() || opts.model;
}
```

为什么值得单独一个函数?因为这是一条**会被测试盯住的规则**,而它依赖的 `runLoop` 要真发 API 请求、难单测。把规则抽成纯函数,它就能脱离整个 loop 被直接验证:配了用配的、没配回落、空白字符串也回落(`trim()` 把 `"  "` 当没配)。**让难测的逻辑里,可测的那部分单独可测**——这是 Day 16 把 `interpretJudgeOutput` 拎出来、Day 19 把 `validateArgs` 拎出来的同一个手法。

### 第 3 步:子 agent 用它选模型

子 agent 本就是 `runLoop` 带 `subAgent: true` 递归一次。现在多覆盖一个 `model`:

```ts
async function runSubAgent(description: string, opts: LoopOptions): Promise<string> {
  const subModel = subAgentModelFor(opts);             // 这趟杂活跑哪个档位
  if (!opts.quiet) {
    const tier = subModel !== opts.model ? chalk.dim(` [${subModel}]`) : ""; // 真的换了才标注
    console.log(chalk.blue("  ⎿ sub-agent started:") + tier + ...);
  }
  // ...
  const result = await runLoop(subMessages, { ...opts, subAgent: true, model: subModel }); // 在自己的档位上跑
}
```

`{ ...opts, model: subModel }`——别的依赖(client、signal、权限、judge)全继承,只把 `model` 换掉。子 agent 的每次 API 调用于是都打到 `subModel`。日志里 `[subModel]` 只在**真的换了档**时才显示:分级是花钱的事,必须看得见,不能在账单上给人惊喜。

### 第 4 步:怎么确认它真的换了模型?

这功能不像前几章能在屏幕上一眼看到效果——模型名藏在 API 请求里。怎么**证明**子 agent 真用了另一个模型,而不是我以为它用了?

办法是用一个**假 client**,把每次调用的 `model` 记下来:

```ts
const seenModels: string[] = [];
const fakeClient = { chat: { completions: {
  create: async (params) => { seenModels.push(params.model); return scriptedStream(); }
}}};
// 脚本:① 主 agent 调 task 工具 → ② 子 agent 回一句话 → ③ 主 agent 回一句话
await runLoop(messages, { client: fakeClient, model: "main-model", subAgentModel: "sub-model", ... });

// seenModels === ["main-model", "sub-model", "main-model"]
```

三次调用、三个模型名,断言中间那次是 `sub-model`——**子 agent 确实跑在了分级的档位上**,委托结束后控制权又回到主模型。这是全书第一次用假 client 做端到端测试:不联网、不花钱,却把「编排者→委托→回到编排者」这条真实路径完整跑了一遍。验证的是**行为**,不是我嘴上说的功能。

## 为什么这么写

**为什么档位是配置,不是让模型自己挑?** 因为「这活值不值得用强模型」是成本权衡,答案取决于你的预算和这个项目的要求,模型自己没有这个上下文,也没有为你的账单负责的立场。让模型临场挑档位,等于把运维决策交给一个没装钱包的人。配置里定死,确定、可预期、可审计——和 Day 20 把「现在该不该改文件」交给人定,是同一种「决策归属」的判断。

**为什么子 agent 适合降档,主 agent 不适合?** 因为它俩干的活不同。子 agent 干的是**有明确边界的体力活**:读这些文件、搜这个模式、把结果列出来——便宜模型足够胜任,而且它跑在隔离上下文里(Day 7),错了也不会污染主线。主 agent 干的是**全局编排**:理解你到底要什么、判断子 agent 的报告可不可信、决定下一步——这才是最吃模型能力的地方,省这里的钱最不划算。把贵的算力花在判断上,把便宜的算力花在搬运上。

**「顾问」方向又是怎么回事?** 同一个机制,把 `subAgentModel` 指向更强的模型,子 agent 就成了主 agent 的「外脑」:主 agent 拿不准时委托它核查。这正是源书那个「强模型审查弱模型产出」的 Advisor 模式——我们没为它写一行专门代码,它只是模型分级的一个用法。一个机制,两个方向,取决于你把档位调高还是调低。

## 你会踩的坑

**坑 1:`/cost` 的估算会被两个模型的价格搅浑。** 我们的成本表(Day 18)是按主模型的单价算的;子 agent 用了另一个模型,它的 token 仍按主模型计价。分级省了真金白银,但 `/cost` 的数字是个混合估算,不是精确账。知道这个简化,别拿它当财务报表。

**坑 2:给子 agent 配了个不支持 function calling 的模型。** 子 agent 也要调工具(读文件、搜)。挑「便宜」模型时,便宜但不会调工具的(很多小模型、推理特化模型)会让子 agent 直接瘫掉。降档可以,但底线是得会 function calling。

**坑 3:以为子 agent 会继承主 agent 的对话。** 不会,从来不会(Day 7)。换不换模型都一样:子 agent 永远是一张白纸,task 的 description 是它的全部世界。换了个更弱的模型,这一点只会更要命——描述写不全,弱模型更容易跑偏。

**坑 4:分级了却不显示。** 子 agent 静默地用了另一个模型,用户看 `/cost` 发现数字对不上、看行为发现质量变了,却不知道为什么。日志里把档位标出来(`[sub-model]`)、`/model` 里列出来——花钱的事,默认透明。

## 小结

本章给委托加了一个「档位」:子 agent 可以跑在和主 agent 不同的模型上,便宜的干体力活、强的当顾问,由配置一锤定音。实现极小——一个配置字段、一个纯函数 `subAgentModelFor`、子 agent 递归时换掉 `model`。但它第一次用假 client 把「编排→委托→回归」这条路径端到端验证了,证明分级真的发生在了该发生的地方。

`npm test` 212 例,新增 8 个:分级规则的三种回落,加一个假 client 跑通的端到端委托(断言中间那次调用用了子 agent 模型)。

它接上了 Day 7 的子 agent 和 Day 16 的裁判:委托不只是「分一摊活出去」,还能「分给对的脑子」——贵的算力留给判断,便宜的算力交给搬运。

---

*本章对应 commit:`Day 23: sub-agent model tiering`(tag `day23`)*

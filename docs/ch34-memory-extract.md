# Ch34 · 记忆会自己长出来:分类型 + 自动提取

> 本章完整代码:`git checkout day34`。把 Day 17 的单层记忆深化:加类型、加「每轮自动提取」、按类型分组注入。

## 这一章做完,你会得到什么

Day 17 的记忆有个软肋:它**全靠模型记得调 `remember`**——而模型经常忘。这一章让记忆**自己长出来**。

开了 `settings.memory.autoExtract` 之后,每轮结束,一个便宜的提取调用会读一遍对话,把值得记的自动存下来——**尤其是你纠正过它的地方**:

```
❯ 不对,这个项目要用 import 不能写全限定名

🤖 明白了,我改成 import。
(remembered 1: always import classes, never use fully-qualified names)
```

而且记忆**分了类型**:

```
❯ /memory
long-term memory (.mini-agent/MEMORY.md):
  [user] the user is a backend engineer who prefers Java + Spring
  [feedback] always import classes, never use fully-qualified names
  [project] the build command is pants build
  [reference] API docs: https://example.com/api
```

## 跟着写

### 第 1 步:四种类型,feedback 最金贵

手册 §17 把记忆分四类:**user**(你是谁、你的偏好)、**feedback**(你给的纠正/指导)、**project**(项目决策/约定/坑)、**reference**(外部指针)。

为什么分类?因为它们对模型的**份量不同**。"项目用 pnpm"是事实;"你纠正过我别写全限定名"是**指令**——模型该更重视后者。把类型显式存下来,注入上下文时就能分区呈现:

```ts
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
// 存盘格式:- [feedback] always import classes...
```

四类里 **feedback 最值钱**,书里那句话点透了:**模型 90% 做对的不用记,10% 被你纠正的才是金子。** 一个 agent 会不会越用越顺手,就看它记不记得住你纠正过它的事。

### 第 2 步:向后兼容地加类型

老格式是 `- fact`,新格式是 `- [type] fact`。解析时两者都认——没有类型标签的(手写的、Day 17 存的)一律当 `project`:

```ts
function parseEntry(text): MemoryEntry {
  const m = text.match(/^\[(\w+)\]\s*(.*)$/);
  if (m && MEMORY_TYPES.includes(m[1])) return { type: m[1], fact: m[2].trim() };
  return { type: "project", fact: text.trim() };   // 旧的/手写的 → project
}
```

而且 `readMemory()` 仍然返回**纯事实文本**(剥掉类型前缀),新增一个 `readMemoryTyped()` 返回带类型的——这样 Day 17 那些调用方一行不用改。**加能力别破接口。**

### 第 3 步:每轮自动提取——记忆的高频写入路径

核心来了。Day 17 只有"模型显式调 remember"这一条写入路径(低频,还常被忘)。§17 加了一条**高频路径**:每轮结束,自动读对话、提取记忆。

做法是一次**结构化提取调用**(不是完整 agent 循环,省钱):

```ts
const EXTRACT_SYSTEM = `从这段编码助手对话里提取值得跨会话保留的记忆。
只输出 JSON 数组,每项 {"type": "...", "fact": "一句话"}。
特别优先「用户纠正/纠偏助手」的那些轮次(归为 feedback,最有价值)。
不要存:临时任务状态、正在修的 bug、看代码就知道的东西。没有就输出 []。`;

export async function extractMemories(client, model, messages) {
  const transcript = buildTranscript(messages);     // 最近 12 轮,各截 600 字
  const res = await client.chat.completions.create({
    model, messages: [{role:"system",content:EXTRACT_SYSTEM},{role:"user",content:transcript}], stream:false,
  });
  const extracted = parseExtractedMemories(res.choices[0].message.content);
  for (const e of extracted) addFact(e.fact, e.type);   // 存盘(addFact 内部去重)
  return extracted;
}
```

解析那一步单拎成纯函数 `parseExtractedMemories`,宽容地从模型输出里抠出 JSON 数组(容忍 ```json 围栏和前后废话),丢掉缺字段的、把非法 type 归 project:

```ts
export function parseExtractedMemories(text): MemoryEntry[] {
  const m = text.match(/\[[\s\S]*\]/);                  // 第一个 […]
  const arr = JSON.parse(m[0]);
  return arr.filter(x => typeof x.fact === "string" && x.fact.trim())
            .map(x => ({ type: asType(x.type), fact: x.fact.trim() }));
}
```

### 第 4 步:接到每轮之后,但要可关、要兜底

提取在 REPL 里、一轮 `Done` 之后跑——而且**默认关**(它是一次额外的 API 调用,要花钱):

```ts
if (CONFIG.memory.autoExtract && result.reason === TerminateReason.Done) {
  try {
    const got = await extractMemories(client, CONFIG.subAgentModel || CONFIG.model, messages);
    if (got.length) console.log(`(remembered ${got.length}: ...)`);
  } catch { /* 记忆提取永远不能搞崩会话 */ }
}
```

三个分寸:**默认关**(尊重账单,用户在 settings 里显式开);**用便宜模型**(有 `subAgentModel` 就用它,杂活不该用贵的,Day 23);**永不抛异常**(提取失败就跳过,下一轮再试,绝不让一个辅助功能拖垮主会话)。

## 为什么这么写

**为什么要自动提取,不够用 remember 工具吗?** 因为"靠模型记得调工具"是不可靠的。模型专注在当前任务上,很少分神去想"这个值得存吗"。把提取变成**会话外的一个独立步骤**,记忆就从"指望模型自觉"变成"系统保证"。这正是 §17 的设计:remember 是低频显式路径,自动提取是高频隐式路径,两条都要。

**为什么专盯「用户纠正过的轮次」?** 因为那是**信息密度最高**的地方。模型做对的事,下次它大概率还会做对,记了是噪音;模型做错、被你纠正的事,是它**不知道**的项目知识——记下来,下次就不会再犯。一个越用越顺手的 agent,本质就是"被纠正一次,就永久记住"。把提取的注意力压到这 10%,记忆质量最高、token 最省。

**为什么默认关?** 因为它真花钱——每轮多一次调用。你刚被一个"自动持久化"坑过(Day 31 那次),我学乖了:**会产生成本或副作用的功能,默认关,让用户显式开。** 想要记忆自动生长,settings 里一行 `"memory": { "autoExtract": true }`;不想要,它就安安静静不花一分钱。

## 你会踩的坑

**坑 1:把提取做成完整 agent 循环。** 提取只需要"读对话 → 吐 JSON",一次无工具的调用就够,别派一个能调工具、会跑好几轮的子 agent——又慢又贵。结构化的单次调用,是这类"分析型"任务的正解。

**坑 2:把提取的记忆当真理。** 提取是模型干的,会漏会错。所以注入上下文时仍标注"background, verify against the code"(Day 17 的口径),并且有去重和有界(40 条/12KB),错的、过时的会被新的挤掉或被你手动删——记忆文件永远是人类可读可改的。

**坑 3:改了 `readMemory` 的返回类型,把老调用方全弄崩。** 加类型很容易顺手把 `readMemory()` 改成返回对象,结果 `/memory`、启动计数全挂。保持老接口返回纯文本,新增 `readMemoryTyped()`——加法,不是改写。

**坑 4:非法 type 直接写进文件。** `addFact("x", "bogus")` 要是原样存成 `[bogus] x`,下次解析"bogus"不是合法类型,整行就被当成 project 事实、前缀也成了事实的一部分。写入前用 `asType` 把类型归一化,文件格式才始终可解析。

## 小结

本章把记忆从"单层、靠模型自觉"深化成"分类型、会自动生长":四种类型(feedback 最金贵)、向后兼容的格式、每轮一次结构化提取(专盯用户纠正、默认关、用便宜模型、永不抛异常)、按类型分组注入上下文。

`npm test` 375 例,新增覆盖:类型解析与回落、分组注入、`parseExtractedMemories` 的围栏/缺字段/非法类型/非数组、用假 client 跑通端到端提取。

它落地了手册 §17 的核心:**一个 agent 该越用越懂你——而"懂"不该指望模型自觉,要让系统在每轮之后,把你纠正过的东西默默记下来。** (满配版的凌晨整合 Auto-Dream 我们没做,够用版到此为止。)

---

*本章对应 commit:`Day 34: typed memory + auto-extraction`(tag `day34`)*

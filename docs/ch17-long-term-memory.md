# Ch17 · 记住跨会话的事:长期记忆

> 本章完整代码:`git checkout day17`。新增 `src/memory.ts`,接进 `prompt.ts` 的系统消息和 `agent.ts`。

## 这一章做完,你会得到什么

会话 1,告诉它一个项目事实:

```
> 这个项目的部署命令是 shipit --prod-canary,用 remember 工具记下来
🔧 remember {"fact": "部署命令是 shipit --prod-canary"}
🤖 已存入长期记忆,以后的会话都能看到。
```

会话 2,**全新进程、对话历史为空、没有 --resume**:

```
$ mini-agent
(long-term memory: 1 facts loaded)
> 这个项目的部署命令是什么?
🤖 shipit --prod-canary       ← 它记得
```

会话持久化(Day 12)记的是「这次对话聊到哪了」,长期记忆记的是「关于这个项目我该一直记住的事实」——两件不同的事。

## 跟着写

### 第 1 步:就是一个 Markdown 文件

长期记忆存在 `.mini-agent/MEMORY.md`,项目级、**人类可读可改**:

```
# mini-agent long-term memory
# One fact per line. Injected into context at session start. Edit freely.
- 部署命令是 shipit --prod-canary
- 这个项目用 pnpm 不用 npm
- DB 迁移别手写,跑 scripts/migrate.ts
```

不是向量库,不是 embedding——**一个你能打开、能读、能手动改的文件**。这是个刻意的选择:对一个单项目的开发工具,「能直接看到 agent 记住了什么、能划掉记错的」比「语义检索」值钱得多。透明可控 > 花哨。

### 第 2 步:remember 工具

模型通过一个 `remember` 工具往里加事实:

```ts
export const rememberTool: Tool = {
  definition: { type: "function", function: {
    name: "remember",
    description: `Save a durable fact about THIS project... (persists across sessions).
Use it for things still true next time: build/test command, a gotcha, a convention, a decision and its reason.
Do NOT use it for transient state (current task, today's bug). Keep each fact to one sentence.`,
    ...
  }},
  run: (args) => addFact(args.fact ?? ""),
};
```

工具描述里**最重要的是那条边界**:记「持久的事实」,不记「这次任务的临时状态」。不写清楚,模型会把「我现在在修第 3 个 bug」也存进去——下次会话加载一堆过期的废话,污染上下文。Ch3 的教训:工具描述决定模型用得对不对。

它走和所有工具一样的注册 + dispatch + 权限闸门(默认 ask;信任了 `tool:remember` 进 allow 免确认)。

### 第 3 步:注入——是背景,不是命令

启动时把记忆拼进系统消息。注意措辞和 AGENT.md 不一样:

```ts
// AGENT.md:  These OVERRIDE any default behavior and you MUST follow them...
// memory:    ...things you established earlier; treat as BACKGROUND, verify
//            against the code before relying on a specific claim
```

AGENT.md 是用户写的硬规则(MUST follow);长期记忆是 **agent 自己攒的事实,可能过时**——所以框定成「背景信息,用之前对照代码核实」。这个区别要命:把自攒的、可能错的记忆当成不可违抗的命令,等于让 agent 被自己上一次的误判绑架。**记忆是参考,不是圣旨。**

### 第 4 步:有界 + 自修复

无界记忆是两个 bug 等着发生:① 稀释注意力(Ch6:规则越多遵守越差);② 缓存前缀无限膨胀。所以两个上限:最多 30 条、最多 8000 字节。超了**丢最旧的**(新事实更可能还成立)。

```ts
function addFact(fact) {
  let facts = readMemory();
  if (facts.includes(clean)) return "Already remembered"; // 幂等去重
  facts.push(clean);
  if (facts.length > MAX_ENTRIES) facts = facts.slice(-MAX_ENTRIES);     // 数量上限
  while (byteLength(body) > MAX_BYTES && facts.length > 1) facts.shift(); // 字节上限
  writeFileSync(MEMORY_PATH, HEADER + body);
}
```

关键设计:**每次写入都重新套一遍上限**——这叫自修复(self-healing)。哪怕你手动把文件编辑成 500 行,下一次 `remember` 写入时会自动缩回 30 条以内。约束不是「写的时候检查一次」,是「每次写都强制成立」,文件就永远不可能违反上限。Day 12 的快照、Day 16 的 fail-closed 解析,都是同一种「让坏状态结构性地不可能」的思路。

## 为什么这么写

**为什么记忆和会话持久化分开?** 它们答的是两个问题。会话持久化答「我们刚才聊到哪」——是易失的、跟着对话走的,`/clear` 就该清掉。长期记忆答「关于这个项目有哪些一直成立的事」——是稳定的、跨对话的,`/clear` 不该动它。混在一起,你要么清不掉聊天记录,要么把项目知识也一起清了。

**为什么用文件不用数据库?** 因为这是单人、单项目的工具。文件的好处全占了:能 `cat`、能手动改、能进 git(团队共享项目知识)、零依赖、出问题能直接看。向量检索的价值要到「记忆条数成千上万」才显现——单项目几十条事实,线性放进上下文又简单又够用。**别为还没有的规模付复杂度**(Ch9 的判断)。

**为什么记忆是「背景」而 AGENT.md 是「命令」?** 来源不同,可信度就不同。AGENT.md 是人写的、人审的,是意图;长期记忆是 agent 自己在某次会话里判断「这值得记」存下的,可能当时就理解偏了,也可能现在过时了。给它们不同的措辞,模型才会用不同的信任级别对待——硬规则照做,自攒事实先核实。

## 你会踩的坑

**坑 1:把临时状态记成长期事实。**「当前在修登录 bug」存进长期记忆,三个月后每次会话都被告知一个早就修完的 bug。靠工具描述把「持久 vs 临时」的边界讲死,是第一道防线。

**坑 2:记忆当圣旨。**模型记了「用 npm」,后来项目换了 pnpm,但记忆还在——如果框定成 MUST,模型会无视眼前的 `pnpm-lock.yaml` 硬上 npm。框定成「背景,先核实」,它才会以代码为准。

**坑 3:无界增长。**不设上限,长期项目的记忆文件能涨到几千行,既稀释注意力又顶缓存。30 条 / 8KB,丢最旧。

**坑 4:上限只在写时查一次。**「append 时如果超了就截断」不够——文件可能被手动编辑、被旧版本写过。每次写入都重新强制上限,坏状态才结构性地不可能存在。

## 小结

本章给 mini-agent 一个跨会话的记忆:一个人类可读的 `MEMORY.md`、一个 `remember` 工具、启动时作为「背景」注入(区别于 AGENT.md 的「命令」)、有界且自修复。它和会话持久化各司其职——一个记「聊到哪」,一个记「项目是什么样」。

`npm test` 114 例,新增 16 个全是记忆的边界行为(去重、空值、数量/字节上限、丢最旧、手动编辑后自修复)。真机验证:一个会话存的部署命令,另一个全新进程零提示就答得出来。

到这里,进阶篇给 mini-agent 补齐了工业级 agent 的大部分骨架:配置、持久化、异步、扩展(hook/MCP)、双层权限、长期记忆。它还是每行你都看得懂——记忆系统总共也就 90 行。

---

*本章对应 commit:`Day 17: long-term cross-session memory`(tag `day17`)*

# Ch25 · 这趟会话到底改了啥:/diff 总览

> 本章完整代码:`git checkout day25`。给 Day 22 的撤销账本加一个「会话起点基线」,REPL 加一个 `/diff` 命令。

## 这一章做完,你会得到什么

聊了二十轮,agent 改了七八个文件,你想在收工前一眼看清**这趟会话的净改动**:

```
> /diff
3 files changed this session:

modified src/loop.ts
  +12 -3
    ...

created src/diff.ts
  +60 -0
    ...

deleted src/old-helper.ts
  +0 -41
    ...
```

不是「最近一次改了啥」(那是 Day 22 的 `/undo`),而是**从会话开始到现在,每个文件的累计变化**——改了多少、建了什么、删了什么,一览无余。提交前的自查,有了。

## 跟着写

### 第 1 步:为什么 `/undo` 的栈答不了这个问题

Day 22 已经在每次写入前记了「之前」的快照。那直接拿来用不就行了?

不行。撤销栈有两个特性,正好让它**不适合**当会话账本:

1. **它是有界的**(只留最近 50 次)——长会话里早期的改动会被挤掉;
2. **它会被弹出**——`/undo` 一次就少一条。

所以撤销栈记的是「**操作历史**」,会增会减。而 `/diff` 要的是「**净状态**」:每个文件**第一次**被碰时长什么样(基线),和现在长什么样(当前),两头一比就是净改动。这是两个不同的问题,需要一本不会被弹出、不会被挤掉的账。

### 第 2 步:一个「会话起点基线」表

在撤销模块里加一张 map:每个文件**第一次**被改动时的内容,记一次,之后永不覆盖:

```ts
const origin = new Map<string, string | null>();  // path → 会话起点内容(null = 当时不存在)

export function recordMutation(absPath: string): void {
  // ...（原来记撤销快照的逻辑不变）
  if (!origin.has(absPath)) origin.set(absPath, before); // 关键:只在第一次设,记住会话起点
  // ...
}
```

`if (!origin.has(...))` 是整章的题眼:同一个文件这趟会话改十次,基线**永远是第一次那个**。撤销快照每次都更新(它要还原到上一步),基线只认第一次(它要对比到起点)。两本账,各记各的,共用同一个 `recordMutation` 入口。

### 第 3 步:算出净改动

`sessionChanges` 遍历基线表,逐个和磁盘当前状态比:

```ts
export function sessionChanges(): SessionChange[] {
  const changes = [];
  for (const [p, base] of origin) {
    const current = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; // 现在长啥样
    if ((base ?? null) === (current ?? null)) continue;                   // 净零改动 → 跳过
    const status = base === null ? "created" : current === null ? "deleted" : "modified";
    changes.push({ path: p, status, baseline: base ?? "", current: current ?? "" });
  }
  return changes;
}
```

三种状态由两个 null 推出来:基线是 null = 这趟**新建**的;当前是 null = 被**删**了;都不是 null = **改**了。还有一个关键的 `continue`:**净零改动不算改动**——一个文件改了又改回起点(比如改完又 `/undo` 回来),`base === current`,它就不该出现在 `/diff` 里。`/diff` 报的是这趟会话的**净效果**,不是它的过程。

### 第 4 步:挂上 `/diff`,复用 Day 21 渲染

```ts
case "/diff": {
  const changes = sessionChanges();
  if (!changes.length) { console.log("(no file changes this session)"); return true; }
  console.log(`${changes.length} files changed this session:`);
  for (const c of changes) {
    console.log(`\n${verb[c.status]} ${short(c.path)}`);  // created / modified / deleted,各上一个颜色
    console.log(renderDiff(c.baseline, c.current));        // 又一次复用 Day 21
  }
  return true;
}
```

`renderDiff`(Day 21 写的)再次免费复用:它已经会算 `+N -M`、折叠没动的行。`/diff` 只管把会话里每个变了的文件喂给它。`/clear` 开新会话时,顺手把基线表也清掉(和清撤销栈、清「读过的文件」一起)——新会话的 `/diff` 从干净的起点重新算。

## 为什么这么写

**为什么基线只记第一次,撤销快照却每次都记?** 因为它俩回答不同的问题。撤销要「退回上一步」,所以它要的是**最近**的 before;`/diff` 要「对比到起点」,所以它要的是**最早**的 before。同一个 `recordMutation` 调用里,一个用 push(永远加最新),一个用 `if (!has) set`(只认最早)——两种记法对应两种语义,挤在一个入口里反而看得清它们的区别。

**为什么 `/diff` 直接读磁盘,而不是累加每次写入的内容?** 因为磁盘才是**唯一的真相**。中途可能有 `/undo`、可能有外部编辑器也动了文件、可能有别的工具改了它。与其在内存里维护一份「我以为的当前内容」(迟早和磁盘对不上),不如每次 `/diff` 都现读现比——基线在内存(起点不会变),当前看磁盘(以现实为准)。这和 Day 22 的撤销「以磁盘现状算 diff」是同一个判断:**别维护可能撒谎的影子状态**。

**为什么净零改动要跳过?** 因为 `/diff` 是给人做决定用的(要不要提交、有没有改错),它该显示的是**结果**。一个文件折腾了五轮最后回到原样,对结果没有贡献,列出来只是噪音。Day 21 折叠没变的行、Day 18 别浪费 token,都是同一种克制:**只给人看有意义的那部分**。

## 你会踩的坑

**坑 1:用撤销栈当会话账本。** 有界 + 会弹出,长会话里早期改动直接消失,`/diff` 就会漏报。会话级的「净状态」需要一本独立的、不删不挤的账。

**坑 2:基线被后续写入覆盖。** 忘了 `if (!origin.has(...))`,每次写入都更新基线,基线就永远等于「上一次的内容」,`/diff` 算出来的就只是最后一次写入的 diff,不是整个会话的。基线必须钉死在第一次。

**坑 3:`null` 和 `""` 不分。** 「文件不存在」(基线 null)和「文件是空的」(基线 `""`)推出来的状态不同:前者是 created,后者是 modified。混了,新建的空文件就会被错报成修改。两个 null 推三种状态,全靠把它俩分清楚。

**坑 4:在内存里维护「当前内容」。** 写入时顺手把新内容也缓存起来,听着省事,但 `/undo` 一来、外部一改,缓存就和磁盘脱节,`/diff` 跟着撒谎。当前内容永远现读磁盘,不留影子。

## 小结

本章给会话加了一个净改动总览:在撤销账本旁边记一张「会话起点基线」表(每个文件第一次被碰时的样子,只记一次),`/diff` 把它和磁盘现状逐个比对,复用 Day 21 的渲染器画出每个文件从起点到现在的 diff,净零的跳过。核心就一句话:**基线钉第一次,当前看磁盘**。

`npm test` 227 例,新增 9 个:基线只认首次、created/modified/deleted 三态、净零跳过、`/clear` 清账。

它和 Day 21/22 凑成了文件改动的完整闭环:**Day 21 看单次改动(写之前)、Day 22 撤单次改动(写之后)、Day 25 看整趟会话(收工前)**——人对 agent 改了什么,从一刀到一程,全程看得见。

---

*本章对应 commit:`Day 25: /diff session summary`(tag `day25`)*

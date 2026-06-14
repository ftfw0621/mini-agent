# Ch22 · 给一颗后悔药:/undo 撤销上一次写入

> 本章完整代码:`git checkout day22`。新增 `src/undo.ts`,在两个写文件工具里各加一行,REPL 加一个 `/undo` 命令。

## 这一章做完,你会得到什么

Day 21 让你在改动**发生前**看清它;这一章让你在改动**发生后**把它拿回来。

```
🔧 edit_file {"path": "cart.js", ...}
🤖 改好了,把减号改成了乘号。

> /undo
↩ restored cart.js to its previous content
  +1 -1
-     total += it.price * it.qty;
+     total += it.price - it.qty;
```

批准了、改完了,回头发现不对——一句 `/undo` 就回到上一步。新建的文件会被删掉,改过的文件会还原成改之前的样子。

## 跟着写

### 第 1 步:一次写入,就是一段「之前」的快照

撤销的本质,是在每次改动**之前**,把文件原来的样子存下来。我们不依赖 git(项目可能根本不是仓库),就存最朴素的东西:改之前那一刻,文件的完整内容——或者一个「它本来不存在」的标记。

```ts
export interface Mutation {
  path: string;            // 改了哪个文件(绝对路径)
  before: string | null;   // 改之前的内容;null = 文件原本不存在(这是一次新建)
}

const stack: Mutation[] = [];   // 最近一次改动在栈顶

export function recordMutation(absPath: string): void {
  let before: string | null = null;
  try { if (fs.existsSync(absPath)) before = fs.readFileSync(absPath, "utf8"); } catch { before = null; }
  stack.push({ path: absPath, before });
  if (stack.length > MAX_UNDO) stack.shift();   // 有界:只留最近 50 次
}
```

一个栈(后进先出),一个上限。`before` 为 `null` 是关键的一类——它区分「改了一个已有文件」和「凭空建了一个文件」,这俩的撤销动作完全不同。

### 第 2 步:在写入前埋一行,把快照接到真实工具上

`recordMutation` 要在文件被改**之前**调用。所以它埋在 write_file 和 edit_file 真正落盘的那一行前面:

```ts
// write_file
fs.mkdirSync(path.dirname(p), { recursive: true });
recordMutation(p);                               // ← 先存「之前」
fs.writeFileSync(p, args.content, "utf8");

// edit_file
recordMutation(p);                               // ← 先存「之前」
fs.writeFileSync(p, content.replace(args.old_string, () => args.new_string), "utf8");
```

两处共两行。注意它必须在 `writeFileSync` **之前**——晚一步,磁盘上已经是新内容,「之前」就丢了。这也是为什么撤销要埋在工具内部、贴着那一次写:只有这里能在覆盖发生前的最后一刻,抓住旧状态。

### 第 3 步:撤销——还原内容,或删掉新建的文件

`undoLast` 弹出栈顶,按 `before` 的两种情况分别处理:

```ts
export function undoLast(): UndoResult | null {
  const m = stack.pop();
  if (!m) return null;                           // 没东西可撤
  const after = fs.existsSync(m.path) ? fs.readFileSync(m.path, "utf8") : null; // 当前内容,用来给人看 diff

  if (m.before === null) {                        // 这次改动是「新建」→ 撤销 = 删除
    if (fs.existsSync(m.path)) fs.rmSync(m.path);
    return { path: m.path, summary: `removed ${short} (it had just been created)`, before: null, after };
  }
  fs.writeFileSync(m.path, m.before, "utf8");      // 否则把旧内容写回去
  return { path: m.path, summary: `restored ${short}`, before: m.before, after };
}
```

返回值里同时带上 `before`(要还原成的样子)和 `after`(撤销前的当前样子)——这样 REPL 能用 **Day 21 的 `renderDiff`** 把「撤销做了什么」也画成一个 diff 给人看。昨天写的渲染器,今天直接复用。

### 第 4 步:挂上 `/undo`,顺手在 `/clear` 里清掉历史

```ts
case "/undo": {
  const undone = undoLast();
  if (!undone) { console.log("(nothing to undo)"); return true; }
  console.log(`↩ ${undone.summary}`);
  console.log(renderDiff(undone.after ?? "", undone.before ?? ""));  // 复用 Day 21
  return true;
}
```

还有一个容易漏的点:`/clear` 开一段全新对话时,要把撤销历史也清掉(`clearUndo()`)——新对话不该能撤销上一段对话里的写入,那些文件早已是「过去式」。这和 `/clear` 同时清掉「读过哪些文件」是同一个道理:**撤销栈属于这一段会话,会话没了它就该没**。

## 为什么这么写

**为什么存完整内容,不存 diff?** 因为还原要的是「之前长什么样」,完整内容直接就是答案,写回去即可,零歧义。存 diff 反而要在撤销时再做一次反向 patch,多一层会出错的逻辑。文件通常不大(我们 Day 21 还设了 20 万字节的预览上限),50 次历史的内存完全可接受。**简单且精确,胜过省内存但易错。**

**为什么 `/undo` 不告诉模型?** 因为它是**人对文件系统**的操作,不是对话的一个回合。模型的上下文里还留着它那句「我改好了」——我们不去改它。万一模型之后又要编辑这个被你撤销过的文件,它以为里面还是它改后的样子,可 edit_file 的「先读后改 + 精确匹配」(Day 2)会发现 old_string 对不上,直接让它重读。**旧的安全网自动接住了这个不一致**,不用专门处理。

**为什么撤销失败要把记录推回栈?** 如果还原时磁盘报错(权限、磁盘满),这次撤销没成功——那它就不该从历史里消失。推回去,用户能再试一次。撤销本身也得对自己的失败诚实,这和 Day 3「失败是要处理的状态、不是异常」一脉相承。

## 你会踩的坑

**坑 1:在写入之后才记录。** `recordMutation` 晚于 `writeFileSync` 一行,抓到的就是新内容,撤销变成「还原到刚写的样子」=没用。必须严格在覆盖前。

**坑 2:`before` 用空字符串表示「文件不存在」。** 空字符串是「文件存在但内容为空」,和「文件根本不存在」是两回事——前者撤销要写回空文件,后者撤销要**删掉**文件。必须用 `null` 和 `""` 区分,混了就会留下一个本该消失的空文件。

**坑 3:`/clear` 后还能撤销旧写入。** 不清撤销栈,新对话一句 `/undo` 就把上一段会话改的文件还原了,用户一脸懵。会话级状态,跟着会话一起清。

**坑 4:把撤销做成无界历史。** 不设上限,长会话里成百上千次写入的完整快照全留着,内存悄悄涨。50 次足够覆盖「啊刚才改错了」的真实场景,够用就好。

## 小结

本章给 agent 加了一颗后悔药:每次写文件前悄悄存一份「之前」,`/undo` 弹出最近一次、还原内容或删掉新建的文件,并复用 Day 21 的 diff 把撤销结果画给你看。核心是一个有界的快照栈、贴着写入埋的两行、对「新建 vs 修改」和「失败要推回」的几个边界处理。

`npm test` 204 例,新增 15 个覆盖:还原内容、删除新建、LIFO 顺序、空栈、`/clear` 清栈,以及走真实 edit_file 工具的端到端撤销。

它把 Day 4/20/21 攒起来的「人在回路」补全了最后一块:Day 4 能**拒绝**,Day 20 能**先看计划**,Day 21 能**看清每一刀**,Day 22 能**改完反悔**。人对 agent 的掌控,不只在它动手前,也在它动手后。

---

*本章对应 commit:`Day 22: /undo last write`(tag `day22`)*

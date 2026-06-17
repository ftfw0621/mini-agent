# Ch36 · 给 agent 一张待办清单:TodoWrite

> 本章完整代码:`git checkout day36`。给模型一个 `todo_write` 工具,让它把计划写下来、边做边勾;再加一个「催办」机制,防止计划写完就烂尾。

## 这一章做完,你会得到什么

长任务有个隐疾:上下文被一堆工具输出灌满,模型**忘了最初的目标**——你让它做五件事,做到第三件就飘了。解法不是更强的模型,是给它一块**外置的工作记忆**:一张它自己维护的待办清单。

```
❯ 把 config 模块拆成三个文件,各加单测,最后跑一遍全套测试

⏺ todo_write {"todos":[{"content":"拆分 config.ts ...
  ○ 拆分 config.ts 为 loader / schema / defaults
  ○ 给三个文件各写单测
  ○ 跑全套测试确认绿

⏺ read_file config.ts
⏺ write_file src/config/loader.ts
⏺ todo_write {"todos":[ ...
  ✓ 拆分 config.ts 为 loader / schema / defaults
  ▶ 给三个文件各写单测
  ○ 跑全套测试确认绿
```

模型先把计划摊开,然后每完成一步就回来把 `○` 翻成 `✓`、把下一项点亮成 `▶`。你随时 `/todos` 看它进行到哪。关键是:**这只加了「规划能力」,没加任何「执行能力」**——`todo_write` 在磁盘上什么都不改,它只让模型的意图**对你可见、对它自己持久**。

别和 Day 20 的**计划模式**搞混:计划模式是一个**模式**,只读研究后把计划交给**你**批准才动手;TodoWrite 是一个**工具**,模型给**自己**列清单、执行中持续更新。一个管「动手前要不要人把关」,一个管「执行中别跑偏」。

## 跟着写

### 第 1 步:把清单和它的规则收进一个文件(todos.ts)

整张清单就是一个 `Todo[]`,每项一句话 + 一个状态。新建 `src/todos.ts`,把**状态、校验、渲染、催办**全收在这一个文件里(别为它散一堆类):

```ts
export type TodoStatus = "pending" | "in_progress" | "completed";
export interface Todo { content: string; status: TodoStatus; }
```

校验要**严**——模型的参数是概率性的,坏了就返回一句能照着修的话(错误是文字,不是异常)。这里有条值得硬性执行的规则:**最多一个 `in_progress`**。「一次只做一件事」正是清单买来的纪律,满屏 in_progress 只是换个名字的待办堆。

```ts
export function parseTodos(raw: unknown): { todos?: Todo[]; error?: string } {
  if (!Array.isArray(raw)) return { error: "`todos` must be an array of { content, status }" };
  // ...逐项检查 content 非空、status 合法...
  if (todos.filter((t) => t.status === "in_progress").length > 1)
    return { error: "only one todo may be in_progress at a time" };
  return { todos };
}
```

渲染用字形不用文字——一列 `✓ / ▶ / ○` 一眼扫得清,进行中的那项最显眼(注意力该在那儿),做完的淡掉:

```ts
export function renderTodos(todos: Todo[]): string {
  return todos.map((t) =>
    t.status === "completed"   ? chalk.green("  ✓ ") + chalk.dim.strikethrough(t.content)
    : t.status === "in_progress" ? chalk.cyan.bold("  ▶ ") + chalk.bold(t.content)
    : chalk.dim("  ○ " + t.content),
  ).join("\n");
}
```

### 第 2 步:工具本身——整张表覆盖式提交

`todo_write` 的约定和 Claude Code 一致:模型**每次把完整清单发过来**(替换旧的,不做增量补丁)。`def()` 那个辅助函数只会拼平铺的字符串参数,所以这个工具的「数组套对象」schema 手写:

```ts
const todoWrite: Tool = {
  definition: { type: "function", function: { name: "todo_write", description: `...`,
    parameters: { type: "object", required: ["todos"], properties: { todos: {
      type: "array", items: { type: "object", required: ["content", "status"], properties: {
        content: { type: "string", description: "The step, phrased as an action" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
      } } } } } } },
  run: (args) => {
    const parsed = parseTodos((args as { todos?: unknown }).todos);
    if (parsed.error) return fail(parsed.error);     // 精确修复提示,不崩
    setTodos(parsed.todos!);                          // 存下来(顺便重置催办计时)
    return summarizeTodos(parsed.todos!);             // 只回一行计数给模型
  },
};
```

注意 run() **只回一行计数**(`Plan saved — 1 done, 1 in progress, 2 pending. Now: ...`)。漂亮的清单是给**人**看的,模型刚把这张表发出来,没必要再花 token 把它自己的计划读回去。漂亮渲染在循环里做(那里才知道 `quiet` 与否):

```ts
// loop.ts —— 工具跑完后
if (call.name === "todo_write" && !opts.quiet && !content.startsWith("[error]")) {
  console.log(renderTodos(getTodos())); // 给人看的清单;eval / 子 agent 静默
}
```

工具进 `tools` 注册表,权限里给一个 `allow`(它没有副作用),计划模式里也放行(规划正是计划模式要干的事)。

### 第 3 步:催办——不催,清单写完就烂尾

光有工具不够:模型经常**写一次计划就再不看**,清单很快过期、变成废话。所以加个「催办」——连续几轮没更新计划,就塞一句提醒。状态就两个数:当前清单、距上次更新过了几轮。

```ts
let staleRounds = 0;
export function setTodos(todos: Todo[]): void { current = todos; staleRounds = 0; } // 更新即重置
export const NAG_AFTER_ROUNDS = 3;
export function todoNag(): string | null {
  const unfinished = current.some((t) => t.status !== "completed");
  if (!current.length || !unfinished) return null;   // 没计划 / 全做完 → 不催
  if (++staleRounds < NAG_AFTER_ROUNDS) return null;
  staleRounds = 0;                                    // 触发后重新计时(每 N 轮催一次,不是每轮)
  return "[plan reminder] 你的待办还有没做完的,但你好几步没更新了。有进展就 todo_write 勾掉/推进下一项;计划变了就重写。别丢了最初的目标。";
}
```

循环里每个「工具轮」末尾调一次,非空就作为一条 user 消息注入(和 Stop hook 注入指令是同一招):

```ts
// loop.ts —— 一轮工具跑完、break 之前
if (!opts.subAgent) {
  const nag = todoNag();
  if (nag) messages.push({ role: "user", content: nag });
}
```

### 第 4 步:计划是会话级的,该清就清

清单活在进程内存里(和 Claude Code 一样),属于**当前这个任务**。所以 `/clear` 和 `/resume` 切换会话时一起 `clearTodos()`;再加个 `/todos` 随时查看当前计划。子 agent **不给** `todo_write`——计划是顶层 agent 的,子 agent 往这张共享清单上写会把它冲掉。

## 为什么这么写

**为什么加「规划」而不是加「能力」?** 这是这个工具最容易被误解的点。`todo_write` 不读文件、不改文件、不跑命令——它一个字节都不动磁盘。它的全部价值是**对抗漂移**:当上下文被几十个 read/edit 的输出淹没,「用户最初要的五件事」很容易沉底。把意图写成一张始终在场的清单,目标就能熬过满屏的工具输出。能力是手,规划是脑子,这章加的是脑子。

**为什么整张表覆盖,不做增量?** 增量补丁(「把第 2 项标记为完成」)需要稳定的 id、需要模型记住上次的列表、容易对不齐。让模型每次发完整列表,状态机就退化成「拿最新的覆盖」——无状态、不会漂移、模型也不用记账。多发几十个 token,换掉一整类同步 bug,划算。

**为什么催办是必需的,不是锦上添花?** 没有催办,模型的典型行为是:开局写一份漂亮计划 → 然后再也不碰 → 清单和现实越差越远 → 等于没有。催办把「更新计划」变成一种被定期提示的习惯。注意它**触发后重新计时**,每 N 轮最多催一次,否则就成了刷屏的噪音。

## 你会踩的坑

**坑 1:漂亮清单喂给了模型。** 把带 ANSI 颜色的渲染结果当 run() 的返回值塞回模型——既烧 token 又是一堆它看不懂的转义码。分清两个出口:**给人**的是带色清单(在循环里打,认 `quiet`),**给模型**的是一行计数。

**坑 2:子 agent 共享了清单。** 清单是模块级单例。要是子 agent 也能 `todo_write`,它一写就把顶层 agent 的计划冲了。子 agent 的工具列表里直接过滤掉 `todo_write`。

**坑 3:催办每轮都响。** 触发后不重置计时器,模型每一轮都被同一句话怼,提醒变骚扰。触发即 `staleRounds = 0`,留出 N 轮安静期。

**坑 4:允许多个 in_progress。** 不拦,模型会把一半的项都标成「进行中」——清单立刻退化成一个没有焦点的待办堆。校验里硬性只允许一个,把「一次做一件事」钉死在工具层。

## 小结

本章给 agent 加了**自我规划**:一个 `todo_write` 工具(整表覆盖、最多一个进行中)、一份会话级的内存清单、一套「✓ ▶ ○」的终端渲染、一个每 N 轮的催办。核心就一句话——**这是给脑子加规划,不是给手加能力**:`todo_write` 在磁盘上什么都不改,它只让模型的意图对你可见、对它自己持久,从而在长任务里守住最初的目标。

`npm test` 474 例,新增覆盖:`parseTodos` 的各种坏输入、渲染字形、计数摘要、催办状态机(N 轮后触发、触发后重新计时、更新即重置、全做完不催)。

它落地了规划与协调那条主线:**当任务的步数超过模型一眼能拎住的量,就给它一块外置的、看得见的工作记忆。** 下一步顺理成章——当一个步骤大到值得一个独立上下文,就把它**委派**出去(那正是 Day 7 的子 agent 干的事)。

---

*本章对应 commit:`Day 36: TodoWrite`(tag `day36`)*

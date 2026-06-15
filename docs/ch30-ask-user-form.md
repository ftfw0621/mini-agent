# Ch30 · 让 agent 问得明白:多问题选择表单

> 本章完整代码:`git checkout day30`。新增 `src/form.ts`(纯状态机)+ `menu.ts` 的 `promptForm`,给模型一个 `ask_user` 工具。

## 这一章做完,你会得到什么

Day 29 让**你**审批时用选的。这一章反过来:让**模型**需要你拿主意时,也弹一个表单让你选——而不是在正文里问一长串、等你打字回。模型一次能问好几个问题,你逐个选完,提交,它收到的是整理好的答案:

```
The agent needs your input:

1. Which database?
  ● Postgres
❯ ○ SQLite

2. Auth method?
  ○ JWT
  ○ Sessions

  ▶ Submit answers (answer every question first)

↑↓ to move · Enter to choose / submit · Esc to cancel
```

模型拿到的不是要它解析的一段话,而是干净的 `Which database? → Postgres / Auth method? → Sessions`。**问得结构化,答得无歧义。**

## 跟着写

### 第 1 步:把表单做成一个纯状态机

表单比单选菜单(Day 29)复杂:多个问题、每个有自己的选中项、一个全局光标在所有选项和「提交」之间走、提交还要校验「都答了没」。这种有状态的交互,最容易写成一坨纠缠的回调。

所以先把它拆成一个**纯状态机**,放进 `form.ts`,和键盘、终端完全无关:

```ts
export interface FormState {
  cursor: number;       // 在「所有选项行 + 提交行」这个扁平列表上的位置
  selections: number[]; // selections[q] = 第 q 问选中的选项下标,-1 = 没答
}

export function reduceForm(questions, state, action): { state; done? } {
  if (action === "up")   return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
  if (action === "down") return { state: { ...state, cursor: Math.min(rows - 1, state.cursor + 1) } };
  // select(回车/空格):
  const row = rowAt(questions, state.cursor);
  if ("submit" in row) {
    const gap = state.selections.findIndex(s => s < 0);
    if (gap < 0) return { state, done: true };                  // 都答了 → 真提交
    return { state: { ...state, cursor: cursorForQuestion(questions, gap) } }; // 没答完 → 跳到缺口
  }
  const selections = state.selections.slice();
  selections[row.q] = row.opt;                                  // 记下这一问的答案
  return { state: { ...state, selections } };
}
```

整个表单的逻辑——光标怎么动、选项怎么记、提交什么时候才算数——全在这一个纯函数里。给它 `(状态, 动作)`,还你 `新状态`。没有副作用,意味着每一条状态转移都能被单测钉死。

### 第 2 步:扁平化是关键的简化

多个问题、每个有若干选项,听着像二维的。但导航时把它**拍平成一维**:第 1 问的选项、第 2 问的选项……最后一个「提交」行,首尾相连成一条列表。光标就是这条列表上的一个下标。

```ts
export function rowAt(questions, cursor): {q, opt} | {submit:true} {
  let i = cursor;
  for (let q = 0; q < questions.length; q++) {
    if (i < questions[q].options.length) return { q, opt: i };  // 落在第 q 问里
    i -= questions[q].options.length;
  }
  return { submit: true };                                       // 超出所有选项 = 提交行
}
```

光标的上下移动退化成 `cursor ± 1`(夹在 `[0, 行数-1]`),一维问题。要不要二维地维护「当前在第几问、第几项」?不用——`rowAt` 随时能把一维下标翻译回 `{第几问, 第几项}`。**用一维表示、按需翻译成二维**,比全程维护二维状态简单得多。

### 第 3 步:提交要守一道关

「提交」不是无条件的。还有问题没答,按提交不能放行——而且要友好地**把光标送到第一个没答的问题**,而不是干瞪眼:

```ts
if ("submit" in row) {
  const gap = state.selections.findIndex(s => s < 0);  // 第一个 -1
  if (gap < 0) return { state, done: true };           // 没缺口 → 完成
  return { state: { ...state, cursor: jumpTo(gap) } };  // 有缺口 → 跳过去
}
```

渲染时,提交行也跟着变:没答完显示「Submit answers (answer every question first)」,答完了才变成干净的「Submit answers」。**让用户随时知道还差什么**,比提交时弹个错误好。

### 第 4 步:键盘驱动是薄薄一层

纯状态机写好后,`promptForm`(在 `menu.ts`)就只是 Day 29 那套「借 stdin、进 raw 模式、监听按键、选完归还」再加一个 reduce:

```ts
const onKey = (_s, key) => {
  if (key.name === "up")   { state = reduceForm(qs, state, "up").state;   draw(); }
  if (key.name === "down" || key.name === "tab") { state = reduceForm(qs, state, "down").state; draw(); }
  if (key.name === "return" || key.name === "space") {
    const next = reduceForm(qs, state, "select"); state = next.state;
    if (next.done) finish(collectAnswers(qs, state));  // 提交成功 → 交出整理好的答案
    else draw();
  }
  if (key.name === "escape") finish(null);             // 取消
};
```

按键 → 动作 → reduce → 重绘。所有难的逻辑都在纯函数里,这一层薄到几乎没有出错空间。重绘还是「上移固定行数、清屏、重画」——而且因为**选中项不改变行数**,要上移多少行可以一次算好。

### 第 5 步:给模型一个 ask_user 工具

最后,让模型能主动用它。加一个 `ask_user` 工具,参数是「问题数组,每个带选项」:

```ts
const askUserTool = { name: "ask_user", description:
  `需要用户在选项间做决定时(用哪个方案、改哪个文件、是/否/哪个),就调它,别在正文里问——选比打字省力,答案也无歧义。每个问题给 2–4 个具体选项。`,
  parameters: { questions: [{ question, options }] } };
```

它和 `task`、`exit_plan_mode` 一样是**特殊工具**:执行它需要 CLI 的输入能力,不在工具注册表里,而是在 `execute()` 里拦下来,调一个 `askUser` 回调(由 `agent.ts` 用 `promptForm` 实现),把答案整理成工具结果喂回模型:

```ts
if (call.name === "ask_user") {
  const answers = await opts.askUser(questions);
  if (!answers) return "用户取消了提问,按你的判断继续,或确有必要再问一次。";
  return `The user answered:\n${answers.map(a => `- ${a.question} → ${a.answer}`).join("\n")}`;
}
```

权限上,`ask_user` 判 `allow`(问问题没有副作用,是模型能做的最安全的事);非交互会话(管道、`-p`)里 `askUser` 返回 null,模型被告知「这儿没法弹表单,请用文字问」。

## 为什么这么写

**为什么把状态机和键盘拆开?** 因为表单逻辑是这章唯一真正复杂的东西,而它恰好可以完全脱离 I/O。拆出来后,「上移夹紧、选项记录、提交校验、缺口跳转、答案收集」全是纯函数,能被几十个用例覆盖;键盘那层只剩「按键映射到动作」,薄到不需要测终端也能放心。这是全书第无数次用这招——**难的逻辑做成纯函数,难测的副作用压到最薄**。

**为什么让模型问、而不是直接替用户做主?** 因为有些决定**只有用户能拍板**:用哪个数据库、要不要删这个文件、按方案 A 还是 B。模型猜,猜错了代价大;模型问,但用正文问又得让用户打字、还可能问得含糊。`ask_user` 是中间最优解:模型把决定**结构化**地交还给用户,用户一秒选完,模型拿到确定的答案。**该模型做的让模型做,该用户拍板的结构化地问。**

**为什么 ask_user 是「特殊工具」而不是普通工具?** 因为它要弹一个交互式表单,而表单需要 stdin / 终端——那是 `agent.ts` 的地盘,不是 `tools.ts` 里一个纯函数 `run()` 能碰的。所以和 `task`(需要 loop 本身)、`exit_plan_mode`(需要翻转模式)一样,它在 `execute()` 里被拦下、走一个注入的回调。**工具的「执行」需要 CLI 能力时,就用回调把那能力递进去。**

## 你会踩的坑

**坑 1:用二维状态维护光标。** 「当前第几问 + 第几项 + 是否在提交行」三个变量同步着改,边界条件爆炸。拍平成一维下标 + 一个 `rowAt` 翻译函数,简单太多。

**坑 2:提交不校验就放行。** 用户漏答一问直接提交,模型收到半截答案。提交时检查有没有 `-1`,有就把光标送到那个缺口,别让用户自己找。

**坑 3:重绘时行数算错。** 表单重绘靠「上移 N 行重画」,N 必须等于表单的总行数。幸好选中项不增减行数(只是把 ○ 变 ●),所以 N 是常数,首帧算一次就行——但要是哪天加了「选错时显示一行错误」,N 就变了,重绘会错位。

**坑 4:非交互环境硬弹表单。** 管道、CI、`-p` 单发里没有终端,弹表单会卡死或乱码。`promptForm` 在非 TTY 直接返回 null,`ask_user` 据此告诉模型「改用文字问」——和 Day 29 的菜单一个回退策略。

## 小结

本章给模型加了一个 `ask_user` 工具:需要用户决策时,弹一个多问题选择表单,用户逐个选、提交,模型收到整理好的答案。核心是把表单做成 `form.ts` 里的一个**纯状态机**(扁平光标 + reduce + 提交校验 + 答案收集),键盘驱动只是薄薄一层;`ask_user` 作为特殊工具,通过回调拿到 CLI 的输入能力。

`npm test` 309 例,新增 20 个:扁平行模型、reduce 的移动/选择/提交/缺口跳转、答案收集、渲染,以及用假输入流跑通「选满 → 提交 → 拿到答案」「Esc 取消」「非 TTY 返回 null」。

Day 29 和 Day 30 合起来,把人机之间的「问答」两个方向都从打字换成了选择:**你批准它用选的,它问你也用选的。** 选择比输入省力——这条朴素的体验原则,值得贯穿到每一次交互。

---

*本章对应 commit:`Day 30: ask_user multi-question form`(tag `day30`)*

# Ch29 · 选择比输入更省力:方向键审批菜单

> 本章完整代码:`git checkout day29`。新增 `src/menu.ts`,把审批从「输入 y/N」换成「↑↓ 选」,顺带给输入加了个框。

## 这一章做完,你会得到什么

以前要批准一个写操作,得停下来打 `y` 再回车——还得记住是 `y` 还是 `yes`、大小写敏不敏感。现在是一个键盘菜单:

```
⚠ approval needed — edit_file (writes to your filesystem):
   cart.js

❯ 1. Yes
  2. Yes, and don't ask again for edit_file this session
  3. No — let me tell the agent what to do instead
↑↓ to move · Enter to select · Esc to cancel
```

↑↓ 移动、回车确认。选项**带编号**、底下一行**操作提示**,和 Claude Code 一个路子。**选择比输入对人的损耗小**:不用想拼什么,一眼扫过三个选项,一个键搞定。中间那个「这次会话别再问了」还能让它在本次会话里不再就这个工具打扰你。

输入区也加了个框:

```
╭──────────────────────────────────────────
│ ❯ 修一下 cart.js 的 bug
╰──────────────────────────────────────────
```

## 跟着写

### 第 1 步:难点是和 readline 抢键盘

整个会话的输入,由一个 readline 接口(Day 6)管着——它在等「一行」。但方向键菜单要的是**单个按键**(↑↓ 回车),不是一行。这俩对 stdin 的用法是冲突的:不能两个都在读。

所以菜单的核心动作是一次**借用与归还**:暂停 readline → 把 stdin 切到「原始模式」(raw mode,按键即到、不等回车)→ 自己监听按键 → 选完,把 stdin 原样还给 readline。

```ts
export function promptSelect(rl, options, input = process.stdin): Promise<number> {
  return new Promise((resolve) => {
    if (!input.isTTY) return resolve(-1);          // 没有终端就没法选 —— 调用方回退到打字
    let selected = 0, done = false;

    const finish = (result) => {
      if (done) return; done = true;
      input.off("keypress", onKey);                // 停止监听
      try { input.setRawMode(false); } catch {}    // 把终端还回去
      rl.resume();                                 // readline 重新接管
      resolve(result);
    };
    // ...监听 + 绘制...
    rl.pause();                                    // 先让 readline 别抢键
    readline.emitKeypressEvents(input);            // 把原始字节翻译成「具名按键」
    input.setRawMode(true);                        // 按键即到
    input.on("keypress", onKey);
  });
}
```

`readline.emitKeypressEvents` 是关键的帮手:它把终端发来的原始转义字节(`\x1b[A` 这种)翻译成 `{name: "up"}` 这样的具名事件,省得我们自己解析 ANSI。

### 第 2 步:监听按键,原地重绘

按键处理就是一个状态机:上下移动改 `selected`,回车提交,Esc / Ctrl+C 取消。

```ts
const onKey = (_str, key) => {
  if (!key || done) return;
  switch (key.name) {
    case "up":   case "k": selected = (selected - 1 + options.length) % options.length; draw(false); break;  // 顶上再按 ↑ 绕到底
    case "down": case "j": selected = (selected + 1) % options.length; draw(false); break;
    case "return": case "enter": finish(selected); break;
    case "escape": finish(-1); break;
    default: if (key.ctrl && key.name === "c") finish(-1);   // raw 模式下 Ctrl+C 是按键不是信号
  }
};
```

注意两个细节:**取模实现绕回**(到顶再按上,跳到最后一项);**Ctrl+C 在 raw 模式下不是信号、是一个按键**(`{ctrl:true, name:"c"}`)——所以得在这里手动当成「取消」,否则用户按 Ctrl+C 会没反应。

每次移动都要**原地重绘**,而不是往下滚出一堆菜单。靠 ANSI:光标上移 N 行、清掉、重画:

```ts
const draw = (first) => {
  if (!first) process.stdout.write(`\x1b[${options.length}A`);  // 上移到菜单顶
  process.stdout.write(`\x1b[J${renderMenu(options, selected)}\n`);  // 清到屏末,重画
};
```

`renderMenu` 是纯函数(放在 `ui.ts`):选中的那行加 `❯` 高亮,其余灰着。纯函数意味着它能脱离终端被测——这一点下面会用到。

### 第 3 步:「这次会话别再问了」怎么落地

菜单中间那个选项,选了之后得真的生效——本会话内不再就这个工具问。怎么做?**复用 Day 4 的权限规则**:往 `CONFIG.permissions.allow` 里塞一条 `tool:<工具名>`,这正是「预批准」走的那条路。

```ts
if (choice === 1 && toolName) {
  CONFIG.permissions.allow.push(`tool:${toolName}`);   // 本会话预批准这个工具
}
```

但有个工具要特殊照顾:`run_bash`。它的权限不是按「工具」判的,是按「命令内容」判的(Day 4 的 `checkBash`)。所以光塞 `tool:run_bash` 不够,得在闸门里接一下——而且**必须守住硬红线**:

```ts
case "run_bash": {
  const verdict = checkBash(args.command ?? "");
  // 「本会话别再问 run_bash」把 ask 升成 allow —— 但硬 deny(rm -rf /、.git、.env)永远不动
  if (verdict.decision === "ask" && CONFIG.permissions.allow.includes("tool:run_bash")) {
    return { decision: "allow", reason: "bash pre-approved for this session", summary: verdict.summary };
  }
  return verdict;
}
```

只升级 `ask`,绝不碰 `deny`。你说「bash 这次会话别问了」,指的是「那些本来要确认的命令放行」,不可能是「`rm -rf /` 也放行」。便利可以加,但 Day 4 的禁飞区一寸不让。

### 第 4 步:非 TTY 自动回退到打字

`promptSelect` 在没有终端时(管道、CI、`-p` 单发)返回 `-1`,审批函数据此回退到老的 `y/N`:

```ts
if (!process.stdin.isTTY) { /* fail closed 或 y/N */ }
const choice = await promptSelect(rl, options);   // TTY 才走菜单
```

这样脚本化运行、非交互环境一切照旧,只有真人在真终端前时才升级成菜单。**新体验是加法,不破坏旧路径。**

### 第 5 步:输入框

输入区从裸 `❯` 换成一个左竖线 + 上下横线的框。注意它是**右侧开口**的:

```ts
export function framedPrompt(planMode) {
  return chalk.dim("│ ") + (planMode ? chalk.yellow.bold("⏸ plan ❯ ") : chalk.cyan.bold("❯ "));
}
// REPL 里:打印上横线 → 框内提示符读一行 → 打印下横线
```

为什么右侧不封口?因为一个**完全闭合**的框,右边框要随你打字、随终端换行实时跟着移动——那得自己重写一套 raw 模式的行编辑器(处理每个字符、退格、光标、粘贴、历史)。右侧开口的框,对任意长度、任意换行都稳,代价只是少一条右边线。**先要稳,再要美**;闭合输入框留给愿意写行编辑器的那天。

## 为什么这么写

**为什么把渲染(`renderMenu`)和交互(`promptSelect`)拆开?** 因为交互那半截要真终端、要 raw 模式,没法单测;渲染那半截是「给选项和选中项、要一段字符串」,纯函数。拆开后,菜单长什么样能被几十个用例钉死,而难测的键盘循环只剩薄薄一层。这是全书反复用的招(Day 16/19/23/24):**把易测的纯逻辑从难测的副作用里剥出来。**

**那难测的键盘循环就不测了?** 测。靠**注入输入流**:`promptSelect(rl, options, input)` 的第三个参数默认是 `process.stdin`,测试时换成一个假的流(`isTTY=true`、`setRawMode` 空操作),然后手动 `emit("keypress", ...)` 喂按键。于是「下、下、回车 → 选中第 2 项」「上 → 绕到末项」「Esc → 取消」全能确定地验证,不需要真终端。一个默认参数,把不可测变成可测。

**为什么 Ctrl+C 在菜单里只是取消,而不是退出程序?** 因为此刻用户是在「要不要批准这一步」里,Ctrl+C 最合理的语义是「别批了」,不是「杀掉整个会话」。raw 模式正好给了我们这个区分能力——它把 Ctrl+C 变成普通按键,我们就能赋予它当下最合适的含义。

## 你会踩的坑

**坑 1:不暂停 readline 就抢 stdin。** 两个消费者同时读 stdin,按键会被 readline 和你的监听器各吃一半,菜单乱跳。先 `rl.pause()`,选完 `rl.resume()`。

**坑 2:忘了把终端模式还原。** 进了 raw 模式不退出,菜单结束后用户打字没有回显、回车没反应——终端「坏了」。`finish()` 里务必 `setRawMode(false)` + `rl.resume()`,而且要保证**任何**出口(回车、Esc、Ctrl+C、出错)都走 `finish()`。

**坑 3:Ctrl+C 当信号等。** raw 模式下 Ctrl+C 不触发 SIGINT,而是一个 `{ctrl:true,name:"c"}` 按键。指望 SIGINT 处理器接它,接不到。

**坑 4:「别再问」把硬 deny 也放行了。** 会话级预批准只能把 `ask` 升成 `allow`,`deny`(禁飞区)必须原样保留。混了,一句「bash 别问了」就能让 `rm -rf /` 直接跑——便利绝不能凌驾于安全红线。

## 小结

本章把审批从「打 y/N」换成「方向键选」:`menu.ts` 借用 stdin 进 raw 模式、监听按键、原地重绘、选完归还;中间选项复用 Day 4 的 allow 规则做「本会话别再问」,且对 `run_bash` 只升 ask、不碰 deny;非 TTY 自动回退打字;输入区加了个右侧开口的框。

`npm test` 289 例,新增 12 个:`renderMenu` 高亮、用假输入流验证「下下回车 / 上绕回 / Esc / Ctrl+C / 非 TTY」、以及「会话预批准升级 ask 但硬 deny 不动」。

它呼应了一条很朴素的产品原则:**让用户选,别让用户想。** 一个少一次思考、少一次打字的审批,看着小,日用百次就是实打实的顺手。

---

*本章对应 commit:`Day 29: arrow-key approval menu`(tag `day29`)*

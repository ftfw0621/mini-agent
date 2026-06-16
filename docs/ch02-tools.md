# Ch2 · 给 AI 一双手:工具系统

> 本章完整代码:`git checkout day2`。**今天的 `src/agent.ts` 不是新东西——它就是昨天那 50 行长大的**:同一套「调模型 → 跑工具 → 喂回结果」的循环原样保留,只是把工具从 1 个扩成 5 个、把工具实现抽进 `src/tools.ts`。(Day 1 那份单独的 `raw-loop.ts` 已退役、由 `agent.ts` 接棒;想回看最初骨架 `git checkout day1`。)

## 这一章做完,你会得到什么

昨天的 agent 只会跑命令。今天它能修代码了:

```
$ npm start

What should the AI do?
> 读 /tmp/demo/cart.js,这个脚本期望输出 40 但实际不对。找到 bug 修掉,然后用 node 运行验证。

🔧 read_file {"path": "/tmp/demo/cart.js"}
🔧 edit_file {"path": "/tmp/demo/cart.js", "old_string": "    sum += it.price - it.qty;", ...
🔧 run_bash {"command": "node /tmp/demo/cart.js"}

🤖 输出是 40,符合预期。
   Bug:第 5 行把「单价 × 数量」误写成了减法……修复:将 - 改为 *。
```

📷(此处放运行截图)

一条指令,它自己完成了「读文件 → 定位 bug → 精确修改 → 跑起来验证」四步。注意它修文件用的不是 sed、不是重写整个文件,而是一个叫 `edit_file` 的专用工具——这是今天的重点。

### 先认个门:今天的代码是昨天那份长大的,不是另起炉灶

新手最容易在这里迷糊:「昨天看的是 `raw-loop.ts`,今天怎么冒出个 `agent.ts`?」——它俩是**同一个东西**。把昨天的 `main()` 和今天的 `agent.ts` 并排看,骨架一模一样:

```
raw-loop.ts(Day1)                 agent.ts(Day2)
─────────────────────────────     ─────────────────────────────
new OpenAI({...})              →   new OpenAI({...})            原样
rl.question(...)               →   rl.question(...)            原样
for 轮次循环 {                  →   for 轮次循环 {              原样
  chat.completions.create        →   chat.completions.create    原样
  if 没有 tool_calls → 结束       →   if 没有 tool_calls → 结束   原样
  执行那 1 个工具                 →   dispatch 那 5 个工具        ← 唯一变化
}                                  }
```

变的只有两处:工具从 1 个变 5 个;工具的实现从内联挪进了 `src/tools.ts`(循环不该关心某个工具具体怎么跑)。**循环本身一行没动。** 这门课从今天起就是这个节奏——每天 `git diff` 上一天,你看到的永远是「同一份代码长出新能力」,而不是一堆互不相干的新文件。(所以昨天那份 `raw-loop.ts` 今天起删掉了:它的活已经由 `agent.ts` 接走,留着只会让人以为有两套循环。)

## 跟着写

今天给 agent 装五只手:

| 工具 | 干什么 | 替代了模型乱用的 |
|---|---|---|
| `read_file` | 读文件 | `cat` / `head` |
| `write_file` | 新建/整文件覆盖 | `echo >` |
| `edit_file` | 精确替换一小段 | `sed` / 整文件重写 |
| `search` | 按正则搜内容 | `grep` / `find` |
| `run_bash` | 真正需要执行的命令 | (保留,但管住边界) |

### 第 1 步:定义「工具」这个东西

新建 `src/tools.ts`。先回答一个问题:一个工具到底由什么组成?

```ts
// A tool = a manual for the model to read (definition) + code that does the work (run)
export interface Tool {
  definition: OpenAI.ChatCompletionTool;
  run: (args: Record<string, string>) => string;
}

// Errors are not exceptions — they are text that tells the model what to do next
const fail = (msg: string) => `[error] ${msg}`;
```

两个成员,对应工具的两个读者:`definition` 写给模型看,`run` 写给机器执行。新手最容易把全部心思花在 `run` 上——错了,**模型怎么用你的工具,完全取决于 definition 写得怎么样**,这件事重要到值得单独一章(Ch3)。

### 第 2 步:read_file 和一个看不见的集合

```ts
// The foundation of "read before edit": which files has this session actually read?
const readFiles = new Set<string>();

run: (args) => {
  const p = path.resolve(args.path);
  if (!fs.existsSync(p)) return fail(`File not found: ${p}. Check the path — you can locate files with search.`);
  const content = fs.readFileSync(p, "utf8");
  readFiles.add(p); // remember: this session has read this file
  if (content.length > READ_LIMIT) {
    return content.slice(0, READ_LIMIT) + `\n... (file is ${content.length} chars, truncated)`;
  }
  return content || "(empty file)";
},
```

`readFiles` 这个 Set 是今天最重要的一行状态。它记录「模型真实看过哪些文件」,马上就要用它来拦住一类大事故。

### 第 3 步:edit_file——五道检查,一行替换

修改文件不让模型重写整个文件,只让它提交一对 `{old_string, new_string}`:把这一段,换成那一段。`run` 里真正干活的只有最后一行,前面全是检查:

```ts
run: (args) => {
  const p = path.resolve(args.path);
  if (!fs.existsSync(p)) return fail(`File not found: ${p}`);
  if (!readFiles.has(p)) {
    return fail(`You have not read ${p} yet. Use read_file first and edit based on its real content.`);
  }
  if (args.old_string === args.new_string) return fail(`old_string and new_string are identical — nothing to change.`);
  const content = fs.readFileSync(p, "utf8");
  const count = content.split(args.old_string).length - 1;
  if (count === 0) {
    return fail(`old_string not found in the file. It must match exactly (including whitespace and indentation).`);
  }
  if (count > 1) {
    return fail(`old_string appears ${count} times — ambiguous. Include a few surrounding lines to make it unique.`);
  }
  // Note: content.replace(old, newStr) would expand $& $' etc. in newStr as special
  // replacement patterns — pass a function so the replacement is taken literally.
  fs.writeFileSync(p, content.replace(args.old_string, () => args.new_string), "utf8");
  return `Edited ${p}: 1 replacement made.`;
},
```

逐条看这五道检查在防什么:

1. **文件必须存在**——不解释。
2. **必须先读过**(`readFiles.has`)——这条最关键。不拦的话,模型会凭训练记忆「脑补」你的文件内容,然后基于一个不存在的版本做修改。结果就是把好代码改成垃圾。
3. **old 和 new 不能相同**——模型偶尔会发出无意义编辑,白烧一轮。
4. **old_string 必须找得到**——找不到说明模型记错了内容,逼它回去重读。
5. **old_string 必须唯一**——出现两次,改哪个?与其猜,不如报错让模型补上下文。

注意每条检查的返回文字:不是「操作被拒绝」,而是「Use read_file first」「Include a few surrounding lines」——**错误信息是写给模型看的操作指南**,它读完真的会照做(昨天的「错误喂回」原则,今天升级成了结构化版本)。

### 第 4 步:search、write_file、run_bash

`search` 用纯 Node 实现:递归遍历目录、逐行正则匹配,返回 `file:line: content`,最多 50 条。三个细节:跳过 `node_modules` 和 `.git`(不跳的话一次搜索能吐出几万行),跳过含 `\0` 字节的二进制文件,超过 1MB 的文件不读。

`write_file` 只多一道检查:覆盖**已存在**的文件也要先读过——和 edit 同一个道理。

`run_bash` 代码和昨天一样,但 description 变了——它现在要管住自己的边界,这个放 Ch3 讲。

### 第 5 步:注册表和统一分发

```ts
export const tools: Record<string, Tool> = {
  read_file: readFile, write_file: writeFile, edit_file: editFile, search, run_bash: runBash,
};
export const toolDefinitions = Object.values(tools).map((t) => t.definition);

// Single entry point: every failure becomes text fed back to the model.
// It never throws — the main loop must never die because of a tool.
export function dispatch(name: string, argsJson: string): string {
  const tool = tools[name];
  if (!tool) return fail(`Unknown tool: ${name}. Available tools: ${Object.keys(tools).join(", ")}`);
  let args: Record<string, string>;
  try { args = JSON.parse(argsJson); } catch { return fail(`Arguments are not valid JSON: ...`); }
  try { return tool.run(args).slice(0, /* cap */); } catch (err) { return fail(`Tool crashed: ${(err as Error).message}`); }
}
```

`dispatch` 的签名值得记住:**进去的是模型给的原始字符串,出来的永远是一段文字,永远不抛异常**。模型可能给你不存在的工具名、烂 JSON、能让 `run` 崩掉的参数——全部接住,变成错误文字喂回去。主循环(`agent.ts`)因此瘦得只剩 45 行:调模型、调 dispatch、塞结果,其他什么都不用管。

## 为什么这么写

**为什么不让模型重写整个文件?** 因为它会「顺手」改坏不该改的地方:重写 100 行的文件,它可能悄悄把第 73 行你写的注释「优化」掉。`{old_string, new_string}` 把改动范围钉死在一小段里,改了什么一目了然。Claude Code 的 Edit 工具就是这个设计,要求 old_string 带 2-4 行上下文保证唯一。

**为什么 readFiles 用「会话级 Set」而不是数据库?** 因为它要回答的问题就是会话级的:「这次对话里,模型见过这个文件的真实内容吗?」进程退出就该清零——下次会话文件可能已经变了。

**为什么 dispatch 永不抛异常?** 这是 Claude Code 主循环的铁律:工具可以失败,循环本身永远不挂。工具失败是常态(概率系统的常态),每一种失败都应该变成模型可以读、可以纠正的信息,而不是进程崩溃。

## 你会踩的坑

**坑 1:`String.replace` 的 `$` 陷阱。** `content.replace(old, newStr)` 里,`newStr` 如果含 `$&`、`$'`、`$1`,JS 会把它们当成特殊替换符展开——模型修改一段含 `$&` 的正则代码时,文件会被悄悄改坏,而且很难发现。解法:第二个参数传函数 `() => newStr`,函数返回值不做任何展开。这是 JS 老兵都未必知道的角落,写进单测里。

**坑 2:看不见的字符。** 写本章代码时真实踩过:示例里的 `"\0"`(转义写法,两个字符)在复制粘贴中变成了一个**真正的 NUL 字节**,文件从此被 git 和 grep 当成二进制,各种工具集体罢工,排查了好一阵。教训:代码里出现「看起来一样但行为不对」的情况,先 `od -c` 看字节。

**坑 3:search 不设跳过名单。** 忘了跳过 `node_modules`,第一次搜索直接返回上万行,一轮就把上下文塞爆。先有跳过名单和条数上限,再谈搜索质量。

**坑 4:工具结果上限一刀切。** read_file 给 16000 字符,其他工具 4000——读文件天生需要更大的窗口,搜索结果给位置就够(要看内容让模型再调 read_file)。不同工具配不同上限,这是 Day 5 上下文管理的伏笔。

## 小结

今天五只手、一个注册表、一个永不崩溃的 dispatch,外加两条硬规矩:**编辑前必须先读,old_string 必须唯一**。

但代码只是一半。你可能注意到了,每个工具的 description 都有五六行,里面全是「NEVER run cat via run_bash」「On error: ...」这种话——这些字不是注释,是写给模型的行为约束,而且实测有效:验收时模型乖乖用 `search` 而没有跑去 `grep`。

下一章(Ch3)不写一行新代码,专门讲这件事:**为什么工具说明书比工具本身重要**。

---

*本章对应 commit:`Day 2: the five core tools`(tag `day2`)*

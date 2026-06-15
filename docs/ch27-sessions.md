# Ch27 · 续上次的活:/resume 会话选择器

> 本章完整代码:`git checkout day27`。给 `session.ts` 加列举与读取,REPL 加一个 `/resume` 选择器。

## 这一章做完,你会得到什么

Day 12 已经把每次对话存成了快照,`-r` 能续**最近**那一个。但真实用起来,你想续的常常不是最近那个——是「昨天那个重构」。这一章让你**看着选**:

```
> /resume
recent sessions in this project:
  1. 2026-06-15 10:30 · 16 msg · 把 config 的加载逻辑拆成单独模块
  2. 2026-06-15 09:12 · 4 msg · 解释一下 loop.ts 的重试
  3. 2026-06-14 18:40 · 22 msg · 给购物车加优惠券功能
  resume which? [number, or Enter to cancel] 1

(resumed 2026-06-15T10-30… — 16 messages; files must be re-read before editing)
```

每个会话用**第一句话**当标题,加上时间和轮数——一眼就认出哪个是哪个。这是「能跨天用」和「玩具」之间,很实在的一道坎。

## 跟着写

### 第 1 步:让会话能被「列出来」,而不只是「读最近一个」

Day 12 的 `latestSession()` 只回最近一个。要做选择器,得能列举。先把「按时间倒序拿到所有会话文件」这步抽出来共用:

```ts
function sessionFilesNewestFirst(): { f: string; mtime: number }[] {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))                                  // 忽略 .tmp 和杂物
    .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);                                // 最新在前
}
```

`latestSession`、`listSessions`、`prune` 现在都建在它上面——一处排序逻辑,三处复用,顺手把 Day 12 里重复的那几段也收敛了。

### 第 2 步:一个会话只用一行就能认出来

列表要有用,每行得让人**认得出**。光有 id(一串时间戳)和轮数不够,得有内容。内容从哪来?**用户说的第一句话**——它几乎总是这次对话的主题:

```ts
export function sessionTitle(messages): string {
  const firstUser = messages.find(m => m.role === "user");
  let text = typeof firstUser?.content === "string" ? firstUser.content : "";
  text = text.split("\n\n[Referenced files")[0];   // 去掉 Day 26 @file 附进去的那一坨
  return text.replace(/\s+/g, " ").trim() || "(no prompt)";
}
```

两个细节:**剥掉 @file 附件**——Day 26 会把引用的文件内容拼在用户那句话后面,标题里不该出现整个文件;**压成一行**——多行输入拍平成一行,列表才整齐。这是个纯函数,所以能被一堆边界用例钉死(有附件的、多行的、没有用户消息的)。

### 第 3 步:列举成「摘要」

`listSessions` 把每个会话读成一个**摘要**——够人挑、又不用把整段对话载进来:

```ts
export function listSessions(limit = 10): SessionSummary[] {
  const out = [];
  for (const { f } of sessionFilesNewestFirst()) {
    if (out.length >= limit) break;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), "utf8"));
      out.push({ id: s.id, savedAt: s.savedAt, model: s.model,
                 messageCount: s.messages.length, title: sessionTitle(s.messages) });
    } catch { /* 跳过损坏的文件,绝不因为一个坏文件让列表崩掉 */ }
  }
  return out;
}
```

一个坏掉的会话文件,只是被跳过,不会让整个 `/resume` 炸掉——和 Day 12「损坏的快照不该让 CLI 崩,当它不存在就好」一个态度。

### 第 4 步:在 REPL 里挑一个,换过去

`/resume` 列出来、读一个数字、把当前对话**整体换成**选中的那个:

```ts
case "/resume": {
  const sessions = listSessions(10);
  if (!sessions.length) { console.log("(no saved sessions yet)"); return true; }
  sessions.forEach((s, i) => console.log(`  ${i + 1}. ${when(s)} · ${s.messageCount} msg · ${s.title.slice(0, 60)}`));
  const answer = (await readUserLine("  resume which? [number, or Enter to cancel] ")).trim();
  const idx = Number(answer) - 1;
  if (!answer || !Number.isInteger(idx) || idx < 0 || idx >= sessions.length) { console.log("(cancelled)"); return true; }

  const chosen = loadSession(sessions[idx].id);
  messages = [{ role: "system", content: systemMessage }, ...chosen.messages]; // 新宪法 + 存下的对话
  sessionId = chosen.id;        // 之后接着存进这个会话的文件
  forgetFilesExcept([]);        // 续上的对话,编辑前必须重新读文件
  clearUndo();                  // 上一个会话的写入,不归我们撤
  return true;
}
```

三件事必须一起做,缺一不可:**重建消息**(新鲜的 system 宪法 + 存下的对话——宪法要重建,因为 AGENT.md 可能变了,这是 Day 12 定的);**换 sessionId**(让后续保存继续追加到这个会话);**重置会话级状态**——「读过哪些文件」(Day 6)和「撤销栈」(Day 22)都属于上一段对话,得清掉,否则续上的会话会以为自己读过其实没读的文件、或能撤销别人的写入。

### 第 5 步:一个让它可测的小改动

有个不起眼但关键的改动:Day 12 里会话目录是个模块加载时就算好的常量 `const SESSIONS_DIR = path.resolve(...)`。这一章把它改成**惰性求值**的函数 `sessionsDir()`:

```ts
const sessionsDir = () => path.resolve(".mini-agent", "sessions");   // 每次调用按当前 cwd 算
```

为什么?因为常量在 import 那一刻就把路径钉死在「当时的工作目录」了,测试没法换地方。改成函数,每次调用按**当下**的 cwd 算——测试就能 `chdir` 到一个临时目录,存几个会话、列出来、读回来,验证完删掉,绝不脏到你的仓库。让代码可测,有时只是「把算得太早的东西,算得晚一点」。

## 为什么这么写

**为什么用第一句话当标题,而不是让用户起名?** 因为没人会给临时对话起名。强制起名,要么拖慢每次开场,要么得到一堆「test」「asdf」。用户说的第一句话是**免费的、且几乎总是准的**主题——它就是这次对话要干嘛。零成本,够用。

**为什么 `/resume` 要重置「读过的文件」和「撤销栈」?** 因为这两样是**当前这段对话**的状态,不是那段被续上的对话的。不清,你续上一个三天前的会话,系统却以为你刚读过某个文件(其实没有)、或者 `/undo` 能撤销三天前的写入——状态串台,比没有这功能更危险。换对话,就得换齐它的全套会话级状态。

**为什么把目录改成惰性求值,而不是给测试开个后门?** 比如加个「测试专用的设置目录」参数。因为那种后门是只为测试存在的生产代码,是污染。而「按当前 cwd 算路径」本来就更正确——它让 mini-agent 在哪个目录跑,就用哪个目录的会话(本来 Day 12 就该如此)。可测性是这个正确性顺带的好处,不是它的目的。**好的可测性,往往是把代码改对了,而不是给它开洞。**

## 你会踩的坑

**坑 1:续会话时忘了重建 system 宪法。** 直接 `messages = chosen.messages` 会把存档里**没有** system 消息这件事暴露出来(Day 12 故意不存 system)——模型一上来没有宪法。必须 `[{system}, ...chosen.messages]`,而且是**新鲜**的宪法(AGENT.md 可能改了)。

**坑 2:续会话不清会话级状态。** 不重置「读过的文件」和撤销栈,续上的对话就带着上一段的幻觉:以为读过没读的文件、能撤销不属于它的写入。换对话 = 换全套状态。

**坑 3:标题里混进了 @file 的整个文件。** Day 26 把引用文件拼在用户消息后面,不剥掉,标题就成了「解释 @loop.ts ——(后面跟着 loop.ts 全文)」。`split("\n\n[Referenced files")[0]` 把附件切掉。

**坑 4:一个坏文件让整个列表崩。** `JSON.parse` 一个损坏的会话文件会抛异常。不 try/catch 包住,一个坏文件就让 `/resume` 整个不可用。逐个读、逐个兜,坏的跳过。

## 小结

本章把「会话」从「只能续最近一个」变成「列出来挑一个续」:`session.ts` 加了 `listSessions`(摘要)、`loadSession`(按 id 读)、`sessionTitle`(拿第一句话当标题),REPL 的 `/resume` 列表 + 选号 + 整体切换,顺带把会话目录改成惰性求值让它可测。

`npm test` 256 例,新增 12 个:标题的四种情况(首句/剥附件/压行/无消息)、存读列举的往返、缺失返回 null、最新优先。

它补上了「跨天用」这块拼图:Day 12 让会话**存得下**,这一章让它**找得回、续得上**。CLI 离「能当日常工具用」,又近了一步。

---

*本章对应 commit:`Day 27: /resume session picker`(tag `day27`)*

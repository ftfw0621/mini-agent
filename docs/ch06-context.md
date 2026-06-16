# Ch6 · AI 的失忆症,和怎么让它忘得体面

> 本章完整代码:`git checkout day5`。新增 `src/context.ts`,`tools.ts` 的已读文件集合升级为带顺序的 Map,`loop.ts` 接入两条压缩路径。

## 这一章做完,你会得到什么

对话历史顶到上限时,agent 不再死掉,而是当着你的面「整理记忆」,然后接着干活:

```
🔧 read_file {"path": "/tmp/demo/cart.js"}
🔧 read_file {"path": "/tmp/demo/filler.txt"}
📦 compacting context (~8433 tokens)...
📦 compacted: ~8433 → ~1526 tokens
🔧 edit_file {"path": "/tmp/demo/cart.js", "old_string": "    sum += it.price - it.qty;", ...
🔧 run_bash {"command": "node /tmp/demo/cart.js"}

🤖 The fix works — output is 40 as expected.
   Files read: cart.js, filler.txt / Files edited: cart.js ...
```


注意两个细节:压缩发生在第二次读文件**之后**、修 bug **之前**——也就是说,`edit_file` 改的是一个**压缩前**读过的文件,而且 old_string 一字不差。历史被砍掉了 80%,它却没有失忆。这就是今天要做的两件事:**压缩**(忘掉对话),**恢复**(不忘文件)。

## 跟着写

### 第 1 步:先学会数 token(估算,不是精确计数)

```ts
export function estimateTokens(text: string, dense = false): number {
  const bytes = Buffer.byteLength(text, "utf8"); // Chinese/emoji take multiple bytes
  return Math.ceil(bytes / (dense ? 2 : 4)); // JSON-ish ~2 bytes/token, prose/code ~4 — round UP
}
```

三个决定都有讲究:

- **数字节不数字符**:一个汉字 3 字节、一个 emoji 4 字节,按字符数估会严重偏小。
- **JSON 用 2,普通文本用 4**:JSON 里全是 `{}[],":` 这种单字符 token,密度是普通代码的两倍。工具结果(`role: "tool"`)按 JSON 算。
- **永远向上取整、往多估**:估算是**安全机制不是优化机制**。估多了,代价是提前压缩一次(轻微浪费);估少了,代价是整个请求被 API 拒绝(任务失败)。两边代价不对等,所以永远往安全的方向偏。

### 第 2 步:触发线——别等 API 报错才动手

```ts
// 1,048,565 came from a real API error message, not from documentation.
export const CONTEXT_WINDOW = Number(process.env.MINI_AGENT_CONTEXT_WINDOW || 1_048_565);
export const COMPACT_AT = Number(process.env.MINI_AGENT_COMPACT_AT || Math.floor(CONTEXT_WINDOW * 0.8));
```

那个奇怪的数字 1,048,565 是 Day 3 测试时 API 真实报错里抄来的——我们原以为 DeepSeek 窗口是 64K,实际是约 1M,差了 16 倍。这是上一章埋的悬念,也是一条值得单独记住的工程纪律:**模型参数以 API 真实行为为准,不要信记忆和二手资料**(包括本教程——你跑的时候它可能又变了,所以代码里留了环境变量可以改)。

触发线设在窗口的 80%,而不是 100%:估算有误差、压缩产生的摘要本身要占空间、压缩这个动作也要调一次模型。**软触发线必须明显低于硬上限**——等 API 报 too long 才动手,失败已经发生了。

### 第 3 步:压缩——6 段结构化摘要 + 双保险禁工具

压缩不是「把对话概括一下」。我们的摘要 prompt 强制 6 个编号段落,**每一段对应一种丢了它就会发生的真实事故**:

| 段 | 丢了会怎样 |
|---|---|
| 1. Primary request and intent | 干着干着忘了用户最初要什么,跑偏 |
| 2. Key technical context | 忘了技术约束,换用错误的工具链 |
| 3. Files read or edited | 不知道自己改过哪些文件 |
| 4. Errors and fixes | **重复踩同一个坑**:第 30 轮试过方案 A 失败,压缩丢了这条,第 80 轮又信心满满推方案 A |
| 5. Current state | 不知道刚干到哪,重做或漏做 |
| 6. Next step | 压缩后第一步走错方向 |

还有一个不起眼但要命的细节——压缩这次调用**绝不能让模型调工具**(它正在总结,一调工具这轮就废了)。两层保险:

```ts
const res = await client.chat.completions.create({
  model,
  messages: [...messages, { role: "user", content: SUMMARY_PROMPT }],
  // Deliberately NO `tools` parameter — the hard guarantee.
  // The CRITICAL lines in the prompt are the soft second layer.
}, { signal });
```

硬保险:请求里**根本不传 `tools` 参数**,API 层面就不可能接受工具调用。软保险:prompt 开头结尾各写一遍大写的 `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.`。为什么要双保险?Anthropic 实测过:即使明确要求只输出文本,模型在压缩任务里仍有约 **2.79%** 的概率去调工具。冗余在这里是 feature。

### 第 4 步:文件恢复——压缩可以忘对话,不能忘文件

```ts
export function recoverFileState(): string | null {
  const candidates = recentFiles(RECOVER_MAX_FILES); // most recently touched, top 5
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue; // the file may have been deleted — trust the disk
    const content = fs.readFileSync(p, "utf8").slice(0, RECOVER_FILE_CHARS); // fresh from disk
    // ... budget checks ...
  }
  forgetFilesExcept(recovered); // files NOT recovered must be re-read before any future edit
  // ...
}
```

四个设计点:

1. **挑哪些文件恢复?最近碰过的前 5 个。** 时间顺序是简单、有效、可解释的猜测:最近读的最可能是下一步要操作的。为此 `readFiles` 从 Set 升级成 Map,记录每个文件的触碰顺序。
2. **内容从磁盘重读,不用记忆里的版本。** 压缩这一刻,文件可能已经被别的进程(你自己、格式化工具、git)改了。**永远相信磁盘,不相信缓存**——缓存与真实数据不一致,是这类系统最大的 bug 来源之一。
3. **预算封顶**:单文件 4000 字符、总共 16000。恢复是为了「接上手」,不是把所有内容搬回来。
4. **没被恢复的文件,从 readFiles 里踢出去。** 这条最隐蔽:某文件压缩前读过、但没挤进恢复名单——它的内容已经不在对话里了,如果还保留「已读」资格,模型会基于一段**它已经看不见的内容**去编辑文件。踢出去,逼它编辑前重新 read_file。

### 第 5 步:接进循环——主动 + 被动两条路

```ts
// Proactive: act BEFORE the API rejects us
if (estimateHistoryTokens(messages) > COMPACT_AT) { ... await tryCompact(...) }

// Reactive: the API just told us we're too big — our estimate was wrong
if (e.kind === ApiErrorKind.ContextTooLong) {
  if (compaction.count < MAX_COMPACTIONS_PER_QUERY && (await tryCompact(...)))
    continue; // history is smaller now — retry the same round
}
```

主动路径每轮调用前检查估算值;被动路径兜住估算失误(API 报 too long 时压缩后原地重试,而不是直接放弃)。两条路共享一个记分牌:单次查询最多压缩 4 次(还不够说明任务本身太大),连续失败 3 次熔断(Day 3 的老朋友——**任何自动行为都要有保险丝**,没有它的真实代价是单会话连续失败 3272 次)。

## 为什么这么写

**为什么压缩用同一个模型,不找个便宜的?** 可以找,Claude Code 的部分压缩任务确实用更便宜的模型。但 V1 先别做——换模型涉及「换模型要不要清 thinking、缓存怎么办」一堆新问题。先跑通,优化留给有数据之后。

**为什么我们只做了一级压缩?** Claude Code 入模型前有 8 阶段流水线:砍旧消息 → 微压缩 → 折叠 → 全量重写……从轻到重,能用便宜手段绝不用贵的。我们 V1 直接做了最重的一级(全量重写成摘要),因为它一个机制就能兜住所有情况——分级优化等你有了真实使用数据再加,顺序不能反。

**和缓存的关系。** DeepSeek 的上下文缓存是自动的:请求的前缀和上次相同就命中,命中部分价格约打一折。我们的历史是 append-only(只往后加消息),前缀天然稳定,每一轮都在吃缓存折扣。而压缩会把整个历史换掉——**必然击穿一次缓存**。这是笔划算的账:击穿一次的代价,换之后每轮少发 80% 的内容。但它也解释了为什么触发线不能太低:频繁压缩 = 频繁击穿,反而比不压缩更贵。

## 你会踩的坑

**坑 1:同一毫秒的时间戳。** 第一版用 `Date.now()` 记文件触碰顺序,单测立刻翻车:连续三次读文件发生在同一毫秒,时间戳全相同,排序退化成随机。换成单调递增的计数器(`++touchCounter`)。教训:**给「先后顺序」排序,用计数器,别用墙钟**——时钟的分辨率和回拨都会坑你。

**坑 2:估算系数抄作业不验证。** 4 字节/token 是英文代码的经验值,中文文本 3 字节才出 1 个 token 左右,纯中文场景按 4 估会偏小约一半。我们的单测里专门有一条 CJK 用例。你的场景如果以中文为主,把系数调到 3 甚至 2.5,记住原则:宁可估多。

**坑 3:压缩后忘了清理 readFiles。** 上面第 4 步讲过的幻影编辑问题。这类 bug 上线后表现为「偶尔把文件改坏」,极难复现——因为只在「压缩发生 + 该文件没被恢复 + 模型恰好要编辑它」三个条件同时成立时出现。防御性的一行 `forgetFilesExcept(recovered)`,值一次生产事故。

**坑 4:把窗口当成「越大越不用管」。** DeepSeek 给了 1M 窗口,看起来永远用不完?长对话的问题不只是放不放得下:历史越长,每轮的输入费用越高(没命中缓存的部分),模型对中段内容的注意力也越稀。压缩的价值在 1M 窗口下依然成立,只是触发得更晚。

## 小结

今天两个机制:**压缩**(6 段结构化摘要,双保险禁工具,主动+被动两条触发路径,熔断兜底)和**恢复**(最近 5 个文件,从磁盘重读,没恢复的清出已读集合)。核心原则一句话:**压缩可以忘掉对话,但不能忘掉正在干的活**。

验收里那个瞬间值得回味:历史被砍掉 82%,模型转头就精确编辑了压缩前读过的文件——失忆和失能之间,隔着的就是这套恢复机制。

明天(Ch7)做体验层:system prompt(数字锚、反面禁令、防虚报)、AGENT.md 项目记忆、流式输出和像样的终端 UI——让它从「能用」变成「想用」。

---

*本章对应 commit:`Day 5: context compaction and file recovery`(tag `day5`)*

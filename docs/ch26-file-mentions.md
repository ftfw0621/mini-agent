# Ch26 · 用 @ 把文件拽进对话:@file 引用

> 本章完整代码:`git checkout day26`。新增 `src/mentions.ts`,接进 REPL 读到用户输入之后那一步。

## 这一章做完,你会得到什么

不用再让模型「先 read_file 再回答」——你在提问里直接 `@` 一个文件,它的内容就跟着问题一起递进去了:

```
> 解释一下 @src/loop.ts 里的重试逻辑
(attached 1 file: src/loop.ts)

🤖 loop.ts 的重试是这样的:外层 for 是 round……
```

模型一上来就看到了文件内容,省掉一个工具往返。但有一条线绝不能松:`@.env` 这种密钥文件,**拒绝**,不读:

```
> 把 @.env 里的 key 填进配置
(refused secret file: .env)
🤖 我不能读取 .env(密钥文件)。如果需要某个值,请你直接告诉我变量名……
```

## 跟着写

### 第 1 步:从一行输入里把 @提及 抠出来

`@` 触发,但不能见 `@` 就抓——邮箱 `bob@example.com` 里的 `@` 不算,npm 包名 `@scope/pkg` 写在句子中间也不算。规则:`@` 必须在**行首或空白之后**:

```ts
const MENTION_RE = /(?:^|\s)@(\S+)/g;   // @ 前面是开头或空格,后面跟非空白路径

export function findMentions(line: string): string[] {
  const out = [];
  for (const m of line.matchAll(MENTION_RE)) {
    const raw = m[1].replace(/[.,;:!?)\]]+$/, ""); // 去掉句尾标点(@cart.js. → cart.js),但保留中间的点
    if (raw) out.push(raw);
  }
  return out;
}
```

那个 `replace` 是个小而真实的坑:用户写「看看 @cart.js。」结尾带个句号,不去掉,路径就成了 `cart.js。`,文件找不到。但又不能把 `cart.js` 中间的点也去了。所以只剥**结尾**的标点,留住扩展名的点。

### 第 2 步:每个提及都过一遍 read_file 的权限闸门

这是整章的安全核心。`@file` 是便利功能,但便利**不能破防**——`.env`、`*.pem` 这些密钥文件,Day 4 早就定下「内容绝不进上下文」。所以解析每个提及时,先问权限闸门:这个文件,read_file 准不准读?

```ts
function resolveMention(raw: string): Mention {
  const abs = path.resolve(raw);
  // 复用 read_file 的判断:密钥文件会被判 deny
  if (checkPermission("read_file", JSON.stringify({ path: raw })).decision === "deny") {
    return { raw, path: abs, status: "denied" };   // 拒绝,绝不读
  }
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return { raw, path: abs, status: "dir" };     // 目录不是文件
    let content = fs.readFileSync(abs, "utf8");
    if (content.length > MAX_MENTION_BYTES) content = content.slice(0, MAX_MENTION_BYTES) + "\n... (truncated)";
    return { raw, path: abs, status: "ok", content };
  } catch {
    return { raw, path: abs, status: "missing" };   // 文件不存在 → 多半根本不是引用
  }
}
```

**关键是没有自己另写一套密钥判断**。`@file` 和 read_file 共用同一个 `checkPermission`——以后密钥规则改了、加了新的禁读文件,两条路径自动一起更新。Day 4「一个权限闸门」、Day 15「外部工具同一闸门」、Day 20「计划模式同一闸门」,到这里又收一次红利:**新入口复用旧判断,安全不打折**。

### 第 3 步:把读到的文件拼进消息

解析完,把能读的拼成块附在用户那句话后面,被拒的明说,找不到的(多半不是引用)悄悄忽略:

```ts
export function expandMentions(line: string): { augmented: string; mentions: Mention[] } {
  const mentions = findMentions(line).map(resolveMention);
  const attach = mentions.filter(m => m.status === "ok" || m.status === "denied"); // 读到的 + 拒绝的
  if (!attach.length) return { augmented: line, mentions };                        // 没有可附的 → 原样返回

  const blocks = attach.map(m => m.status === "ok"
    ? `--- ${m.raw} ---\n${m.content}`
    : `--- ${m.raw} (refused: secret file, not included) ---`);
  return { augmented: `${line}\n\n[Referenced files]\n${blocks.join("\n\n")}`, mentions };
}
```

两个分寸:**被拒的也写进消息**(让模型知道用户想引但被挡了,免得它以为用户没提供),但**只写「被拒」三个字,绝不写内容**;**找不到的静默丢弃**——一句话里随便一个 `@` 不该让 agent 唠叨「找不到文件」,它可能压根不是文件引用。

### 第 4 步:接到 REPL 读到输入之后

在用户那句话进入历史之前,先展开:

```ts
const { augmented, mentions } = expandMentions(line);
const attached = mentions.filter(m => m.status === "ok").map(m => m.raw);
const refused = mentions.filter(m => m.status === "denied").map(m => m.raw);
if (attached.length) console.log(`(attached ${attached.length} files: ${attached.join(", ")})`);
if (refused.length)  console.log(`(refused secret files: ${refused.join(", ")})`);
messages.push({ role: "user", content: augmented });   // 进历史的是展开后的版本
```

注意它处理的是 slash 命令**之后**、入历史**之前**那一步——`/help` 这类命令早被拦走了,到这儿的一定是真要发给模型的话。展开是一次纯粹的输入预处理,不碰循环、不碰工具。

## 为什么这么写

**为什么走权限闸门,而不是直接 `fs.readFileSync`?** 因为「能不能把这个文件给模型看」这个判断,系统里只该有一处。`@file` 图省事直接读,就等于在闸门旁边偷开一道后门——哪天密钥规则更新了,read_file 挡得住、`@file` 漏得过。复用 `checkPermission`,是让便利功能**继承**而不是**绕过**安全。这条线,全书一以贯之:入口可以多,判断只有一个。

**为什么找不到的提及要静默?** 因为误报比漏报烦人。一句话里的 `@` 可能是邮箱、是 git handle、是随口一个符号。要是每个解析不出文件的 `@token` 都报一句「找不到」,用户每次打字带 `@` 都被打扰。真正是文件引用的,文件就在那儿、读得到;读不到的,大概率本来就不是引用——放过它。

**为什么被拒绝的要出声,找不到的却不出声?** 因为它俩的含义不同。`@.env` 被拒,是**安全事件**——用户明确想引一个文件,系统挡了,得让双方都知道(用户知道为什么没生效,模型知道别去猜那个文件的内容)。而 `@随便什么` 找不到,只是**没匹配上**,不是被拦,没什么可通报的。出不出声,看的是「这是一次拒绝,还是一次没命中」。

## 你会踩的坑

**坑 1:见 `@` 就抓。** 不加「行首或空白之后」的限制,邮箱、`@scope/pkg`、装饰器 `@override` 全被当成文件引用。`(?:^|\s)@` 这个前缀约束不能省。

**坑 2:句尾标点吃进路径。** 「看 @cart.js。」「改 @a.ts,然后……」——结尾的句号、逗号粘在路径上,文件就找不到。剥结尾标点,但别碰扩展名的点。

**坑 3:`@file` 绕过密钥保护。** 这是最危险的坑。要是 `@file` 自己 `readFileSync`,`@.env`、`@id_rsa` 的内容就直接进了上下文、进了之后每一次 API 请求——Day 4 守了半天的线,被一个便利功能捅穿。必须走 `checkPermission`。

**坑 4:把密钥文件的「被拒」连内容一起写出来。** 拒绝信息只能说「这是密钥文件,没包含」,绝不能手滑把读到的内容也附上。其实正确写法压根不读(`status: "denied"` 分支里没有 `content`),内容根本无从泄漏——拒绝要在**读之前**,不是读完再删。

## 小结

本章加了 `@file` 引用:用户在提问里 `@` 一个文件,内容就被附进消息,省掉一次 read_file 往返。解析上认行首/空白后的 `@`、剥句尾标点;安全上每个提及都过 read_file 的权限闸门,密钥文件拒绝不读;呈现上读到的附上、被拒的出声、没命中的静默。

`npm test` 244 例,新增 17 个:提及解析(邮箱不算、句尾标点剥离)、真实文件附入、`.env` 被拒且内容不泄漏、目录与缺失的处理。

它是又一次「新入口复用旧判断」:`@file` 给了便利,但「什么能进上下文」的裁决权,仍然牢牢攥在 Day 4 那一个权限闸门手里——**便利长出去,安全不松手**。

---

*本章对应 commit:`Day 26: @file mentions`(tag `day26`)*

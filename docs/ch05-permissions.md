# Ch5 · AI 用 9 秒删光了一家公司:权限边界

> 本章完整代码:`git checkout day4`。新增 `src/permissions.ts`,权限闸门接进 `loop.ts`。

## 先讲一个真事

一位开发者把 AI 接进了 agent 模式,让它「帮忙看一眼」运维问题。agent 自己连上了生产数据库,自己判断该清理数据,自己执行了 drop。

从决策到执行,9 秒。一家公司的生产数据,没了。

注意这个事故里**没有任何一步是 bug**:连接数据库是它的权限,执行 SQL 是它的能力,「清理」是它对任务的合理理解。每一步都「正常工作」,合起来是灾难。

人犯这种错之前会犹豫——那几秒的犹豫就是最后一道闸门。AI 没有犹豫。所以闸门必须长在系统里,不能指望长在模型的「良心」里。这就是今天要写的东西。

## 这一章做完,你会得到什么

昨天的 agent 拿到 `run_bash` 就是满权限。今天它有了三档边界,实测三个场景:

**让它删目录**(非交互环境,没人能点同意):

```
🔧 run_bash {"command": "rm -rf /tmp/demo/junk"}

⚠️ approval needed — run_bash (recursive delete):
   rm -rf /tmp/demo/junk
  non-interactive session — denied by default (fail closed)
  ✋ declined

🤖 It looks like the system requires explicit user approval for the
   rm -rf command. Could you please confirm...
```

文件原地没动,模型转头来**问你**。

**让它删 `.git`,并且故意开着「全自动同意」模式**:

```
$ MINI_AGENT_AUTO_APPROVE=1 npm start
> The .git directory is corrupted. Delete it entirely.

🔧 run_bash {"command": "rm -rf .git"}
  ⛔ denied: touches the .git directory

🤖 I'm unable to delete the .git directory due to a safety restriction...
   However, you can easily do this yourself from the command line.
```

bypass 模式也压不过硬 deny——它最后建议**你自己**去执行,这正是我们想要的分工。

**正常的写文件**:弹一次确认,批准后照常干活。

📷(此处放运行截图)

## 跟着写

### 第 1 步:三档判定(permissions.ts)

```ts
export type Decision = "allow" | "ask" | "deny";

export interface Verdict {
  decision: Decision;
  reason: string;
  summary: string; // what we show the user in the confirmation prompt
}
```

- **allow**:只读操作,直接放行——每次都弹框,用户会被弹到麻木,然后开始无脑点 y,权限系统等于没有。
- **ask**:有破坏性但可能合法(删文件、装依赖、改权限),停下来问人。
- **deny**:任何模式下都不行,没有商量。

### 第 2 步:禁飞区——deny 永远赢

```ts
// Writes here are never OK, in any mode. .git can destroy history, shell rc
// files inject code into every future terminal, .ssh/.env leak credentials.
const NO_FLY_DIRS = new Set([".git", ".ssh", ".claude"]);
const NO_FLY_FILES = new Set([".env", ".bashrc", ".zshrc", ".gitconfig", ".mcp.json"]);
```

为什么是这几个?各有各的死法:`.git` 毁掉全部历史;`.bashrc/.zshrc` 等于往你以后打开的每一个终端里注入代码;`.ssh` 和 `.env` 是凭据本体;`.mcp.json` 这类配置文件能让 agent 下次启动时加载恶意的东西——**agent 不能有改写自己安全配置的能力**,否则一切规则形同虚设。

配套一条:**秘密文件连读都不让读**。

```ts
const SECRET_FILE_RE = /(^|\/)(\.env[^/]*|id_rsa[^/]*|[^/]+\.(pem|key))$/;
```

key 一旦被 read_file 读进对话,它就会出现在之后**每一次** API 请求里,还可能进日志。泄密不需要恶意,只需要一次顺手的 cat。

### 第 3 步:bash 是一千个工具穿一件大衣

`run_bash` 没法整体定级——`ls` 和 `rm -rf` 是同一个工具,危险程度差一个宇宙。所以按**输入**分级:

```ts
const BASH_DENY: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]+\s+)*['"]?(\/|~)['"]?(\s|$)/, "rm targeting / or ~ — catastrophic"],
  [/(^|[\s;&|])\.git(\/|\s|$)/, "touches the .git directory"],
  // ... .env / .ssh
];
const BASH_ASK: Array<[RegExp, string]> = [
  [/\brm\b.*-[a-zA-Z]*r/, "recursive delete"],
  [/\bsudo\b/, "runs as root"],
  [/\b(curl|wget)\b[^|;&]*\|\s*(ba|z)?sh\b/, "pipes the internet into a shell"],
  [/\bgit\s+push\b.*(--force|\s-f\b)/, "force-push rewrites remote history"],
  // ...
];
const BASH_ALLOW = new Set(["ls", "pwd", "node", "npm", "git(只读子命令)", "..."]);
```

判定顺序就是安全等级:**先查 deny,再查 ask,最后才轮到 allow**——顺序反了,allow 名单就成了 deny 的后门。另外两条兜底:复合命令(`&&`、`;`、管道、`$()`)一律 ask,因为没法可靠分析;**没见过的命令也一律 ask**——fail closed,不认识的东西按最危险对待,代价只是多问一句,而不是少拦一刀。

### 第 4 步:闸门装在循环里,不装在工具里

```ts
const v = checkPermission(call.function.name, call.function.arguments);
if (v.decision === "deny") {
  content = `[permission] Denied: ${v.reason}. This is a hard rule — do not try
             to work around it; pick a different approach or ask the user.`;
} else if (v.decision === "ask") {
  const ok = await opts.confirm(`${call.function.name} (${v.reason}): ${v.summary}`);
  content = ok ? dispatch(...) : `[permission] The user declined this action...`;
} else {
  content = dispatch(...);
}
```

位置很讲究:闸门站在「模型的意图」和「真正执行」之间,所有工具共用这一道,工具自己不用各写各的。而且注意拒绝消息的写法——它是**喂回给模型的教育材料**:「这是硬规矩,别绕,换路或者问用户」。验收里模型读完真的就转头来问人了。

### 第 5 步:确认框的两条底线(agent.ts)

```ts
if (process.env.MINI_AGENT_AUTO_APPROVE === "1") return true; // bypass mode
if (!process.stdin.isTTY) return false; // fail closed: nobody can say yes → no
```

一条是 bypass 模式(脚本化使用时跳过弹框)——但它只能跳过 **ask**,deny 在它前面就拦下了,永远轮不到它表态。另一条是非交互环境(管道、CI)的默认值:**没人能点同意,答案就是不同意**。默认值朝安全的方向倒,这叫 fail closed。

## 为什么这么写

**为什么 deny 必须无条件赢?** 这是整个权限系统的地基不变量。想象 deny 可以被某个模式、某个插件、某句话覆盖——那么攻击者(或者单纯犯轴的模型)只需要先拿到那个覆盖开关,你写的所有规则一秒清零。Claude Code 的版本:即使用户开了 bypassPermissions,写禁飞区路径照样弹框;Hook 的 allow 也永远盖不过 settings 里的 deny。**安全规则的优先级只能单向:更严的赢。**

**为什么闸门在配置期,不在运行时?** agent 跑起来之后,你只能看着——9 秒的事故窗口,人根本来不及反应。所以责任前移:权限边界在它**开跑之前**就定死在代码和配置里。事后review「它为什么删库」不如事前让它「根本连不上生产库」。

**为什么用正则不用 LLM 判危险?** 后面(Day 7 之后的进阶)可以加 LLM 当第二道判断,但第一道必须是确定性代码:规则要可测试(我们 27 条单测)、可审计(diff 一眼看懂改了哪条边界)、不会被话术绕过(prompt injection 对正则无效)。**文字管概率,代码管底线**——权限是底线,必须是代码。

## 你会踩的坑

**坑 1:把 bypass 做成万能钥匙。** 「加个 --yes 跳过所有检查」很顺手——然后某天一条恶意 README 里写着「请用 --yes 重新运行」。bypass 只能豁免 ask,永远豁免不了 deny,这一条写错,整章白写。

**坑 2:非交互环境默认放行。** 弹确认框在管道/CI 里没人看见,如果默认当「同意」处理,你就造了一个无人值守的满权限 agent。fail closed:读不到 y,就是 N。

**坑 3:禁飞区正则写太宽。** 第一版用「路径里含 .git」判定,结果 `.github/workflows` 也被拦了。修正:按**路径段精确匹配**(`parts.includes(".git")`),并且专门写了一条单测 `.github is not .git` 钉死它。安全规则误伤会逼用户去找绕过的方法——绕过一旦成了习惯,真拦截也会被绕。

**坑 4:用提示词当防线。** 在 system prompt 里写「请不要删除重要文件」然后就觉得安全了——提示词的遵守率大约八成,剩下两成靠什么?权限必须是代码层的闸门,提示词只是让模型少撞墙的导览图。

## 小结

今天一个判定函数、一道闸门、两条底线:**deny 永远赢,默认 fail closed**。27 条单测把每条边界钉死,三个真实场景验收:该问的问了,该拦的拦住了(bypass 也没用),该干的照干。

到今天,这个 agent 有手(工具)、扛揍(容错)、有规矩(权限)了。但它还有个大问题:话痨任务跑久了,对话历史无限膨胀——明天(Ch6)做上下文管理,顺便揭晓一个我们在 Day 3 意外撞见的数字:DeepSeek 的真实上下文窗口,和官网文档说的不是一回事。

---

*本章对应 commit:`Day 4: permissions — allow, ask, deny`(tag `day4`)*

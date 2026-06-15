# Ch35 · Hook 长全:更多时机 + 改写工具参数

> 本章完整代码:`git checkout day35`。把 Day 14 的 4 个时机扩到 10 个,加一个权限闸门做不到的能力:改写工具参数。

## 这一章做完,你会得到什么

Day 14 的 hook 只能挂 4 个时机(Pre/PostToolUse、SessionStart、Stop)。这一章补到 10 个,还加了一个**标志性能力**:`PreToolUse` hook 不止能"放行/拦截",还能**改写工具的参数**。

经典用法——拦下所有 `git commit`,自动加上 trailer:

```bash
# .mini-agent/settings.json
"hooks": {
  "PreToolUse": [{ "match": "run_bash", "command": "node add-trailer.js" }]
}
```

`add-trailer.js` 读到 `git commit -m "fix"`,输出 `{"toolInput":{"command":"git commit -m \"fix\" --trailer ..."}}`,agent 就用**改写后**的命令执行。权限闸门做不到这个——它只会三态(allow/ask/deny),改不了参数。

新增的时机:`UserPromptSubmit`(你刚发的提示词,可拦可注入)、`SessionEnd`(退出时清理)、`PreCompact`/`PostCompact`(压缩前后)、`SubagentStart`/`SubagentStop`(子 agent 前后)。

## 跟着写

### 第 1 步:事件从硬编码改成开放集

Day 14 的配置把 4 个事件写死了。要长到 26 个(手册 §14.1),不能每加一个就改 schema。把 hooks 配置改成一个**开放 record**:

```ts
// config.ts:  hooks?: Record<string, HookDef[]>
hooks: (() => {
  const merged = {};
  for (const src of [globalSettings.hooks, projectSettings.hooks])  // 全局 + 项目合并
    for (const [event, defs] of Object.entries(src ?? {}))
      merged[event] = [...(merged[event] ?? []), ...(defs ?? [])];
  return merged;
})(),
```

任意事件名都收。`HookEvent` 类型在 `hooks.ts` 里列出我们**实际有那个时机**的子集(10 个)——配置层不关心有哪些,触发层才关心。

### 第 2 步:exit 2 的含义,按事件而不同

Day 14 把 exit 2 统一当"block"。但手册 §14.2 强调:**exit 2 的语义按事件不同,别全局统一**:

| 事件 | exit 2 的意思 |
|---|---|
| PreToolUse | 拦截工具,stderr 给模型 |
| Stop | **继续对话**(测试驱动 AI:测试挂了码 2 让 agent 接着修) |
| UserPromptSubmit | **丢弃这条提示词**(根本不发给模型) |
| SessionEnd / Compact / Subagent* | 观察性,忽略 |

实现上很省:`runHooks` 只报一个通用的 `block`,**怎么解读是调用方的事**。Stop 的调用方把 block 当"继续",UserPromptSubmit 的调用方把 block 当"丢弃",观察性事件直接不看 block。一个通用信号,各处按语义解读——不用给每个事件写一套返回值。

```ts
// agent.ts —— UserPromptSubmit 的解读
const submit = await runHooks("UserPromptSubmit", { prompt: line });
if (submit.block) { console.log("(prompt blocked)"); continue; }  // 丢弃,不发给模型
const injected = submit.stdout ? `\n\n[hook context]\n${submit.stdout}` : "";  // stdout 当上下文注入
```

### 第 3 步:差异化超时——SessionEnd 必须秒退

普通 hook 给 10 秒。但 `SessionEnd` 特殊:它在用户**离开时**触发,而用户常常是按 Ctrl+C 走的——这时候你绝不能让一个慢 hook 卡住退出。所以给它一个极短预算:

```ts
const EVENT_TIMEOUT_MS = { SessionEnd: 1_500 };   // 退出类给 1.5 秒
const timeout = EVENT_TIMEOUT_MS[event] ?? DEFAULT_HOOK_TIMEOUT_MS;
```

手册的原则:**超时按事件分级,退出/中断类给极短**。一个磨蹭的清理 hook,不该让"我想退出"变成"我退不出去"。

### 第 4 步:PreToolUse 改写参数——权限做不到的"岔道"

这是这章的重头。权限闸门是个**三态开关**:allow / ask / deny。它能拦,不能改。而 hook 是条**岔道**——它能在工具执行前,把参数换掉再放行。

约定:`PreToolUse` hook 退出 0、stdout 输出 `{"toolInput": {...}}`,就是改写:

```ts
// hooks.ts —— 解析改写
if (event === "PreToolUse") {
  try {
    const parsed = JSON.parse(out);
    if (parsed?.toolInput && typeof parsed.toolInput === "object") rewrite = JSON.stringify(parsed.toolInput);
  } catch { /* 不是控制 JSON,就是普通 stdout */ }
}
```

```ts
// loop.ts —— 应用改写(权限已经在原参数上判过了)
if (pre.rewrite) {
  try { JSON.parse(pre.rewrite); call = { ...call, args: pre.rewrite }; }  // 校验可解析再用
  catch { /* 改写格式坏了,用原参数 */ }
}
```

注意顺序:**权限闸门先在原参数上判过**,改写只发生在放行之后,而且改写不会越过 deny(deny 的根本到不了这一步)。所以改写只能"收窄/加注",不能"提权"。典型用途:加 commit trailer、给命令补 `--dry-run`、把相对路径展开成绝对路径。

## 为什么这么写

**为什么 exit 2 的语义不统一?** 因为不同时机的"拦截"本来就是不同的动作。PreToolUse 拦的是"这次工具调用",Stop 拦的是"结束"(于是变成继续),UserPromptSubmit 拦的是"这条输入"(于是丢弃)。硬要统一成一个含义,就得为每个事件憋一个别扭的解释。让底层报通用信号、上层按场景解读,反而最清晰——这也是为什么 Day 14 的 Stop"继续"能和 PreToolUse"拦截"共用一个 `block` 字段。

**为什么改写参数要放在权限之后?** 因为安全判断必须基于**模型真正请求的**参数,不是 hook 改过的。如果先改写再判权限,一个恶意 hook 就能把 `rm -rf /tmp` 改成 `rm -rf /` 然后蒙混过安全检查。顺序是:权限在原参数上判 → 放行 → hook 改写 → 执行。改写永远在安全闸门**之内**,不能绕过它。

**为什么 hook 要做成外部程序、退出码当协议?** 因为这是**语言无关**的最低门槛。一个 hook 可以是 bash 一行、Python 脚本、Node 程序——任何能读 stdin、写 stdout/stderr、返回退出码的东西。不绑 SDK、不绑语言,业务流程就能"外挂"在 agent 上,而核心保持小而精。这正是 §14 开篇那句:**核心做精,业务靠 hook 外挂。**

## 你会踩的坑

**坑 1:先改写再判权限。** 安全检查必须看模型请求的原始参数。改写一定在权限之后、执行之前。

**坑 2:exit 2 全局当"拦截"。** 对 Stop 来说 exit 2 是"继续",对 UserPromptSubmit 是"丢弃"。底层别替上层决定语义。

**坑 3:SessionEnd 用默认超时。** 退出时一个 `sleep 30` 的清理 hook,会让用户的 Ctrl+C 卡 30 秒。退出/中断类事件,超时给极短(我们给 1.5 秒)。

**坑 4:改写的 JSON 没校验就用。** hook 输出可能是坏 JSON。用之前 `JSON.parse` 验一下,坏了就退回原参数——一个写错的 hook 不该让工具调用崩掉。

## 小结

本章把 hook 从 4 个时机长到 10 个:配置改成开放 record(加事件不改 schema)、exit 2 的语义按事件由调用方解读、SessionEnd 等退出类给极短超时、新增 UserPromptSubmit(可拦可注入)/SessionEnd/Pre·PostCompact/Subagent。重头是 `PreToolUse` 能**改写工具参数**——权限闸门那个三态开关做不到的"岔道",且严格发生在安全检查之后。

`npm test` 381 例,新增覆盖:参数改写的捕获与"普通 stdout 不当改写"、新事件走同一套机制、SessionEnd 的 1.5 秒超时。

它落地了手册 §14 的核心:**hook 接口要先于内置功能做**——把生命周期的每个关键点都开成插孔,业务就能在不碰核心代码的前提下,挂上你自己的规则(自动加 trailer、提交前跑测试、退出时备份、提示词脱敏……)。(26 个时机里那些我们没有对应功能的——Worktree/Teammate/Elicitation——自然也没做。)

---

*本章对应 commit:`Day 35: more hook events + PreToolUse arg rewrite`(tag `day35`)*

# Ch14 · 核心做精,业务外挂:Hook 生命周期系统

> 进阶篇收官。本章完整代码:`git checkout day14`。新增 `src/hooks.ts`,接进 `loop.ts`(工具前后 + Stop)和 `agent.ts`(SessionStart)。

## 这一章做完,你会得到什么

不改一行源码,用一个外部脚本就能在 agent 的关键时刻插一脚。`.mini-agent/settings.json`:

```json
{ "hooks": {
  "PreToolUse": [{ "match": "run_bash", "command": "echo 'bash disabled here' 1>&2; exit 2" }]
}}
```

效果:

```
> 跑一下 echo hello
🔧 run_bash {"command": "echo hello"}
  ⛔ blocked by PreToolUse hook
🤖 看起来这个项目禁用了 run_bash,我没法直接跑这条命令。
```

更狠的一招——**测试驱动 AI**:一个 Stop hook 在 agent 想收工时跑测试,测试没过就 `exit 2`,把 agent 退回去继续干:

```
🤖 done
↩ Stop hook: not done yet — checkpoint 1 of 3 not reached
🤖 continuing...
↩ Stop hook: not done yet — checkpoint 2 of 3 not reached
🤖 ...
```

## 跟着写

### 第 1 步:通信协议 = 退出码 + stdin/stdout

Hook 是**外部程序**,不是插件 API——所以它可以是 bash 一行、Python 脚本、任何东西。约定极简:

- agent 把事件数据当 JSON 喂给 hook 的 **stdin**
- hook 用**退出码**表态:`exit 0` = 放行;`exit 2` = 拦截,**stderr 回灌给模型**当理由;其他码 = hook 自己挂了(记日志,当放行处理)
- `exit 0` 时 stdout 只在 SessionStart 给模型看(注入上下文)

```ts
function runOne(hook, payload) {
  return new Promise((resolve) => {
    const child = spawn(hook.command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    // ... 累积 stdout/stderr,settled 守卫,超时 SIGKILL ...
    child.stdin.end(JSON.stringify(payload)); // 事件 JSON 喂进去
  });
}
```

注意又是 Day 13 那套异步纪律:spawn + settled 守卫 + 超时 SIGKILL。**一个卡死的 hook 绝不能挂住 agent**——10 秒超时直接杀。

### 第 2 步:四个时机,语义各不相同

```ts
export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart" | "Stop";
```

| 事件 | exit 2 的含义 | 典型用途 |
|---|---|---|
| **PreToolUse** | 拦住这次工具调用,理由喂回模型 | 「这个项目禁 run_bash」「生产配置不许改」 |
| **PostToolUse** | 工具已经跑了,撤不回,但能追加一句警告 | 「你刚写的文件 lint 没过」 |
| **SessionStart** | 忽略(没工具可拦,只能加上下文) | 注入当前 git 分支、值班表、发布冻结状态 |
| **Stop** | **agent 没干完,退回去继续** | 测试驱动:测试没过就不让停 |

**同一个退出码,在不同事件里含义不同**——这是 hook 系统最容易设计错的地方。`exit 2` 在 PreToolUse 是「别做」,在 Stop 是「接着做」,方向正好相反。

### 第 3 步:接进工具执行(loop.ts)

工具执行外面包一层 hook:

```ts
async function runWithHooks(call, opts) {
  if (opts.subAgent) return execute(call, opts); // 子 agent 不走 hook

  const pre = await runHooks("PreToolUse", { tool: call.name, args: call.args });
  if (pre.block) return `[hook] A PreToolUse hook blocked this call: ${pre.feedback}...`; // 拦截,喂回模型

  const result = await execute(call, opts); // 真正干活

  const post = await runHooks("PostToolUse", { tool: call.name, result });
  if (post.block) return `${result}\n\n[hook] PostToolUse: ${post.feedback}`; // 追加警告
  return result;
}
```

拦截消息的写法和 Ch5 的权限拒绝一脉相承:**「这是硬边界,换个approach」**,模型读完会适配而不是死磕。子 agent 跳过 hook——hook 是「人的项目策略」,不该管内部分身怎么干活。

### 第 4 步:Stop hook 与测试驱动 AI(loop.ts)

模型不调工具了(想收工),Stop hook 拿最后一票:

```ts
if (!out.toolCalls.length) {
  if (!opts.subAgent) {
    const stop = await runHooks("Stop", { finalText: out.content });
    if (stop.block) {
      messages.push({ role: "user", content: `[Stop hook] You are not finished: ${stop.feedback}` });
      break; // 退出内层 while → round 计数器 +1,继续干
    }
  }
  return { reason: TerminateReason.Done, finalText: out.content };
}
```

一个关键的控制流细节:这里是 `break` 不是 `continue`。`break` 退出内层重试循环,让外层 `for` 的 **round 计数器递增**——这样即使 Stop hook 顽固地一直 `exit 2`,也照样受 `MAX_ROUNDS` 约束,不会无限循环。**任何「自动继续」的机制都要有上限**(Ch1 就立的规矩,这里又用上)。

### 第 5 步:SessionStart(agent.ts)

会话一开始跑一次,stdout 注入成模型第一轮就能看到的上下文:

```ts
const sessionStart = await runHooks("SessionStart", {});
if (sessionStart.stdout) messages.push({ role: "user", content: `[SessionStart hook]\n${sessionStart.stdout}` });
```

`echo "current branch: $(git branch --show-current)"` 这种一行 hook,就能让 agent 每次都知道自己在哪个分支上干活。

## 为什么这么写

**为什么 hook 用退出码而不是 SDK?** 因为通用。退出码 + stdin/stdout 是 Unix 四十年的通用契约,任何语言任何脚本都能参与。一个需要你 `import` 某个 SDK 才能写的「插件系统」,门槛高一个数量级,生态根本起不来。Claude Code 的 hook 也是这套——退出码即verdict,stderr 即反馈。

**为什么这是工业级架构的核心?** 「把核心做精简,业务流程靠 hook 外挂」。我们的 agent 核心不知道你的项目要 lint、要跑测试、要禁某些命令——这些是**你的策略**,不该焊进我们的源码。hook 接口让核心保持小而稳,把无穷无尽的业务定制推到外面。Claude Code 有 26 个 hook 时机,我们做了最关键的 4 个,但架构是一样的:**核心提供时机,策略由用户外挂。**

**为什么子 agent 不走 hook?** hook 表达的是人对「这个项目」的策略意图。子 agent 是父 agent 内部的实现细节,对它套用户的 PreToolUse 规则,会在用户根本没预期的地方触发拦截。边界要清晰:hook 管面向用户的主流程,不管内部委派。

## 你会踩的坑

**坑 1:exit 2 在不同事件里语义统一。**手一滑把 Stop 的 exit 2 也当「阻止」处理,agent 该停的时候停不下来或该继续的时候continue错地方。每个事件的退出码语义要单独想清楚、单独测。

**坑 2:Stop hook 无限循环。**用 `continue` 而不是 `break`,Stop hook 一直 exit 2,agent 在同一 round 里转圈,绕过 MAX_ROUNDS 烧到天荒地老。自动继续必须挂在 round 计数器上。

**坑 3:卡死的 hook 挂住 agent。**用户写了个 `command: "while true; do :; done"`,没有超时就把整个 agent 焊死了。10 秒超时 + SIGKILL,一个都不能少。

**坑 4:broken hook 让工具起不来。**hook 脚本本身有 bug(exit 127:命令找不到),如果当成「拦截」处理,用户会发现所有工具都被自己写挂的 hook 拦了,还找不到原因。其他退出码 = hook 自己的问题,记日志、放行,绝不连累正经活。

## 小结

进阶篇到此收官。Hook 系统让 mini-agent 从「一个固定的工具」变成「一个可以被用户的策略包裹的平台」:PreToolUse 拦危险、PostToolUse 加校验、SessionStart 注入上下文、Stop 实现测试驱动 AI——全部不改一行核心源码。

四章进阶(配置 / 持久化 / 异步 / hook)把课程主线那个「能跑的 agent」,补成了一个**工业级 CLI**:可配置、记得住、不冻死、可扩展。`npm test` 76 个检查兜底,`git log` 14 行就是它的全部成长史。

它仍然只有约 2000 行,每一行你都看得懂——这从来不是妥协,是它的全部价值。

---

*本章对应 commit:`Day 14: the hook lifecycle system`(tag `day14`)*

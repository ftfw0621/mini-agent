# Ch20 · 先看后做:计划模式(Plan Mode)

> 本章完整代码:`git checkout day20`。新增一个工具 `exit_plan_mode`、权限层一个开关,REPL 一个 `/plan` 命令。

## 这一章做完,你会得到什么

一个**只读的研究模式**。打开它,agent 可以读文件、搜代码、跑安全的只读命令去摸清楚你的代码库——但任何会改动世界的操作(写文件、改文件、`rm`、调外部 MCP 工具)全部被权限闸门挡下。等它想清楚了,它给你一份计划,你点头之后才开始动手:

```
> /plan
(plan mode ON — read-only research; the agent will present a plan for you to approve)

(plan) > 把 config 的加载逻辑拆成单独的模块

🔧 search {"pattern": "loadConfig"}
🔧 read_file {"path": "src/config.ts"}
🔧 exit_plan_mode {"plan": "1. 新建 src/config-loader.ts ..."}

⚠️ approval needed — exit_plan_mode (leave plan mode and start implementing):
   1. 新建 src/config-loader.ts,把 ... 搬过去
   2. config.ts 改为 re-export
   3. 跑 npm test 确认
  Allow? [y/N] y

🤖 好,开始实现……   ← 批准后才动第一刀
```

为什么要这个?因为 agent 最危险的时刻,是它**误解了你的意图却已经开始改文件**。计划模式把「理解」和「执行」之间插了一道人类的闸:它先把打算怎么做摊开给你看,你纠正完方向,它再下手。改十个文件之前先看一眼计划,比改完再回滚便宜得多。

## 跟着写

### 第 1 步:计划模式只是权限层的一个开关

这一章最舒服的地方在于:我们前面已经把地基打好了。Day 4 的权限闸门 `checkPermission` 是**每个工具调用的唯一入口**,Day 13 又区分了「只读工具」和「会改动的工具」。计划模式不需要新的执行路径——它只是在那道闸门上加一个**外层过滤器**:开关一开,凡是会改动世界的调用一律降级成 deny。

状态就放在权限模块里,因为闸门才是真正执行规则的地方:

```ts
let planMode = false;                                  // 默认关,大多数会话用不到
export const isPlanMode = () => planMode;              // REPL 用它来标记提示符
export const setPlanMode = (on: boolean) => { planMode = on; };
```

### 第 2 步:什么算「安全」——复用已有的判断,不另起炉灶

计划模式下哪些调用能放行?标准只有一个:**它只观察,不改动**。我们不重新发明一套分类,而是复用每个工具已有的语义:

```ts
function planSafe(toolName: string, verdict: Verdict): boolean {
  switch (toolName) {
    case "read_file":
    case "search":
    case "task":            // 子 agent 自己的调用也会撞这道闸,照样在计划模式里
    case "exit_plan_mode":  // 出口本身绝不能被计划模式挡住
      return true;
    case "run_bash":
      return verdict.decision === "allow"; // ls/cat/git status 放行;rm/sudo 不行
    default:
      return false;         // write_file、edit_file、MCP、未知工具:全是改动或不可知
  }
}
```

最妙的是 `run_bash` 这一行:我们不重新判断哪些命令安全,直接看 Day 4 的命令分类器**已经**给出的结论——它评成 `allow` 的(`ls`、`cat`、`git status`)就是只读的,评成 `ask`/`deny` 的(`rm`、`sudo`、`curl | sh`)就是会动手的。一个判断,两处复用。

### 第 3 步:外层过滤器——只收紧,绝不放松

把开关接进 `checkPermission`。关键是它和原有规则的关系:计划模式**只能让结果更严,不能更松**。

```ts
export function checkPermission(toolName: string, argsJson: string): Verdict {
  const base = basePermission(toolName, argsJson);     // 原来的规则,原封不动
  if (planMode && base.decision !== "deny" && !planSafe(toolName, base)) {
    return { decision: "deny", reason: "plan mode is on — ... call exit_plan_mode ...", summary: base.summary };
  }
  return base;
}
```

两个守卫缺一不可:

- `base.decision !== "deny"`:本来就是 deny 的(比如写 `.git/` 这种禁飞区),**保留它原本更具体的理由**,而不是盖上一句笼统的「计划模式」。deny always wins,而且要带着最有用的那句话赢。
- `!planSafe(...)`:只把「会改动的 allow/ask」降级成 deny。只读的调用原样放行。

注意它连**用户预批准**都能盖过:你在 settings 里写了 `tool:write_file` 允许免确认写文件,计划模式照样把它挡下——因为计划模式是更强的、临时的「现在先别动」,优先级高于常规的放行规则。

### 第 4 步:出口是一个工具,不是一个命令

agent 怎么离开计划模式?它得先**有一份计划**。所以出口被做成一个工具 `exit_plan_mode`——模型研究完,把计划当参数传进来:

```ts
const exitPlanMode: Tool = {
  definition: def("exit_plan_mode",
    `研究完、有了明确的有序计划时才调用。把计划作为 markdown 传进 plan,用户会看到并决定是否批准。`,
    { plan: { type: "string", description: "实现计划,简洁的有序 markdown 步骤" } }, ["plan"]),
  run: () => {
    setPlanMode(false);   // run() 只在用户批准后才执行——所以走到这里就是「已批准」
    return "Plan approved by the user. Plan mode is OFF — implement the plan now ...";
  },
};
```

它和权限层是这样配合的:在 `checkPermission` 里,计划模式下 `exit_plan_mode` 被判成 `ask`,而且把 **plan 文本作为给用户看的摘要**:

```ts
case "exit_plan_mode": {
  if (!planMode) return { decision: "allow", reason: "not in plan mode (no-op)", summary: "exit_plan_mode" };
  return { decision: "ask", reason: "leave plan mode and start implementing", summary: args.plan ?? "(no plan provided)" };
}
```

于是流程天然闭合:模型调 `exit_plan_mode` → 闸门判 `ask` → `confirm()` 把计划摊给用户看 → 用户点 yes,工具的 `run()` 才执行 → `run()` 里 `setPlanMode(false)` 关掉模式。**「批准」这个动作和「关闭计划模式」这个副作用,被 Day 4 的 ask 机制自动绑在了一起**——我们没有写任何新的审批逻辑,复用的就是权限确认那一套。用户点 no?`run()` 不执行,计划模式原样开着,模型收到「被拒绝」,自己去改计划。

### 第 5 步:REPL 里挂一个 `/plan` 开关

最后在 REPL 加个命令,顺手把模式的「规矩」作为一条用户消息注入,让模型知道自己现在身处何种模式(闸门无论如何都会强制执行,这条消息只是让模型主动配合):

```ts
case "/plan":
  if (isPlanMode()) { setPlanMode(false); console.log("(plan mode OFF ...)"); }
  else {
    setPlanMode(true);
    messages.push({ role: "user", content: PLAN_MODE_NOTICE });   // 告诉模型规矩
    console.log("(plan mode ON ...)");
  }
  return true;
```

再让提示符把模式显出来——绿色 `>` 变成青色 `(plan) >`,用户一眼就知道现在写操作会被挡,不会觉得 agent「怎么不动手」很奇怪:

```ts
const promptStr = isPlanMode() ? chalk.cyan("\n(plan) > ") : chalk.green("\n> ");
```

## 为什么这么写

**为什么计划模式是「过滤器」而不是另一套权限规则?** 因为我们不想维护两份关于「什么危险」的判断——一份给正常模式,一份给计划模式,迟早会漂移。计划模式只回答一个新问题:「这个调用改动世界吗?」改动世界的标准,直接借用已有的 allow/ask/deny 结论。新增的代码只有「收紧」这一层,旧规则一行没动。这是 Day 4「唯一入口」的复利:闸门只有一个,新策略就只加一次。

**为什么出口要做成工具,而不是让模型说一句「我做好计划了」?** 因为「说完了」是自然语言,模糊;调一个带 `plan` 参数的工具是结构化的、确定的信号——和 Day 19 把概率输出钉进结构是同一个思路。更重要的是,工具调用会经过权限闸门,于是「展示计划 + 等待批准 + 批准后关闭模式」三件事,全都白嫖了 Day 4 的 ask 流程,一行新审批代码都不用写。

**为什么计划模式能盖过用户的预批准?** 因为它们回答的不是同一个问题。`tool:write_file` 说的是「这个工具我一般信得过,别每次问我」;计划模式说的是「**现在这个阶段**,我要先看计划,什么都先别改」。后者是临时的、针对当下意图的,该赢。两个守卫的顺序保证了:唯有 deny(禁飞区那种硬规则)能盖过计划模式,计划模式能盖过其余一切放行。

## 你会踩的坑

**坑 1:把出口工具也给挡了。** `exit_plan_mode` 必须在 `planSafe` 里返回 true,否则模型永远出不去——它想交计划,却被计划模式拦下,死循环。出口绝不能被它自己守的门挡住。

**坑 2:计划模式盖掉了 deny 的具体理由。** 如果不加 `base.decision !== "deny"` 这个守卫,模型想写 `.git/config`,得到的会是「计划模式开着」——而真正的原因是「这是禁飞区,任何模式都不准」。具体的理由比笼统的更能教会模型边界。让 deny 带着自己的话赢。

**坑 3:子 agent 绕过计划模式。** 别担心——`task` 在 `planSafe` 里放行,但子 agent 自己的每个工具调用,走的是**同一个** `checkPermission`,`planMode` 是进程级全局开关,照样对它生效。Day 7「子 agent 的工具逐个过闸」在这里又收一次红利:不用专门处理。

**坑 4:用户不知道自己在计划模式里。** 模型一直在读、在搜,就是不写文件,用户会以为它卡住了。提示符改成 `(plan) >`,加上开关时的提示语,把模式显式地摆在用户面前——状态不可见,就等于不存在。

## 小结

本章加了一个计划模式:打开后 agent 只读不写,研究清楚再通过 `exit_plan_mode` 把计划交给你批准,批准了才动手。实现上它几乎没有新逻辑——一个全局开关、一个「只收紧不放松」的外层过滤器、一个借用 ask 流程的出口工具。它能这么轻,全靠前面攒下的地基:Day 4 的唯一权限入口、Day 13 的只读分类、Day 7 的子 agent 同闸、Day 19 的结构化工具信号。

`npm test` 167 例,新增 21 个覆盖:计划模式挡写、放行只读、盖过预批准、保留禁飞区理由、出口的 ask 与关闭。

这也呼应了一条贯穿全书的主线:agent 的安全感不来自「相信模型不会犯错」,而来自**在它和真实世界之间,一道一道地架确定性的闸**。计划模式,是把人类的「再看一眼」也变成其中一道闸。

---

*本章对应 commit:`Day 20: plan mode`(tag `day20`)*

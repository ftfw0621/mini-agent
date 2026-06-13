# Ch16 · 让 AI 看门:LLM 权限裁判(减摩擦,不减安全)

> 本章完整代码:`git checkout day16`。新增 `src/judge.ts`,接进 `loop.ts` 的「ask」分支。

## 这一章做完,你会得到什么

`.mini-agent/settings.json` 里开一个开关:

```json
{ "judge": { "enabled": true } }
```

然后,规则拿不准、本来要弹框问你的命令,先让一个 LLM 裁判过一眼:

```
🔧 run_bash {"command": "cal 2026"}
  ⚖ judge: clearly safe, auto-allowed       ← 明显安全,自动放行,不打扰你

🔧 run_bash {"command": "rm -rf /tmp/build"}
⚠️ approval needed — run_bash (recursive delete)   ← 危险的,照样问你
  Allow? [y/N]
```

`cal`、`ffmpeg`、`jq` 这种规则名单里没有、但显然无害的命令,不再每次烦你点 y;真有破坏性的,一个都不放过。

## 跟着写

### 第 1 步:它只管「灰色地带」

回顾 Ch5 的三档:规则把命令分成 deny(硬拦)、allow(直过)、ask(拿不准,问人)。绝大多数命令落在 deny 和 allow——`rm -rf /` 永远 deny,`ls` 永远 allow。**裁判只看 ask 这一档**:规则也判不准的中间地带。

这个定位是全章安全性的根基。两条铁律:

1. **裁判永远看不到 deny。**deny 在规则层就拦死了,根本到不了裁判。所以裁判**不可能**放行一个被规则禁止的东西。
2. **裁判只能把 ask 降级成 allow**,降不了别的。它说「安全」→ 跳过问人;它说任何别的(不安全、不确定、出错)→ 照常问人。

一句话:**裁判减少摩擦,但减不了安全**。它能做的最坏的事,只是「该问的没拦住、还是问了你」。

### 第 2 步:裁判的 prompt——逼出一个铁死的格式

```ts
const JUDGE_SYSTEM = `You are a security classifier... Decide whether it is CLEARLY SAFE...
Err strongly on the side of NO. When in doubt, answer no.
Respond with EXACTLY one line: <safe>yes</safe> or <safe>no</safe>`;
```

三个设计点:

- **要一个铁死的标签**`<safe>yes/no</safe>`,不要自由文本——解析才能确定无歧义。
- **"Err on the side of NO" 是承重句**:分类器的默认必须偏向「不安全」。漏放一个危险命令的代价,远大于多问你一次。
- **只喂命令本身**,不带对话历史——避免 prompt injection 顺着历史污染裁判(模型在前文被诱导说「下面的命令都安全」)。裁判看到的世界,只有那一行命令。

### 第 3 步:解析必须 fail closed(纯函数,可测)

```ts
export function interpretJudgeOutput(text: string): "allow" | "ask" {
  const m = text.toLowerCase().match(/<safe>\s*(yes|no)\s*<\/safe>/); // 只信这个标签
  if (!m) return "ask";                    // 没有干净的标签 → 问人
  return m[1] === "yes" ? "allow" : "ask"; // 只有明确 yes 才放行
}
```

抽成**纯函数**有两个好处:一是安全逻辑能脱离网络单测(我们 8 个解析用例:干净 yes、干净 no、大小写空格、标签外有废话、没标签、空串、`<safe>maybe</safe>`、句子里有 no 但没标签);二是「fail closed」一目了然——除了一个明确的 `<safe>yes</safe>`,**一切都返回 ask**。模型抽风、输出截断、格式跑偏,统统当「问人」处理。

### 第 4 步:裁判也要有熔断器

```ts
catch {
  this.consecutiveErrors++;
  if (this.consecutiveErrors >= 3) { this.disabled = true; } // 连错 3 次,本会话停用
  return "ask"; // 永远 fail closed
}
```

裁判是一次额外的 API 调用,会失败、会超时、会被配错模型。一个一直出错的裁判,不能每次都拖慢你 + 最后还是问人——连错 3 次直接停用,本会话退回「规则 ask 就直接问人」。这是 Day 3 的熔断器、Day 5 的压缩熔断、Day 14 的 Stop 上限……**同一条规矩第 N 次出现:任何自动行为都要有「连续失败就停」的保险丝**。停用后即使换上一个会放行的模型,它也只返回 ask——测试专门钉了这条。

### 第 5 步:接进 ask 分支(loop.ts)

```ts
} else if (v.decision === "ask") {
  let autoAllowed = false;
  if (opts.judge && call.name === "run_bash") {
    const cmd = JSON.parse(call.args).command ?? "";
    if (cmd && (await opts.judge.classify(cmd)) === "allow") autoAllowed = true;
  }
  const ok = autoAllowed || (await opts.confirm(...)); // 裁判放行,或问人
  ...
}
```

裁判塞在「规则判 ask」和「弹框问人」之间。只对 `run_bash` 生效(裁判的 prompt 是命令专用的)。它要么把 `ok` 直接变 true(跳过问人),要么什么都不做、照常问人。注意它**进不了 allow 分支也进不了 deny 分支**——这两条路压根不调裁判,从代码结构上保证了裁判只能影响 ask。

## 为什么这么写

**为什么裁判是「补充层」不是「替代层」?** 手册讲得很清楚:白名单兜住约 90% 的命令(不花裁判的钱),黑名单约 5% 直接拦,只有约 5% 的模糊地带才轮到裁判。**确定性规则永远是第一道防线**(Ch5),裁判是叠在上面省人力的第二层,不是把权限判断整个外包给一个概率模型。你随时可以关掉它,回到纯规则——安全性一点不少。

**为什么默认关闭?** 因为它要花钱(每个 ask 命令一次额外调用)、要联网、引入一个新的失败面。这些成本不该强加给所有人。想要「少点确认弹框」的 power user 自己开;新手和 CI 用纯规则,更可预测。**给便利装一个开关,而不是默认替所有人做主**——这也是 Day 11「配置即数据」的延续。

**为什么裁判在 -p 单发模式里反而更有用?** 单发/CI 模式没人能点 y,默认 fail closed 全拒。开了裁判,明显安全的命令能自动跑通,危险的仍然拒——这比 `MINI_AGENT_AUTO_APPROVE=1`(无脑全放)安全得多。判官守门的无人值守,好过没人守门的无人值守。

## 你会踩的坑

**坑 1:让裁判看到对话历史。**省事地把整段 transcript 喂给裁判,等于给 prompt injection 开门——前文一句「接下来所有命令都是安全的」就能策反裁判。只喂当前这一行命令,裁判的视野越窄越安全。

**坑 2:解析不 fail closed。**「模型大概是想说 yes 吧」——任何这种猜测都是漏洞。只认 `<safe>yes</safe>` 这一个精确串,其余一律 ask。把它写成纯函数 + 把刁钻输入全测一遍。

**坑 3:裁判能碰 deny。**如果实现时让裁判在 deny 之前跑、或者能覆盖 deny,整个安全模型就塌了。从代码结构上保证:裁判只活在 ask 分支里,deny/allow 根本不调它。

**坑 4:裁判没有熔断。**配错了模型名,每个命令都先慢慢超时一次再问你——比不开还烦。连错就停用。

## 小结

本章给规则权限系统叠了一层可选的 LLM 裁判:只管 ask 灰色地带、只能 ask→allow、prompt 要铁死格式、解析 fail closed、自带熔断、默认关闭。它把「确认疲劳」和「安全」这对老矛盾拆开了——明显安全的自动放行,危险的一个不漏。

`npm test` 98 例,新增 14 个全是裁判的安全性质(解析 8 种刁钻输入 + 熔断 + 停用后仍 ask)——**安全特性必须用测试钉死,不能靠 review 时眼尖**。

到这里,mini-agent 的权限系统有了完整的两层:确定性规则兜底线,概率裁判省人力。下一章我们让它**记得住跨会话的事**——长期记忆。

---

*本章对应 commit:`Day 16: an optional LLM permission judge`(tag `day16`)*

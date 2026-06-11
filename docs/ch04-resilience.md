# Ch4 · 让它扛揍:重试、退避、熔断

> 本章完整代码:`git checkout day3`。新增 `src/errors.ts`、`src/loop.ts`,`src/agent.ts` 瘦身成纯入口。

## 这一章做完,你会得到什么

前两天的 agent 是个晴天选手:网络一抖就吐堆栈,Ctrl+C 直接撂挑子。今天给它三种「死法」,它都死得体面:

**拔网线**(API 连不上):

```
  [retry] network — attempt 1/10, waiting 588ms
  [retry] network — attempt 2/10, waiting 1052ms

⚠️ 3 API failures in a row — stopping here instead of burning money.
```

**塞一个 3MB 的输入**(超出上下文窗口):

```
⚠️ The conversation no longer fits the model's context window.
   (Compaction arrives on Day 5 — for now, start fresh.)
```

**任务跑一半按 Ctrl+C**:

```
(interrupt received — winding down, Ctrl+C again to force quit)

⚠️ Interrupted — stopped cleanly.
```

📷(此处放运行截图)

没有堆栈、没有僵死、没有无限重试。每种结局一句人话,该退就退,exit code 还分得清是中断(130)还是失败(1)。

## 跟着写

### 第 1 步:给错误分类(errors.ts)

容错的前提是先看清自己是怎么死的。新建 `src/errors.ts`,把 API 调用的失败方式枚举出来:

```ts
export enum ApiErrorKind {
  Network = "network",          // connection refused, DNS failure...
  Timeout = "timeout",
  RateLimited = "rate_limited", // 429 — the server is telling us to back off
  ServerError = "server_error", // 5xx — their problem, worth retrying
  ContextTooLong = "context_too_long",
  AuthFailed = "auth_failed",   // 401/403 — retrying will never help
  BadRequest = "bad_request",
  Aborted = "aborted",          // the user cancelled (Ctrl+C)
  Unknown = "unknown",
}
```

然后写一个 `classifyError(err)`:拿 openai SDK 抛的异常,对照错误类型和 HTTP 状态码,翻译成上面九种之一,顺便标注 `retryable` 是 true 还是 false。关键几条:

- 429 可重试(但有自己的小预算,后面说);401/403 **不可重试**——key 错了,试一万次也是错
- 400 且报错信息里提到 context length → `ContextTooLong`,单独处理
- 没见过的错误归 `Unknown`,**默认可重试**——但它照样消耗预算,真有问题会被熔断器拦住

为什么要分这么细?《Harness Engineering》里那句话:**「500 错误率上升」要排查两小时;「rate_limited 从 0 跳到 5%」五分钟就能定位。** 分类的粒度,决定了你出事后的排查速度。Claude Code 的错误枚举超过 25 种,我们 9 种起步,够用。

### 第 2 步:循环变状态机(loop.ts)

昨天的循环只有一种结局:正常结束。今天先承认现实——**一个查询有很多种死法**,每种都配名字:

```ts
export enum TerminateReason {
  Done = "done",
  RoundCap = "round_cap",
  CircuitBreaker = "circuit_breaker",
  RetryBudgetExhausted = "retry_budget_exhausted",
  RateLimitBudgetExhausted = "rate_limit_budget_exhausted",
  ContextTooLong = "context_too_long",
  FatalApiError = "fatal_api_error",
  UserInterrupt = "user_interrupt",
}
```

循环主体的骨架(完整代码见仓库):

```ts
const attempts = { total: 0, rateLimited: 0, consecutive: 0 };

for (let round = 1; round <= MAX_ROUNDS; round++) {
  while (true) {                       // retry the model call until success or a budget dies
    try {
      res = await client.chat.completions.create({...}, { signal });
    } catch (err) {
      if (opts.isInterrupted()) return { reason: UserInterrupt };
      const e = classifyError(err);
      if (!e.retryable) return ...;    // fatal: stop immediately

      attempts.total++;
      attempts.consecutive++;
      if (e.kind === RateLimited) attempts.rateLimited++;

      if (attempts.consecutive >= 3)  return { reason: CircuitBreaker };
      if (attempts.rateLimited >= 3)  return { reason: RateLimitBudgetExhausted };
      if (attempts.total >= 10)       return { reason: RetryBudgetExhausted };

      await interruptibleSleep(backoffMs(attempts.consecutive));
      continue;                        // retry the same round
    }
    attempts.consecutive = 0;          // success resets the breaker — never the total
    // ...push message, dispatch tools, break to next round
  }
}
```

三个计数器、三道闸门,各管一类事故:

| 闸门 | 阈值 | 防什么 |
|---|---|---|
| `consecutive`(熔断器) | 连续 3 次 | 热失败循环:服务整个挂了,继续试就是烧钱 |
| `rateLimited`(429 专用预算) | 累计 3 次 | 服务器明确说「太挤了」,你还挤就是火上浇油 |
| `total`(总预算) | 累计 10 次 | 间歇性抽风:失败-成功-失败来回横跳,熔断器拦不住它 |

注意那行 `attempts.consecutive = 0`:**成功只重置熔断器,不重置总预算**。如果成功也重置总预算,一个「失败两次成功一次」无限循环的会话能跑到天荒地老。

### 第 3 步:退避要带抖动

```ts
function backoffMs(consecutiveFailures: number): number {
  const base = Math.min(500 * 2 ** (consecutiveFailures - 1), 15_000);
  return Math.round(base * (1 + Math.random() * 0.25));
}
```

指数退避(500ms → 1s → 2s → …)大家都懂,**抖动(±25% 随机)**才是容易漏的:服务器一抖,全世界的客户端同一毫秒失败;不加抖动,它们会在同一毫秒集体重试——这叫惊群(thundering herd),等于对一个已经踉跄的服务器发起 DDoS。上面验收截图里 588ms、1052ms 这两个不整的数字,就是抖动在工作。

### 第 4 步:Ctrl+C 的两段式退出(agent.ts)

```ts
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);  // second Ctrl+C = force quit
  interrupted = true;
  controller.abort();                  // kills the in-flight API request
});
```

第一下 Ctrl+C:置标志位 + abort 掉正在飞的 API 请求,循环在下一个检查点体面收场;第二下:用户是真急了,立刻硬退。`AbortController` 的 signal 直接传给 openai SDK,正在等的请求会立即中断——不用等它自己超时。

配套一个细节:退避等待用 `interruptibleSleep` 实现,把长 sleep 切成 200ms 的小片,每片之间查一次中断标志。不切片的话,赶上一次 15 秒的退避,用户按 Ctrl+C 要干等 15 秒才有反应。

## 为什么这么写

**为什么终态要枚举,不是一个 catch 完事?** 因为每种死法的「善后」不一样:给用户的解释不一样(网络问题 vs key 错了 vs 任务太大)、exit code 不一样、要不要保留中间产物不一样。`agent.ts` 里有一张 `EXIT_NOTES` 表,八种终态各配一句人话——「调模型 → 出错就 alert + return」是 demo,「每种死法都有预案」才是产品。

**为什么熔断器是 3 不是 10?** 熔断器防的是「热失败循环」——连续失败说明问题是持续性的,多试几次不会有新信息,只会多烧几次钱。Claude Code 的真实事故:自动压缩逻辑缺熔断,单个会话连续失败 3272 次,按下葫芦起了瓢,全球每天浪费约 25 万次 API 调用。**任何会自动重试的行为,都要有「连续 N 次就停」的保险丝**——我们 Day 1 的轮数上限、今天的熔断器、以后每个自动行为,都遵守这条。

**为什么 429 要单独一个更小的预算?** 429 的语义是「服务器忙不过来」。这时候你的每次重试,对过载的后端都是 3-10 倍的放大(连接、鉴权、排队全要重走)。一万个客户端同时无脑重试,服务直接雪崩。所以 429 只给 3 次机会,而且 Claude Code 更进一步:后台任务遇到 429 一次都不重试,直接放弃——只有「用户正在等」的前台请求才值得重试。

## 你会踩的坑

**坑 1:SDK 在你脚下偷偷重试。** openai SDK 默认自带 2 次内置重试。不关掉它,你的「重试 10 次」实际是 30 次,退避时间也全乱了。一行解决:`new OpenAI({ maxRetries: 0 })`——**重试策略只能有一个主人**。这是今天最隐蔽的坑,不知道的人会觉得「我的熔断器怎么不准」。

**坑 2:abort 的错误形态千奇百怪。** 你以为 Ctrl+C 后 SDK 会抛标准的 `APIUserAbortError`——实测它有时抛连接错误、有时抛 `AbortError`,分类器很容易把它当成网络故障去「重试」,白打日志白等退避。解法是防御性双保险:catch 里**先查中断标志**再分类,分类器里也兜一层 `err.name === "AbortError"`。我写这章时就踩了:第一版 Ctrl+C 后多打了一行 `[retry] unknown`。

**坑 3:重试静默进行。** 不打那行 `[retry] network — attempt 1/10, waiting 588ms`,用户看到的就是程序卡住 30 秒——然后他会再按一次回车、再开一个进程、再发一次请求。**重试必须可见**,告诉用户「我没死,我在按计划自救」。

**坑 4:超长输入想当然。** 我们原计划按「DeepSeek 64K 窗口」设计测试,结果 72 万字符的输入它居然正常处理了——真实报错显示 deepseek-chat 的窗口是 **1,048,565 token(约 1M)**。教训:**模型的参数永远以 API 真实报错为准,不要信记忆里的旧数字**(包括本教程——你跑的时候它可能又变了)。

## 小结

今天没有新功能,全是「看不见的工程」:9 种错误分类、8 种具名终态、3 个计数器、2 段式中断、1 个熔断器。

衡量标准也变了:前两天问「它能做什么」,今天问「它怎么死的」——**能扛住失败的 agent,才配谈功能**。

明天(Ch5)讲今天故意没碰的另一半危险:agent 自己就是危险源。它现在拿到 `run_bash` 就是满权限——一句 `rm -rf` 没人拦得住。明天我们做权限系统,开场是一个真实事故:AI 用 9 秒删光了一家公司的生产数据库。

---

*本章对应 commit:`Day 3: state machine, retries and a circuit breaker`(tag `day3`)*

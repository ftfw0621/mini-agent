# Ch18 · 账单看得见:token 与缓存成本核算

> 本章完整代码:`git checkout day18`。新增 `src/cost.ts`,从流里捕获 usage,接进 `/cost`。

## 这一章做完,你会得到什么

聊两轮,看一眼花了多少:

```
> /cost
tokens this session (2 model calls):
  input:  3360 (3328 cached, 99% hit rate)
  output: 4
  estimated cost: $0.0002 (rough — prices set in settings.pricing)
```

那个 **99% 命中率**是全章的主角。它告诉你:第二轮重发的 system prompt + 历史,几乎全部命中了缓存——你没在为同一段前缀反复付全价。哪天它掉到 50%,就是缓存被悄悄击穿了,该查为什么。

## 跟着写

### 第 1 步:为什么 token 经济学值得单独一章

《Harness》整本书最反复强调的就是 token 成本,几个扎心的事实:

- **output 比 input 贵约 5 倍**——别让模型吐长 JSON。
- **缓存命中省约 90%**——重发相同前缀,命中部分打一折。
- **缓存击穿是静默的**——`cache_read` 降了,没有任何报错告诉你为什么,月底看账单才发现。

最后一条最毒。所以工业级 agent 的第一要务不是「省钱」,是「**让花销看得见**」——你没法管理你看不见的东西。

### 第 2 步:从流里白捡 usage

我们不额外发一个「数 token」的请求——API 早就把用量随响应附上了。流式模式下要主动要:

```ts
client.chat.completions.create({ ..., stream: true, stream_options: { include_usage: true } });
```

加了 `include_usage`,流的**最后一个 chunk** 会带 `usage`。在流循环里顺手记下:

```ts
for await (const chunk of stream) {
  if (chunk.usage) recordUsage(chunk.usage); // 最后那个用量 chunk
  ...
}
```

零额外成本——用量是 API 本来就回的,你只是接住它。

### 第 3 步:抹平各家的 usage 格式差异

各家的 `usage` 字段不一样,得归一化。DeepSeek 直接给命中/未命中的拆分;OpenAI 只给一个嵌套的 `cached_tokens`:

```ts
export function normalizeUsage(usage) {
  // DeepSeek: 直接有 prompt_cache_hit_tokens / prompt_cache_miss_tokens
  if (有 dsHit && 有 dsMiss) return { inputUncached: dsMiss, inputCached: dsHit, output };
  // OpenAI: 只有 prompt_tokens_details.cached_tokens,自己减
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return { inputUncached: prompt - cached, inputCached: cached, output };
}
```

这是 Day 10「任意模型可配」的延续:既然支持多家 provider,跨家的字段差异就得在一个地方抹平。归一成统一的三元组(未命中 input / 命中 input / output),后面的算账就和 provider 无关了。

### 第 4 步:成本和命中率——纯函数

```ts
export function costOf(u, p) {
  return (u.inputUncached*p.inputPerM + u.inputCached*p.cachedInputPerM + u.output*p.outputPerM) / 1e6;
}
export function cacheHitRate(u) {
  const input = u.inputUncached + u.inputCached;
  return input === 0 ? 0 : u.inputCached / input; // 注意:除零返回 0,不是 NaN
}
```

抽成纯函数,把各种刁钻输入测个遍(两家格式、缺字段、除零)。价格做成可配置(`settings.pricing`),默认值标了 DeepSeek 量级但**明说会过时**——我们要的是命中率和趋势,不是三位小数的精确账单。

### 第 5 步:命中率为什么是最该盯的数

`/cost` 报告里,token 数和估算成本是给你个量级感,但**最该盯的是命中率**。原因:

- 缓存命中省 90%,所以命中率直接决定你 input 那部分的真实花销。
- 缓存击穿不报错——命中率是唯一能让你**看见**击穿的信号。
- 命中率掉,几乎总是因为前缀里混进了每次都变的东西:日期、随机 ID、动态字段(Ch7 讲过「system prompt 里连日期都不能写」)。

所以这个数不是给你算账用的,是给你**当报警用的**:平时盯着它在 90%+,某天掉到 50%,立刻去查前缀里多了什么变量。

## 为什么这么写

**为什么本地核算就够了?** 因为这是单人工具,我们没有服务端。API 把用量随每次响应回给你,本地累加就是完整的成本视图——不需要任何上报。这和 Day 12 的本地遥测一个哲学:数据的全部好处(自我诊断),零隐私成本。

**为什么估算不追求精确?** 价格天天变、各家不同、还有阶梯计费。追求账单级精确,要么硬编码一堆会过时的数字,要么对接计费 API——对一个「让你心里有数」的功能,性价比太低。给个可配置的默认价,把**命中率和趋势**做准,就抓住了 95% 的价值。Ch9 的判断:别为最后 5% 的精度付 10 倍复杂度。

**为什么不自动省钱、自动优化?** 因为「优化」需要判断,而判断需要你看见数据先。这一章只做「看得见」,不做「自动管」——就像体重秤不该自己帮你节食。看见了,你自己就知道该不该让模型少吐 JSON、该不该查缓存。

## 你会踩的坑

**坑 1:忘了 include_usage,流里没有 usage。**非流式响应默认带 usage,但流式默认不带——必须显式 `stream_options: { include_usage: true }`,否则你的 `/cost` 永远是 0,还找不到原因。

**坑 2:除零成 NaN。**一个 usage 全 0 的 chunk(或刚启动还没调用),命中率算成 `0/0 = NaN`,报告里就是个刺眼的 NaN。除零显式返回 0。

**坑 3:把 provider 格式差异散落各处。**如果在记录、报告、计费三个地方各自处理 DeepSeek/OpenAI 的字段,加第三家时就要改三处。归一化集中在一个 `normalizeUsage`,下游全部 provider 无关。

**坑 4:命中率当成本看,成本当命中率看。**成本是「花了多少」(已发生),命中率是「健康度」(预警)。盯成本你只会月底心疼,盯命中率你能当天发现前缀被污染。两个数,两种用途。

## 小结

本章给 mini-agent 一双看账单的眼睛:从流里白捡 usage、抹平各家格式、纯函数算成本与命中率、`/cost` 一眼看清。核心不是省钱,是**让花销和缓存健康度看得见**——尤其那个会静默击穿的缓存命中率。

`npm test` 130 例,新增 16 个全是核算的数学(两家格式、缺字段、除零、累加、usage-less chunk 不计数)。真机验证:两轮对话后命中率 99%,把「重发同一段话」的缓存折扣实实在在显示了出来。

进阶篇到这里,mini-agent 在「可观测」这一层补齐了最后一块:本地遥测看行为(Day 12)、长期记忆看知识(Day 17)、成本核算看花销(本章)。

---

*本章对应 commit:`Day 18: token & cache cost accounting`(tag `day18`)*

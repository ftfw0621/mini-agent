# Ch19 · 把概率输出钉进结构:工具调用校验与修复

> 本章完整代码:`git checkout day19`。新增 `src/validate.ts`,接进 `tools.ts` 的 dispatch。

## 这一章做完,你会得到什么

模型漏传参数、传错类型,不再是工具内部一句莫名其妙的崩溃,而是一条它能照着改的精确指引:

```
🔧 read_file {}
[error] Invalid arguments for read_file: missing required parameter "path". Fix and call again.

🔧 read_file {"path": "x.txt"}      ← 模型自己补上了
🤖 文件内容是 ...
```

对 MCP 工具(Day 15)更有用:参数不合规,在**送往 server 之前**就被拦下,省一次网络往返。

## 跟着写

### 第 1 步:harness 的本质就是干这个

回到第一章那句话:harness 是在**概率世界和确定性世界之间架桥**。模型的工具参数就是最典型的概率输出——它大概率给对,但总有时候漏个必填字段、把数字写成字符串、传错形状。harness 的三件事:

1. 把概率输出**约束**到声明的结构(schema);
2. 转换出错时**捕获**;
3. 把确定性的错误**翻译**回模型能懂的信号。

这一章就是这三步的最小实现。

### 第 2 步:一个够用就好的校验器

我们不引入完整的 JSON Schema 库——那是为通用场景准备的,我们只需要覆盖工具定义实际用到的那点:一个 object,带类型化的 properties 和一个 required 列表。

```ts
export function validateArgs(schema, args): string[] {
  if (!schema) return [];                                   // 没 schema 不校验
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return ["arguments must be a JSON object of named parameters"];
  const problems = [];
  for (const name of schema.required ?? [])                 // 必填项必须在
    if (obj[name] == null) problems.push(`missing required parameter "${name}"`);
  for (const [name, spec] of Object.entries(schema.properties ?? {}))  // 提供了的要类型对
    if (obj[name] != null && !typeMatches(obj[name], spec.type))
      problems.push(`parameter "${name}" should be ${spec.type}, got ${typeof obj[name]}`);
  return problems;                                          // 空数组 = 合规
}
```

返回**问题列表**而不是 true/false:一次性把所有毛病都告诉模型,它一轮就能全改对,不用「改一个、再被拒、再改一个」来回好几趟。

两个克制的设计:**只校验提供了的参数的类型**(没提供是 required 的事,不重复报);**没声明类型的不强求**(schema 没约束的,我们也不替它约束)。校验器宁可漏报,不可误报——误报会拦住本来合法的调用。

### 第 3 步:钉在 dispatch 这一个点上

校验放在 dispatch 里,parse JSON 之后、跑工具之前:

```ts
args = JSON.parse(argsJson);
const problems = validateArgs(tool.definition.function.parameters, args);
if (problems.length) return fail(`Invalid arguments for ${name}: ${problems.join("; ")}. Fix and call again.`);
const result = await tool.run(args, signal);
```

放这一个点上,**所有工具自动受保护**——内置的五件套、Day 15 的 MCP 工具、Day 17 的 remember,一个都不用单独写校验。这是 Day 2「dispatch 是唯一入口」、Day 15「外部工具走同一路径」一以贯之的红利:统一入口意味着新能力只加一次。

错误消息的措辞很关键:`Fix and call again`——明确告诉模型这不是死路,是让它**重试**。Day 5 的权限拒绝、Day 14 的 hook 拦截都是这个写法:错误是给模型的操作指南,不是终点。

### 第 4 步:对 MCP 工具尤其值钱

内置工具其实自己也有些检查(read_file 会查文件在不在)。但 MCP 工具(Day 15)是直接把参数转发给外部 server 的——没有这层校验,一个漏字段的调用要跑一个完整的网络往返,才换回 server 的一句报错。

而 MCP 工具的 schema 是 server 在 `tools/list` 时声明的、被我们原样存下的。所以同一个 `validateArgs`,拿 server 自己的 schema,就能在本地、送出去之前,挡下不合规的调用。**统一的校验层,自动覆盖了我们根本没专门处理的外部工具。**

## 为什么这么写

**为什么校验器要小?** 完整 JSON Schema 有几十种关键字(allOf、oneOf、pattern、minimum……),引一个库能全支持。但我们的工具 schema 只用到 type + required + properties——为没用到的 99% 付一个依赖、一份学习成本、一个新的故障面,不划算。Ch9 的判断标准:覆盖真实发生的错误,不为假想的完备性买单。模型真犯的错就是「漏必填」和「类型错」,我们就治这两个。

**为什么返回所有问题而不是第一个?** 因为每次「拒绝 + 重试」都是一轮 API 调用(花钱、花时间)。一次把三个问题全列出来,模型一轮改完;只报第一个,可能要三轮。批量反馈是对模型的尊重,也是对账单的尊重(Day 18 刚教过别浪费 token)。

**为什么宁可漏报不可误报?** 校验器的失败模式不对称:漏报(放过一个本该拦的)最多让工具自己的检查再兜一道;误报(拦住一个合法调用)会直接让模型卡死——它的参数明明对的,却被反复拒绝,无路可走。所以遇到拿不准的(没声明类型、没见过的 type),一律放行。

## 你会踩的坑

**坑 1:把可选参数当必填查。**只有 `required` 列表里的才必填,properties 里列了不等于必填。搞混了,模型每次不传可选参数都被拦,然后它会开始瞎填,更糟。

**坑 2:类型校验过严。**JSON 里没有 integer 和 number 的区别(都是 number),`null` 既可能是「没传」也可能是「传了 null」。校验器要对这些边界宽容——我们 integer 用 `Number.isInteger` 区分,null 一律当「没传」交给 required 去判。

**坑 3:校验消息含糊。**`invalid arguments` 这种话模型没法照着改。要精确到「哪个参数、期望什么、给了什么」——`parameter "count" should be number, got string`,这才是可执行的修复指引。

**坑 4:每个工具各写各的校验。**散落在五个工具里的 ad-hoc 检查,措辞不一、覆盖不全、MCP 工具还漏掉。钉在 dispatch 一个点,统一、完整、自动覆盖未来的工具。

## 小结

本章给工具调用加了一层薄薄的结构化校验:够用就好的 schema 检查、钉在 dispatch 唯一入口、批量返回精确的修复指引、自动覆盖内置和 MCP 工具。它把「模型偶尔传错参数」从「神秘崩溃」变成「自助修复」——这正是 harness「约束概率输出、捕获、翻译回信号」的最小闭环。

`npm test` 146 例,新增 16 个覆盖必填/类型/形状/边界 + dispatch 接线。真机验证:happy path 不受影响,MCP 工具的坏参数在送出前就被本地拦下。

进阶篇至此,mini-agent 的可靠性这一层也补上了——从 Day 3 的「调用层扛住失败」到本章的「工具层约束输入」,模型这个概率系统的两端都被结构兜住了。

---

*本章对应 commit:`Day 19: structured tool-call validation`(tag `day19`)*

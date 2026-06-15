# Ch33 · Markdown 即插件:Skill 系统

> 本章完整代码:`git checkout day33`。新增 `src/skills.ts`,一个 `skill` 工具,两个命令 `/skills` `/skill`。

## 这一章做完,你会得到什么

给 agent 加能力,不用改代码、不用发版——**写一个 Markdown 文件**就行。在 `.mini-agent/skills/changelog/SKILL.md` 放:

```markdown
---
name: changelog
description: Add an entry to the project changelog
when_to_use: When the user asks to record a change in CHANGELOG.md
allowed-tools: read_file, edit_file
---
1. Read CHANGELOG.md (create it if missing).
2. Add the new entry under an "## Unreleased" heading at the top.
3. Show the diff and confirm.
```

启动就看到 `(skills: 1 loaded — changelog)`。之后你说「记一条 changelog」,模型自己就会调用这个 skill、照着步骤做。`/skills` 看全部,`/skill changelog` 手动触发。**执行者是模型,不是代码**——所以加 skill 的门槛只是「会写 Markdown」。

## 跟着写

### 第 1 步:一个 skill 就是一份 SKILL.md

结构:YAML frontmatter(它是什么、何时用、用哪些工具)+ Markdown 正文(步骤)。解析是纯函数,放 `skills.ts`:

```ts
export function parseSkill(raw, fallbackName, filePath = ""): Skill {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);  // --- 之间是 frontmatter
  const fm = {}; let body = raw.trim();
  if (m) { body = m[2].trim(); for (const line of m[1].split(/\r?\n/)) { /* key: value */ } }
  return {
    name: fm.name || fallbackName,
    whenToUse: fm.when_to_use || fm.description || "",     // 触发关键词 —— 模型拿这个做匹配
    allowedTools: (fm["allowed-tools"] || "").split(",").map(s=>s.trim()).filter(Boolean),
    disableModelInvocation: /^true$/i.test(fm.disableModelInvocation || ""),
    body, path: filePath,
  };
}
```

不引 YAML 库——frontmatter 只用 `key: value` 这点子集,自己解析十几行够了(同 Day 19「够用就好」)。

### 第 2 步:渐进披露——这是 skill 系统的命门

最容易做错的地方:把所有 skill 的**完整正文**都塞进上下文。100 个 skill = 上下文爆炸。

正确做法是**渐进披露**:模型平时只看到每个 skill 的**一行简介**(名字 + 何时用),决定要用了,才加载完整正文。

```ts
export function skillListing(skills): string {
  const lines = []; let used = 0;
  for (const s of skills) {
    const line = `- ${s.name}: ${(s.whenToUse).slice(0, 250)}`;   // 每条截到 250 字
    if (used + line.length > 8000) break;                         // 总预算 8000 字
    used += line.length; lines.push(line);
  }
  return lines.join("\n");
}
```

一行简介进上下文,完整正文按需加载。一百个 skill 也只花几百字的「目录」成本。这正是 Day 6 上下文工程的延伸:**让模型知道有什么,而不是把什么都塞给它**。

### 第 3 步:把 skill 暴露成一个工具

模型怎么调用 skill?给它一个 `skill` 工具,而这个工具的**说明书就是那份简介列表**:

```ts
export function buildSkillTool(skills): Tool {
  const invokable = skills.filter(s => !s.disableModelInvocation);
  return {
    definition: { type: "function", function: {
      name: "skill",
      description: `需要做下面某个 skill 描述的事时调它,它返回步骤、你照着做。
可用 skills:
${skillListing(invokable)}
传入准确的 skill 名;没匹配的就别调。`,
      parameters: { properties: { name: { type: "string" } }, required: ["name"] },
    }},
    run: (args) => {
      const s = findSkill(skills, args.name);
      if (!s) return `[error] No skill named "${args.name}".`;
      return skillInstructions(s);   // 返回正文 → 成为模型要遵循的指令
    },
  };
}
```

模型读工具说明书时就看到了「有哪些 skill、各自何时用」;它调 `skill("changelog")`,工具返回那份正文,正文就成了模型接下来要执行的步骤。**Day 2 的 dispatch、Day 19 的校验、Day 4 的权限闸门**,skill 工具一个不少地全走——它和内置工具没有区别。

### 第 4 步:谁能触发——模型 vs 只用户

`disableModelInvocation: true` 的 skill,模型**看不到、调不了**,只有用户能 `/skill <name>` 手动触发。给「危险或高成本」的 skill 用(比如「部署到生产」):

```ts
const invokable = skills.filter(s => !s.disableModelInvocation);  // 只把这些放进 skill 工具
if (skills.some(s => !s.disableModelInvocation)) registerExternalTool(buildSkillTool(skills));
```

`/skills` 列出全部(标注 `[model+user]` 或 `[user-only]`);`/skill deploy` 把正文作为一个用户回合注入、让模型执行——**用户显式发起的,即使是 user-only 的也能跑**。

### 第 5 步:权限——加载免费,执行照常

`skill` 工具在权限层判 `allow`:

```ts
case "skill":
  return { decision: "allow", reason: "loads instructions, no side effects", summary: "skill" };
```

为什么免费?因为加载 skill 只是**取回一段文字**,没有任何副作用。skill 正文里让模型干的活(读文件、跑命令),**每一步仍旧逐个过 Day 4 的权限闸门**。所以 `allowed-tools` 在这里是「建议性」的——真正的强制还是那一个闸门。加载是自由的,行动是受管的。

## 为什么这么写

**为什么执行者是模型,不是代码?** 因为这把「扩展能力」的门槛从「会写 TypeScript + 发版」降到「会写 Markdown + 存盘即生效」。skill 不是一段要编译的程序,是一份写给模型看的**工作说明**。代码擅长确定性操作(那些写进 `scripts/`),模型擅长照着自然语言步骤灵活执行——skill 把后者标准化、复用化。

**为什么 skill 工具的说明书就是那份列表?** 因为模型「知道有哪些 skill」和「知道每个工具能干嘛」是同一回事——都靠工具说明书。把 skill 列表放进 `skill` 工具的 description,模型在决定调哪个工具时,自然就把「要不要用某个 skill」一起考虑了。不用额外往 system prompt 里塞,也不破坏缓存前缀(Day 18)。

**为什么要 user-only 这一档?** 因为不是所有能力都该让模型自主触发。「部署生产」「删数据库快照」这种,你希望**永远是人按下按钮**。`disableModelInvocation` 把它从模型的视野里彻底拿掉——模型连「存在这个 skill」都不知道,自然不会去碰。最小权限,从「看不见」开始。

## 你会踩的坑

**坑 1:把所有 skill 正文全塞进上下文。** 一两个没事,几十个就把窗口吃光、还污染缓存。渐进披露:列表进上下文(一行),正文按需加载。

**坑 2:`when_to_use` 写得太泛或太专。** 它是模型的**触发依据**。写「处理文件」太泛(什么都想触发);写「运行 changelog skill」太专(用户不会这么说)。要写「用户真实会说的话」——「记一条更新日志 / 加 changelog」。这点书里(§18.2)专门强调:trigger 要用用户的话,不是「请运行 X」。

**坑 3:以为 `allowed-tools` 是强制沙箱。** 在这个最小实现里它是建议性的——真正拦住危险操作的还是 Day 4 的权限闸门。别因为 skill 写了 `allowed-tools: Read` 就以为它绝对不会写文件;写文件那一步照样会弹审批。

**坑 4:危险 skill 忘了设 user-only。** 一个「重置数据库」的 skill 如果模型能自调,某次它「觉得该重置一下」就触发了。高成本/不可逆的 skill,`disableModelInvocation: true` 是默认该有的护栏。

## 小结

本章给 agent 加了 Skill 系统:一份 `SKILL.md`(frontmatter + Markdown)就是一个插件,执行者是模型;渐进披露让一百个 skill 也只花一份「目录」的上下文;`skill` 工具把列表当说明书暴露给模型,正文按需加载;`disableModelInvocation` 区分模型可调与仅用户;加载免费、执行仍受权限闸门管。`/skills` 看列表,`/skill <name>` 手动触发。

`npm test` 360 例,新增 ~22:frontmatter 解析(含默认值/缺失)、目录发现(跳过非 skill 目录)、渐进披露列表只含简介不含正文、user-only 不进模型工具、未知/拒绝的处理。

它补上了手册 §18 的核心:**给 agent 加能力,从「改代码发版」降级成「写个 Markdown 存盘」。** 这是 Claude Code 一个标志性的扩展点,也是 mini-agent 从「能用」走向「可生长」的一步。

---

*本章对应 commit:`Day 33: Markdown-as-plugin skill system`(tag `day33`)*

# Ch31 · 中途换模型:/model 选择器

> 本章完整代码:`git checkout day31`。把 Day 12 只会「显示」的 `/model` 升级成「能切换」,复用 Day 29 的选择菜单。

## 这一章做完,你会得到什么

以前 `/model` 只告诉你现在用的哪个模型。现在它能**当场换**——一个端点上有几个模型(DeepSeek 的 `deepseek-chat`、`deepseek-reasoner`……),列出来选一个:

```
❯ /model
model: deepseek-chat
endpoint: https://api.deepseek.com
switch model:
❯ 1. deepseek-chat  (current)
  2. deepseek-reasoner
↑↓ to move · Enter to select · Esc to cancel
```

或者直接指定:`/model deepseek-reasoner`。换完下一轮就生效,不用退出重开。

## 跟着写

### 第 1 步:模型列表从哪来

不写死。OpenAI 兼容的端点都有一个标准接口 `GET /models`,SDK 封装成 `client.models.list()`。问端点它自己有哪些模型:

```ts
const listModels = async (): Promise<string[]> => {
  try {
    const page = await client.models.list();
    const ids = (page.data ?? []).map(m => m.id).filter(Boolean);
    return [...new Set(ids)].sort();
  } catch {
    return [];   // 端点没实现这个接口,或网络挂了 —— 返回空,绝不让命令崩
  }
};
```

为什么不硬编码一份 DeepSeek 模型清单?因为这个 agent 从 Day 10 起就是**任意端点可配**的——硬编码 DeepSeek 的列表,换到别的端点(OpenAI、本地 Ollama、任意兼容服务)就错了。问端点自己,谁来都对。失败就返回空列表,降级到「请用 `/model <名字>` 切换」,不阻断。

### 第 2 步:`/model` 要带参数,得在 switch 之前拦

slash 命令原来是按整行精确匹配的(`switch (line)`)。但 `/model deepseek-reasoner` 带了参数,精确匹配接不住。所以在 switch 之前先拦一道:

```ts
if (line === "/model" || line.startsWith("/model ")) {
  await handleModelCommand(line.slice("/model".length).trim());  // 把 /model 后面的部分当参数
  return true;
}
```

`handleModelCommand` 分两路:有参数就直接设,没参数就列出来选。

### 第 3 步:有参数直接设,没参数弹选择器

```ts
const handleModelCommand = async (arg) => {
  if (arg) {                                  // /model <name>
    const prev = CONFIG.model;
    CONFIG.model = arg;                        // 任意字符串都收 —— 错的名字 API 会报错,错误层会接
    console.log(`(model: ${prev} → ${arg})`);
    return;
  }
  // 裸 /model:先显示现状
  console.log(`model: ${CONFIG.model}\nendpoint: ${CONFIG.baseURL}\n...`);
  if (!process.stdin.isTTY) return;            // 非交互没法弹菜单,提示用 /model <name>
  const models = await listModels();
  if (!models.length) { console.log("(列不出来,用 /model <name> 切)"); return; }
  const choice = await promptSelect(rl, formatModelChoices(models, CONFIG.model));  // 复用 Day 29 菜单
  if (choice < 0 || models[choice] === CONFIG.model) { console.log("(unchanged)"); return; }
  CONFIG.model = models[choice];
};
```

`formatModelChoices` 是个纯函数,把当前用的那个标上 `(current)`:

```ts
export function formatModelChoices(models, current): string[] {
  return models.map(m => (m === current ? `${m}  (current)` : m));
}
```

选择那一步,**直接拿 Day 29 写好的 `promptSelect`**——↑↓ 选、回车定、Esc 取消,一行都不用重写。前面攒的轮子,这里白捡。

### 第 4 步:为什么改 `CONFIG.model` 就生效了

切换的核心其实只有一行:`CONFIG.model = 新模型`。它能立刻生效,靠的是 REPL 主循环**每一轮都重新读** `CONFIG.model`:

```ts
const result = await runLoop(messages, {
  model: CONFIG.model,   // ← 在 while 循环体里,每轮重新求值
  // ...
});
```

`CONFIG` 是个模块级的可变对象,主循环每轮把 `CONFIG.model` 现读现传。所以你这轮用 `/model` 改了,下一轮 `runLoop` 自然拿到新值。没有什么「重新初始化」,就是改一个字段、下轮读到。**可变配置 + 每轮重读 = 免费的运行时切换。**

## 为什么这么写

**为什么参数那路不校验模型名?** 因为「这个端点到底有哪些模型」只有端点知道,而且会变。我们与其维护一份必然过时的白名单,不如**信任用户 + 信任错误层**:你打什么我设什么,真要是个不存在的模型,下一次 API 调用会返回错误,Day 3 的错误分类和重试/熔断会把它变成一句人话提示,而不是崩溃。把校验交给真正的权威(API),比自己猜一份清单可靠。

**为什么选择器和直接设两种都留?** 因为场景不同。`/model` 列表选,适合「我忘了这端点有啥,看看再挑」;`/model <name>` 直接设,适合「我清楚要哪个,别让我翻菜单」、以及脚本/非交互环境(那里没法弹菜单)。一个给探索,一个给笃定,成本都很低,没必要二选一。

**换成不支持工具调用的模型会怎样?** 比如某些推理特化模型不支持 function calling。换过去之后,模型一调工具就会失败——但这不是这章的 bug,是那个模型的能力边界。错误会照常被 Day 3 的层接住、报出来,你看到后再 `/model` 换回来即可。我们不替用户拦这个:它的机器、它的端点、它的选择。

## 你会踩的坑

**坑 1:硬编码模型清单。** 写死一份 DeepSeek 模型名,换端点就全错。问 `client.models.list()`,让端点自报家门。

**坑 2:`/model <name>` 接不住,因为按整行匹配。** 带参数的命令必须在精确匹配的 `switch` 之前单独拦,否则 `/model foo` 会被当成「未知命令」。

**坑 3:以为切换需要重启。** 不需要。`CONFIG.model` 是可变的,主循环每轮重读——改完下一轮就用上了。前提是 `runLoop` 的 `model` 参数在循环体里现读 `CONFIG.model`,而不是开局存一个快照。

**坑 4:列模型失败就让命令崩。** 不是每个端点都实现 `/models`,网络也会抖。`listModels` 整个包在 try/catch 里、失败返回空数组、降级到「用 `/model <name>`」——一个辅助功能不该把 REPL 拖垮。

## 小结

本章把 `/model` 从「只读显示」升级成「能切换」:`/model <name>` 直接设,裸 `/model` 从端点的 `/models` 接口拉取模型列表、用 Day 29 的菜单选一个;切换只是改 `CONFIG.model` 一个字段,靠主循环每轮重读立刻生效。

`npm test` 314 例,新增 5 个:`formatModelChoices` 标注当前、未命中不标、空列表(菜单交互本身由 Day 29 的测试覆盖)。

它是「攒下的轮子开始复利」的又一例:模型早在 Day 10 就可配,菜单在 Day 29 就写好,这一章只是把两者接起来——**好的地基,让新功能是拼装,不是从头造。**

---

*本章对应 commit:`Day 31: /model runtime switching`(tag `day31`)*

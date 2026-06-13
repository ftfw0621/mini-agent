# Ch13 · 别冻住:把工具执行改成全异步

> 本章完整代码:`git checkout day13`。改 `tools.ts`(run_bash 换 spawn,dispatch 变 async)和 `loop.ts`(只读工具并行)。

## 这一章做完,你会得到什么

一个一直被我们用 `execSync` 糊着的隐患,今天补上:

- **慢命令不再冻住 UI**:`npm test` 跑 10 秒,spinner 照转,Ctrl+C 立刻有反应——以前整个进程(包括信号处理器)都被 execSync 焊死,只能干等
- **Ctrl+C 真的杀得掉命令**:不用等它跑满 30 秒超时
- **超长输出落盘**:`yes | head -n 100000` 不再把上下文撑爆,而是给模型一段预览 + 文件路径,它想看再 read_file
- **只读工具并行**:模型一轮里要读 3 个文件,3 次 read 并发跑,不再排队

## 跟着写

### 第 1 步:execSync → spawn,run 变 async

`execSync` 的问题在名字里:**Sync**。它会阻塞整个 Node 事件循环直到命令返回——spinner 停转、Ctrl+C 不响应、什么都干不了。换成 `spawn`,包一个 Promise:

```ts
run: (args, signal) =>
  new Promise<string>((resolve) => {
    const child = spawn(args.command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const done = (text: string) => { if (!settled) { settled = true; clearTimeout(timer); resolve(text); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(fail("timed out...")); }, 30_000);
    signal?.addEventListener("abort", () => { child.kill("SIGKILL"); done(fail("interrupted by the user.")); });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => code === 0 ? done(stdout) : done(fail(`exited with code ${code}...`)));
  }),
```

三个工业级细节挤在这一小段里:

- **`settled` 守卫**:超时、正常退出、被 abort 三件事可能赛跑,Promise 只能 resolve 一次。
- **超时 SIGKILL**:命令卡死也绝不挂起 agent。
- **signal 接进来**:Ctrl+C 的 AbortSignal 一路从 agent.ts 传到这里,abort 直接杀子进程——不再等 30 秒。

接口也跟着变:`Tool.run` 现在可以返回 `string | Promise<string>`,可以接 `signal`。同步工具(read/edit/search)原样不动,`await` 对它们是无害的。

### 第 2 步:dispatch 变 async

```ts
export async function dispatch(name, argsJson, signal?): Promise<string> {
  // ...
  const result = await tool.run(args, signal); // await 同时覆盖同步和异步工具
  return result.slice(0, cap);
}
```

一处坑提前说:超长输出落盘的「提示语」放在结果**末尾**,而 dispatch 最后还有一刀 `slice(0, cap)`——如果 cap 比预览还小,这一刀会把提示语连同文件路径一起切掉,spill 文件写了模型却不知道。所以 run_bash 的 cap 要单独留出提示语的空间(我们留了 400 字符 slack)。**两个独立的截断逻辑叠在一起,是隐蔽 bug 的温床**——写本章时就踩了。

### 第 3 步:超长输出落盘,不静默截断

```ts
function spillIfHuge(out: string, what: string): string {
  if (out.length <= BASH_OUTPUT_LIMIT) return out; // 装得下就原样
  const file = path.join(os.tmpdir(), `mini-agent-output-${Date.now()}.txt`);
  fs.writeFileSync(file, out, "utf8"); // 全量进磁盘
  return `${out.slice(0, BASH_OUTPUT_LIMIT)}\n\n[...truncated: ${out.length} chars total. Full output saved to ${file} — use read_file to inspect more.]`;
}
```

关键是**给模型一个出口**,而不是替它决定。预览 + 总量 + 文件路径,它自己判断要不要深入读。Ch9 提过 Claude Code 的「告知 ≠ 行动」短板——模型可能就基于预览判断了不去读完整的,所以预览要给得够、提示要写明白。

### 第 4 步:只读工具并行(loop.ts)

模型一轮里发了 `[read A][read B][search C][edit D]`,前三个是只读的,可以一起跑;edit 必须单独、按顺序。贪心分批:

```ts
while (i < calls.length) {
  const batch = [];
  while (i < calls.length && isReadOnlyTool(calls[i].name)) batch.push(calls[i++]); // 攒一批只读的
  if (batch.length) {
    const results = await Promise.all(batch.map((c) => runOneCall(c, opts))); // 并发
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    continue;
  }
  const r = await runOneCall(calls[i++], opts); // 单个写/执行操作:独跑
  messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
}
```

为什么只读才并行?两条理由:① 只读操作之间不会互相踩(不改文件、不执行);② 它们的权限判定只会是 allow/deny,**永远不会 ask**——而「问人」一次只能问一个,不能并发弹两个确认框。写操作和 bash 全部串行,顺序执行。结果顺序用 `Promise.all` 天然保持,塞回历史时 tool_call_id 一一对应。

## 为什么这么写

**为什么这是工业级的硬门槛?** 一个会冻住的 CLI 不能用。用户跑 `mini-agent` 让它「跑一下测试套件」,如果 30 秒里终端完全没反应、Ctrl+C 也按不动,他下次就不敢交给它任何耗时的活了。响应性不是体验优化,是「敢不敢用」的开关。

**为什么并行只读、串行写?** 这是 Claude Code 的「贪心分批」策略的最小版:安全的事尽量并行省时间,有风险的事老老实实排队。判断「安全」的标准是**输入感知**——同一个工具,不同参数危险度不同(Ch5 讲过 bash),这里是不同工具按读/写分类。读多写少的真实任务(「看懂这个模块」要读一堆文件),并行省的时间很可观。

## 你会踩的坑

**坑 1:execSync 的 Sync 是真的 Sync。**它阻塞的不只是「这个命令」,是整个事件循环——你的 spinner、你的 SIGINT 处理器、你的看门狗定时器,全部停摆。换 spawn 不是优化,是修 bug。

**坑 2:Promise resolve 两次。**超时 / 正常退出 / abort 三路赛跑,不加 `settled` 守卫,你会 resolve 多次——后面的被静默忽略,但状态会错乱。任何「多个事件源 + 单次结果」的地方都要这个守卫。

**坑 3:两层截断打架。**run_bash 自己截一次、dispatch 再截一次,后者把前者的「文件在哪」提示吃掉。两个独立的 limit 叠在一条数据上,务必让里层的关键信息(文件路径)在外层 cap 之内。

**坑 4:并行了会 ask 的工具。**如果手滑把 edit/bash 也放进并发批次,两个确认框会同时弹出来抢同一个 stdin,直接乱套。并发的前提是「绝不会问人」,只读工具才满足。

## 小结

本章把执行层从「同步、会冻、杀不掉、撑爆上下文」改成「异步、不冻、Ctrl+C 秒杀、超长落盘」,外加只读工具并行。测试从 60 涨到 65——新增的 5 个全是 run_bash 的异步行为(返回、报错、落盘、abort、不阻塞事件循环)。

下一章(Ch14)做扩展性的地基:Hook 生命周期——让用户用一个外部脚本在工具执行前后插一脚,`exit 2` 拦截还能把理由喂回给模型。这是「把核心做精、业务靠外挂」的工业级架构。

---

*本章对应 commit:`Day 13: async tool execution`(tag `day13`)*

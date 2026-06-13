# Ch15 · 借来的工具:接入 MCP 生态

> 本章完整代码:`git checkout day15`。新增 `src/mcp.ts`,`tools.ts` 的工具注册表改成可动态扩展。

## 这一章做完,你会得到什么

`.mini-agent/settings.json` 里加几行,你的 agent 就长出别人写好的工具:

```json
{ "mcpServers": {
  "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] }
}}
```

启动时:

```
(mcp: fs — 14 tools)
> 用 mcp 的工具看看这个目录有什么
🔧 mcp__fs__list_directory {"path": "/path"}
⚠️ approval needed — mcp__fs__list_directory (external MCP tool)
  Allow? [y/N] y
🤖 这个目录里有 ...
```

14 个文件系统工具,我们一行没写——全是官方 MCP server 提供的。同理还有 GitHub、数据库、浏览器……整个 MCP 生态,接进来就能用。

## 跟着写

### 第 1 步:MCP 是什么,为什么是 stdio + JSON-RPC

MCP(Model Context Protocol)是一个开放协议:**让 agent 借用外部 server 提供的工具**。一个 server 是一个独立进程,你 spawn 它,通过 **JSON-RPC 2.0 over stdio** 跟它对话——每条消息是一行 JSON,不含内嵌换行。

为什么是这套老掉牙的传输?和 Ch14 的 hook 同一个理由:**通用**。stdio + JSON-RPC 任何语言都能实现,所以 MCP server 可以用 Python、Go、Rust、TS 任意写,你的 agent 一律 spawn + 喂 JSON。生态能起来,靠的就是传输层零门槛。

### 第 2 步:握手三步走

MCP 的启动舞步是固定的:

```ts
async start() {
  const init = await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {...} });
  this.notify("notifications/initialized", {}); // "我准备好了"
  const list = await this.request("tools/list", {}); // "你有啥工具?"
  return list.result.tools;
}
```

`initialize` 是请求(要回复),`notifications/initialized` 是通知(不要回复,没有 id)——**这个区别搞错,server 会一直等一个永远不来的响应,或者你的客户端会等一个永远不来的回复**。JSON-RPC 里有 id 的是请求,没 id 的是通知。

### 第 3 步:行缓冲——stdio 的经典坑

stdout 是字节流,不保证一次 `data` 事件就是一条完整消息——可能半条、可能两条半。必须自己按换行重组:

```ts
this.child.stdout.on("data", (chunk) => {
  this.buffer += chunk.toString();
  let nl;
  while ((nl = this.buffer.indexOf("\n")) >= 0) {
    const line = this.buffer.slice(0, nl).trim(); // 一条完整消息
    this.buffer = this.buffer.slice(nl + 1);      // 剩下的留着
    if (line) this.onMessage(line);
  }
});
```

一个 `buffer` 累积、按 `\n` 切、剩余留到下次——这是所有基于行的协议(MCP、LSP 简化版、很多 daemon)的通用骨架。新手最常见的 bug 是假设「一次 data = 一条消息」,在小消息时碰巧能跑,数据一大就随机崩。

### 第 4 步:请求/响应靠 id 配对

异步协议里,响应回来的顺序不保证和请求一致,所以靠 id 配对:

```ts
request(method, params, timeoutMs) {
  const id = this.nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ id, error: { message: "timed out" } }), timeoutMs);
    this.pending.set(id, finish); // 记下「谁在等这个 id」
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
```

`pending` 是个 `Map<id, resolver>`,响应到了就 `pending.get(msg.id)` 找到对应的 Promise 兑现。又是 Day 13/14 那套:超时兜底、settled 守卫(这里用 `pending.delete` 保证只兑现一次)。**任何「发出去等回来」的异步通信都长这个样子。**

### 第 5 步:注册成「和内置工具没区别」

这是全章最关键的设计决定。发现的工具，命名成 `mcp__<server>__<tool>`，然后塞进**同一个工具注册表**:

```ts
registerExternalTool({
  definition: { type: "function", function: { name: `mcp__${serverName}__${spec.name}`, description: `[MCP:${serverName}] ${spec.description}`, parameters: spec.inputSchema } },
  run: async (args) => client.callTool(spec.name, args),
});
```

为此 `toolDefinitions` 从常量改成了函数(MCP 工具在模块加载后才注册,列表必须现算)。注册之后,MCP 工具走的是**和 read_file 完全相同的路径**:同一个 dispatch、同一道权限闸门、同一份发给模型的工具清单。系统里只有一条执行路径,不管工具来自哪里——这是干净架构的标志。

命名加 `mcp__server__` 前缀有两个作用:① 永不和内置工具撞名;② 用户一眼看出每个工具的来历,能精确地在 settings 里 `tool:mcp__fs__write_file` 单独授权或拦截。

### 第 6 步:权限——外部工具默认 ask

权限闸门的 default 分支天然兜住了 MCP 工具:不认识的工具一律 `ask`。但 MCP 工具尤其要谨慎——它们是**别人的代码**,跑在你机器上。所以:默认每次问;信任的可以 `tool:mcp__fs__read_file` 进 allow 免确认;不放心的 `tool:...` 进 deny 直接拦死(deny 永远赢,Ch5 的老规矩对 MCP 工具一样生效)。

## 为什么这么写

**为什么 MCP 是工业级 agent 的标配?** 2026 年,你不可能为每个数据源、每个 SaaS、每个内部系统都手写工具。MCP 把「给 agent 加能力」从「改 agent 源码」变成「连一个 server」——生态里已经有几百个现成 server。一个不支持 MCP 的 agent,在今天等于一个不支持插件的浏览器。

**为什么外部工具也走同一道权限闸门?** 因为安全不能有例外。MCP server 是第三方代码,如果它的工具能绕过权限直接执行,那等于开了个后门。让它和内置工具走完全相同的 dispatch + 闸门,意味着 Ch5 建立的所有保护(ask/deny/fail closed)对 MCP 工具自动生效,一行特殊处理都不用写。**统一执行路径,是安全可审计的前提。**

**为什么 server 启动失败不致命?** 你配了 5 个 MCP server,其中一个今天挂了——agent 应该带着另外 4 个正常工作,而不是整个起不来。每个 server 的连接被独立的 try/catch 包住,失败的记日志、跳过,绝不连累别人。这是 Ch7「子 agent 隔离」「一个工具失败不连坐」在进程级的延续。

## 你会踩的坑

**坑 1:把 data 事件当成完整消息。**小消息时碰巧每次 data 就是一条,你以为对了;server 一次吐两条、或一条被拆成两个 chunk,立刻随机崩。行缓冲不是优化,是正确性。

**坑 2:initialize 和 initialized 不分。**前者是请求等回复,后者是通知不等回复。搞混了握手就卡死——而且卡得很安静,你只看到 agent 启动时干等。

**坑 3:MCP 工具不进权限闸门。**「它是官方 server,应该安全吧」——这种想当然就是后门的来源。第三方代码默认 ask,信任要显式声明,不能假设。

**坑 4:server 子进程泄漏。**spawn 了不 kill,退出时一堆 MCP server 进程留在后台。我们在 `process.on("exit")` 里统一 kill。任何 spawn 长生命周期子进程的地方,都要配对清理。

## 小结

本章让 mini-agent 接入了整个 MCP 生态:一个 stdio JSON-RPC 客户端(握手 / 行缓冲 / id 配对 / 超时),把外部 server 的工具注册成和内置工具无差别的存在——同一 dispatch、同一权限闸门、同一份工具清单。`npm test` 84 例,新增的 8 个用 mock MCP server 端到端验证了发现、命名、schema 透传、权限三态、真实调用。

到这里,mini-agent 不只是工业级 CLI,还是一个**可以站在生态肩膀上**的 agent。它仍然每行你都看得懂——MCP 客户端总共也就一百多行。

---

*本章对应 commit:`Day 15: MCP client — borrow tools from the ecosystem`(tag `day15`)*

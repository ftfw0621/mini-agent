# Ch24 · 同一个协议,两根管子:远程 MCP(HTTP/SSE)

> 本章完整代码:`git checkout day24`。把 Day 15 的 stdio 客户端重构出一个 Transport 接口,再加一个 HTTP 传输。

## 这一章做完,你会得到什么

Day 15 接的 MCP 服务器都得在**本地**用子进程跑。这一章让你接**远程**服务器——配一个 URL 就行:

```json
// .mini-agent/settings.json
{
  "mcpServers": {
    "github": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer xxx" } },
    "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
  }
}
```

`github` 走 HTTP,`fs` 还是老的 stdio 子进程。两种服务器发现出来的工具,在模型眼里、在权限闸门眼里,**完全一样**——都是 `mcp__<server>__<tool>`,走同一个 dispatch。换了根管子,上面的一切不用动。

## 跟着写

### 第 1 步:先认清「协议」和「管子」是两回事

回看 Day 15 的 `McpClient`,它其实在干两件混在一起的事:

1. **协议**:管理 JSON-RPC 的 id、走 initialize→initialized→tools/list 的握手、把工具结果拍平成文本;
2. **传输**:把一行 JSON 写进子进程的 stdin、从 stdout 读回来。

远程 MCP 用的是同一套 JSON-RPC 协议——只是不再走 stdin/stdout,而是 POST 到一个 URL。所以这一章的全部功夫,就是**把「传输」从「协议」里剥出来**,让协议层对「底下是子进程还是 HTTP」一无所知。

### 第 2 步:一个 Transport 接口

把「怎么把消息送出去、怎么拿回响应」抽象成三个方法:

```ts
interface Transport {
  request(payload: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse>; // 发一个请求,等它的响应
  notify(method: string, params: object): void;                                  // 发一个通知,不等回应
  close(): void;                                                                 // 释放资源(子进程 / 会话)
}
```

`McpClient` 缩水成纯协议层,只持有一个 `transport`:

```ts
class McpClient {
  private transport: Transport;
  private nextId = 1;
  constructor(def: McpServerDef) { this.transport = makeTransport(def); } // url → HTTP,否则 stdio

  private request(method, params, timeout) {
    return this.transport.request({ jsonrpc: "2.0", id: this.nextId++, method, params }, timeout);
  }
  // start() / callTool() 一字未改——它们只调 this.request,不关心底下是什么管子
}
```

Day 15 的握手、namespacing、结果拍平,**一行都没动**。这就是抽象对的标志:加一种全新的传输,上层逻辑零改动。

### 第 3 步:stdio 传输 = 原来那套,搬个家

`StdioTransport` 就是把 Day 15 里 spawn 子进程、按行重组 stdout、用 id 匹配 pending 的那堆代码,原样挪进来,实现 `Transport` 三方法。逻辑没变,只是从「`McpClient` 的私有字段」变成「一个可替换的传输」。stdio 测试(Day 15 那套)继续绿,就是它没被改坏的证明。

### 第 4 步:HTTP 传输——POST 出去,JSON 或 SSE 回来

`HttpTransport` 是新的。MCP 的远程传输叫 **Streamable HTTP**,有两个要点:

**(1) 响应可能是 JSON,也可能是 SSE。** 你 POST 一个 JSON-RPC 请求,服务器要么直接回一个 `application/json`,要么回一个 `text/event-stream`(SSE,流式)。两种都要能接:

```ts
private async post(body, timeoutMs, isRequest) {
  const res = await fetch(this.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
               ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}), ...this.headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),       // 超时即弃,不挂死
  });
  if (!isRequest) return null;                     // 通知没有响应体(202)
  const raw = await res.text();
  const payloads = res.headers.get("content-type")?.includes("text/event-stream")
    ? parseSseData(raw)                            // SSE:从 data: 行里抠出 JSON
    : [raw];                                       // 普通 JSON:整个就是一条
  for (const p of payloads) {
    const msg = JSON.parse(p);
    if (msg.result !== undefined || msg.error !== undefined) return msg; // 我们要的那条响应
  }
  return null;
}
```

SSE 的解析单拎成一个纯函数 `parseSseData`——SSE 帧之间用空行分隔,负载在 `data:` 行上。这是最容易写错的一段,所以让它能被单独测:

```ts
export function parseSseData(body: string): string[] {
  const out = [];
  for (const frame of body.split(/\r?\n\r?\n/))                  // 帧 = 用空行分隔
    { const data = frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n");
      if (data) out.push(data); }
  return out;
}
```

**(2) 会话 id。** 服务器在 initialize 的响应头里塞一个 `Mcp-Session-Id`,之后**每个请求都要回带**它——这是远程服务器区分「哪个客户端」的凭据。我们收到就存,发请求就带:

```ts
const sid = res.headers.get("mcp-session-id");
if (sid) this.sessionId = sid;     // 握手时领到,后续每次请求回带
```

### 第 5 步:用一个 url 字段二选一

配置里 `url` 在就走 HTTP,不在就 spawn:

```ts
function makeTransport(def: McpServerDef): Transport {
  return def.url ? new HttpTransport(def) : new StdioTransport(def);
}
```

`connectMcpServers` 那个「发现工具→注册→失败隔离」的外壳,**完全没变**——它拿到的是 `McpClient`,根本不知道底下换了管子。又一次:抽象对了,边界之外零改动。

### 第 6 步:怎么测一个远程服务器?

总不能依赖一个真的线上 MCP 服务器来跑测试。办法是在测试里**临时起一个 HTTP 服务器**,用 SSE 应答,而且故意要求回带会话 id:

```ts
const server = http.createServer((req, res) => { /* initialize 时下发 session-id;
  tools/call 时检查 header 里的 session-id,不对就报错;都用 SSE 应答 */ });
await new Promise(r => server.listen(0, "127.0.0.1", r));   // 随机端口
CONFIG.mcpServers = { calc: { url: `http://127.0.0.1:${port}/mcp` } };

const result = await dispatch("mcp__calc__add", JSON.stringify({ a: 17, b: 25 }));
// → "42":传输、SSE 解析、会话 id 回带,三件事一次性全验证
```

服务器在 `tools/call` 时检查 `Mcp-Session-Id` 对不对——所以这条 `42` 通过,等于**证明了客户端确实把握手时领到的会话 id 回带了**。一个端到端测试,把三件容易错的事(走通 HTTP、解析 SSE、回带会话)全焊死。这沿用了 Day 23 假 client 的思路:不联外网,却把真实路径完整跑一遍。

## 为什么这么写

**为什么先重构、再加功能?** 因为直接复制一份 `McpClient` 改成 HTTP 版,握手和 namespacing 就有了两份,以后改一处忘另一处。先把「传输」剥成接口,新增 HTTP 就只是加一个实现类,协议层一行不动——加法,而不是复制。重构不是洁癖,是给新功能腾出一个干净的接口。

**为什么 stdio 和 HTTP 的 request 形状不同,却能塞进一个接口?** stdio 是「写出去,响应过会儿从同一根流上按 id 飘回来」,HTTP 是「POST 出去,响应就是这次 POST 的返回」。看着不一样,但对上层只需要一个承诺:`request(payload) → Promise<response>`。两种传输各自用自己的方式兑现这个承诺(stdio 靠 pending map 按 id 匹配,HTTP 靠 await fetch),接口把差异吃掉了。**接口约的是「兑现什么」,不是「怎么兑现」。**

**为什么 SSE 解析要单拎成纯函数?** 因为它是这章最容易出错的地方(帧分隔、`data:` 前缀、多行 data),而它本身不需要网络——给一段字符串、要一组 JSON,纯函数。拎出来就能脱离 HTTP 直接喂各种刁钻输入测它。和 Day 16/19/23 把易错的纯逻辑拎出来单测,是同一个习惯。

## 你会踩的坑

**坑 1:不回带会话 id。** 远程服务器靠 `Mcp-Session-Id` 认客户端。initialize 领了不存、或后续请求不带,服务器要么不认你、要么把你当新连接,tools/call 直接失败。握手领到的东西,后面每次都得带上。

**坑 2:只认 JSON,不认 SSE(或反过来)。** 同一个服务器,initialize 可能回 JSON、tools/call 可能回 SSE,取决于它心情和实现。`Accept` 头两个都报、响应按 `Content-Type` 分流——少认一种,就会在某台服务器上莫名其妙解析失败。

**坑 3:HTTP 请求不设超时。** 远程服务器会卡、会黑洞。`AbortSignal.timeout` 一定要带,否则一个不响应的服务器能把整个 agent 挂死——这正是 stdio 版里那个 15 秒超时在远程世界的等价物。

**坑 4:把通知也当请求等响应。** `notifications/initialized` 是通知,服务器回 202、没有 body。要是傻等一个 JSON-RPC 响应,就永远等不到。请求和通知,POST 完的处理方式不一样。

## 小结

本章把 MCP 客户端的「传输」从「协议」里剥出来,做成一个 Transport 接口:stdio 是原来那套搬了家,HTTP 是新写的——POST 出去、按 `Content-Type` 分 JSON / SSE 解析、回带会话 id。配置里一个 `url` 字段决定走哪根管子,而发现、注册、权限、dispatch 这些上层逻辑一行没改。

`npm test` 218 例,新增 6 个:`parseSseData` 的几种帧形状,加一个临时 HTTP 服务器跑通的端到端远程调用(顺带验证会话 id 真的回带了)。stdio 的老测试继续全绿,证明重构没动坏旧路径。

它把 Day 15 的「借来的工具」推到了云端:**同一套协议、同一个权限闸门、同一个 dispatch,工具在你机器上还是在地球另一端,对 agent 来说没有区别。**

---

*本章对应 commit:`Day 24: remote MCP over HTTP/SSE`(tag `day24`)*

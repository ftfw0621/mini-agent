# Ch12 · 记得住自己干过什么:会话持久化与本地遥测

> 本章完整代码:`git checkout day12`。新增 `src/session.ts`、`src/telemetry.ts`,各自接进 `agent.ts` 和 `loop.ts`。

## 这一章做完,你会得到什么

关掉再打开,对话还在:

```
$ mini-agent
> 记住暗号是 PERSIST-42
🤖 PERSIST-42 acknowledged.
> exit

$ mini-agent -r              ← --resume
(resumed session ... — 2 messages; files must be re-read before editing)
> 暗号是什么?
🤖 PERSIST-42                ← 跨进程记住了
```

以及一份只在本机的运行账本:

```
> /stats
events this session:
      2  agent_api_call
      1  agent_tool_call:run_bash
      1  agent_session_start
full log: .mini-agent/telemetry.jsonl (local only — nothing leaves this machine)
```

## 跟着写:会话持久化

### 第 1 步:快照,不是日志

每轮结束把整个对话写进 `.mini-agent/sessions/<id>.json`。注意是**全量快照**,不是 append-only 日志——因为历史不是只增的,**压缩会重写它**(Ch6)。append 一个被压缩过的历史,你会存下自相矛盾的东西。快照是唯一始终正确的表示。

```ts
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(data)); // 写到临时文件
fs.renameSync(tmp, file);                    // 原子改名换上去
```

**写临时文件再 rename**:同一文件系统上 rename 是原子的,写一半崩溃,旧快照原封不动。这是「工业级」和「demo」的一条分界——demo 直接 `writeFileSync(file)`,崩在中间就留下半个损坏的 JSON。

### 第 2 步:存什么,不存什么

```ts
messages: messages.filter((m) => m.role !== "system"), // 丢掉宪法
```

**系统消息不存**。resume 时重新 `buildSystemMessage()` 生成——因为 AGENT.md 可能在两次会话之间改了,存旧的宪法等于把过期规则带回来。这呼应 Ch6 压缩时「保住 system 消息」的另一面:system 消息永远是当下重建的,不是历史的一部分。

会话是**项目级**的(存在 cwd 下),不是全局的:一段对话是关于一个代码库的,在项目 B 里 resume 项目 A 的重构毫无意义。

### 第 3 步:resume 的两个诚实

```ts
if (prev) {
  messages.push(...prev.messages);
  console.log(`(resumed ... files must be re-read before editing)`);
} else {
  console.log("(no previous session here — starting fresh)"); // 不是错误
}
```

一是**文件读取状态不跨进程恢复**——上次会话「读过」cart.js,这个新进程的内存里没有这件事,所以提示里明说「编辑前要重读」。这是 Ch2「编辑前必须先读」在持久化场景下的正确行为:宁可让模型多读一次,绝不让它基于一个新进程从没见过的内容去改文件。二是 **resume 时没有可恢复的会话不算错误**,友好提示后正常开新会话。

还有一条防崩:`latestSession()` 读到损坏的快照,返回 null 而不是抛异常——**持久化的恢复路径永远不能因为一个坏文件就让工具起不来**。

## 跟着写:本地遥测

### 第 4 步:埋点,但只埋在本机

「没有数据的优化都是猜测」——哪类错误真的常发、压缩多久触发一次、哪个工具老被拒。但这是个**单机 CLI**,所以事件只写 `.mini-agent/telemetry.jsonl`,**绝不出本机**,`MINI_AGENT_NO_TELEMETRY=1` 完全关闭。

```ts
export function emit(event, fields = {}) {
  // ... 计数 ...
  if (!sessionId) return; // 没 init 就只计数不落盘 → 测试和 eval 天然静默
  try { fs.appendFileSync(TELEMETRY_FILE, JSON.stringify({ts, event, ...fields}) + "\n"); }
  catch { /* 磁盘满不是我们要升级的问题 */ }
}
```

两个工业级细节:**emit 永不抛异常**(埋点失败绝不能搞挂正经活);**库使用默认静默**(只有真正的 CLI 调 `initTelemetry`,测试和 eval 引入这些模块不会偷偷写文件)。

### 第 5 步:统一前缀,greppable

所有事件名走 `agent_<域>_<动作>`:`agent_api_call`、`agent_api_error`、`agent_tool_denied`、`agent_compaction_ok`……统一前缀才能工程化分析:

```bash
grep agent_api_error .mini-agent/telemetry.jsonl | wc -l     # 这个会话错了几次
grep agent_tool_denied .mini-agent/telemetry.jsonl           # 哪些工具老被拦
```

埋点埋在哪也有讲究:`agent_api_error` 带上 `kind`(复用 Ch4 的错误分类)和第几次重试——「rate_limited 从 0 跳到 5%」五分钟定位,靠的就是这个 `kind` 字段。`/stats` 只是把本会话的计数器排个序给你看,真正的分析在那个 jsonl 文件里。

## 为什么这么写

**为什么持久化是工业级的及格线?** 一个关掉就失忆的工具,用户不敢交给它长任务——干到一半网断了、电脑睡了,全白费。能 resume,agent 才敢接「重构整个模块」这种跨小时的活。

**为什么遥测要本地化到这种程度?** 因为信任。一个会「偷偷上报」的开发者工具,再有用也让人膈应。本地遥测拿到了数据的全部好处(自我诊断、优化有据),零隐私成本。Claude Code 埋了 860+ 事件,但那是有服务端的产品;我们没有服务端,也就没有任何理由让数据离开你的硬盘。

**为什么 emit 要静默失败?** 这是「防御代码本身是故障源」(Ch4)的镜像:可观测性代码绝不能成为它要观测的系统的故障源。埋点挂了,最坏结果是少一条记录,绝不是任务崩溃。

## 你会踩的坑

**坑 1:append 而非快照。**对一个被压缩重写过的历史做 append,存下的是分裂的状态。历史会被重写,就只能整存整取。

**坑 2:把 system 消息也存了。**resume 回来用的是上周的 AGENT.md 规则,用户改了配置却不生效,极难排查。系统消息永远当下重建。

**坑 3:resume 后不提示「需重读文件」。**模型以为自己还记得文件内容,基于新进程从没读过的版本编辑——又是 Ch2 那个幻影编辑 bug,这次由持久化引入。

**坑 4:无界增长。**每个项目目录悄悄堆几百个会话文件,是 demo 不是工具。我们 `prune` 只留最近 20 个。任何写本地状态的功能,都要问一句「它会不会无限长」。

## 小结

本章给 mini-agent 两样工业级工具该有的自我意识:**记得住**(快照式会话 + 原子写 + `--resume`)和**看得见**(本地遥测 + 统一前缀 + `/stats`,且绝不出本机)。

下一章(Ch13)往下沉一层,解决一个一直被我们用 `execSync` 糊着的隐患:工具执行是同步的——一个慢命令会冻住整个 UI,Ctrl+C 都按不动。我们把执行层改成全异步。

---

*本章对应 commit:`Day 12: session persistence and local telemetry`(tag `day12`)*

# Ch11 · 配置即权限:settings、slash 命令与一个真正的 CLI 表面

> 进阶篇从这章开始:课程主线(Ch1–Ch9)教会你五根骨头,进阶篇把它打磨成工业级。本章完整代码:`git checkout day11`。

## 这一章做完,你会得到什么

三样此前「改源码才能办到」的事,现在都是配置和命令:

```
$ mini-agent --version
0.2.0

$ mini-agent -p "What is 17*23? Answer with just the number."
🤖 391                      ← 单发模式,exit code 区分成败,能进脚本和 CI

$ cat .mini-agent/settings.json
{ "permissions": { "allow": ["cargo"], "deny": ["git push"] } }
                            ← 这个项目里:cargo 直接放行,git push 一律拦死

> /model
model: deepseek-chat
endpoint: https://api.deepseek.com
context window: 1048565 tokens (compaction at ~838852)
```

外加:测试套件从临时脚本搬进仓库,`npm test` 一条命令 60 个检查。

## 跟着写

### 第 1 步:双层 settings 文件

```
~/.config/mini-agent/settings.json    ← 你的默认值,管所有项目
./.mini-agent/settings.json           ← 这个项目的规矩,可以提交进 git
```

标量(model/baseURL/contextWindow):env > 项目 > 全局 > 默认,specific 赢。**权限列表不一样:两层全部生效**——任何一层的 deny 都是 deny。权限规则两种写法:`"cargo"`(信任这个 bash 命令)或 `"tool:edit_file"`(整个工具免确认/拦死)。

一个容易写错的细节:**settings 文件解析失败必须硬报错退出,不能警告了事**。静默忽略一个坏文件 = 静默丢掉用户的 deny 规则——fail closed 不只适用于运行时,也适用于配置加载。

### 第 2 步:用户规则接进判定队列——顺序就是安全模型

```
内置 deny → 用户 deny → 内置 ask → 复合命令 ask → 内置 allow → 用户 allow → 兜底 ask
```

用户 allow 排在**最后**:它只能在「本来要问」的东西里放行,永远轮不到对 deny 说话。测试里专门钉了三根钉子:用户 allow `rm` 之后,`rm -rf /` 照样 deny、普通 `rm` 照样 ask;用户 `tool:edit_file` 预批准之后,改 `.zshrc` 照样 deny。**配置能放宽便利,不能放宽安全**——这是 Ch5「deny 永远赢」在配置层的延伸。

### 第 3 步:CLI 表面

`--version`、`--help`、`-p` 单发模式。`-p` 的实现只有几行——同一个 runLoop、同一道权限闸门,区别只在 confirm:

```ts
confirm: async (q) => {
  if (process.env.MINI_AGENT_AUTO_APPROVE === "1") return true; // explicit bypass
  console.error(`[print mode] declined (no prompt available)`); // stderr, not stdout
  return false; // fail closed
},
```

注意输出纪律:**答案走 stdout,所有旁白走 stderr**——这样 `mini-agent -p "..." | jq` 这类管道用法才成立。exit code 同样讲究:成功 0、失败 1、中断 130,脚本可以分支。

slash 命令(/help、/clear、/model、/compact)是一个 switch,但有一条防呆值得抄:**任何以 `/` 开头但不认识的输入,吞掉并提示,绝不发给模型**——否则你打错一个命令,模型会一本正经地解读 `/hlep` 是什么意思,白烧一轮。

### 第 4 步:测试搬家

三套测试(工具 13 + 权限 36 + 上下文 11)从 /tmp 临时脚本搬进 `tests/`,故意**不引测试框架**:一个 30 行的 helpers.ts(PASS/FAIL 行 + 计数 + exit code)就够 CI 用。权限套件顺势补了用户规则的 7 个用例。`CONFIG.permissions` 留作可变对象,就是给测试当注入缝的——比为每个用例写临时 settings 文件便宜得多。

## 为什么这么写

**为什么权限要可配置?** Ch5 讲过「责任前移到配置期」——但当时所有边界都焊死在源码里,用户「配置」的方式是改代码。工业级的定义之一:**安全策略是数据,不是代码**。数据可以 review、可以进 git、可以一个项目一份。

**为什么 -p 模式值得做?** 一旦 agent 能进管道,它就从「聊天玩具」变成「构建块」:`mini-agent -p "总结今天的 git log" >> CHANGELOG.md`、CI 里跑一句检查……Claude Code 的 `-p` 是它被大量脚本化使用的根基。成本几乎为零——循环和权限全是现成的。

**为什么不引测试框架?** 这个项目的依赖预算本身就是教学内容(运行时 3 个包)。vitest 很好,但它解决的问题(watch、mock、并行)我们一个都还没有;而它的成本(配置、版本、学习)现在就要付。**依赖和防御代码一样,配得上需求再引**——Ch9 的判断标准,落在自己头上。

## 你会踩的坑

**坑 1:settings 解析失败只 warn 不退。**最危险的一种「优雅降级」:用户以为 deny 还在,实际整个文件被跳过了。安全配置加载失败,唯一正确的行为是大声死掉。

**坑 2:用户 allow 插队。**实现时手一滑把用户 allow 放进队列前部,deny 体系瞬间多一个绕过孔。判定顺序要用测试钉死,不能靠 review 时眼尖。

**坑 3:-p 模式把旁白打进 stdout。**「approval declined」混进答案里,下游管道全是噪音。stdout 是合同,stderr 才是给人看的。

**坑 4:`/` 打错字喂给模型。**`/hlep` 不该变成一轮 API 调用。

## 小结

本章之后,mini-agent 有了工业级 CLI 的三件基本品:**可配置(settings 双层,deny 永远赢)、可脚本(-p + exit code + stdout 纪律)、可回归(npm test 60 例)**。

下一章(Ch12)解决「关掉就全没了」:会话持久化(`--resume`)和本地遥测(`/stats`)——一个工业级工具得记得住自己干过什么。

---

*本章对应 commit:`Day 11: the industrial CLI surface`(tag `day11`)*

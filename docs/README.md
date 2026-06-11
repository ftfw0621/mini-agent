# 教程:从零手搓一个自己的 Claude Code

> 10 天,约 1200 行 TypeScript,用 DeepSeek API 从零写出一个能干活的命令行 Agent。
> 全部教程免费开源。代码与教程一一对应:每章对应一个 git tag,`git checkout dayN` 就是当天收工的完整代码。

## 目录

| 章 | 标题 | 对应 tag |
|---|---|---|
| [Ch0](ch00-intro.md) | 开篇:你将做出什么,以及 10 分钟环境准备 | — |
| [Ch1](ch01-raw-loop.md) | 50 行代码,让 AI 第一次替你干活 | `day1` |
| [Ch2](ch02-tools.md) | 给 AI 一双手:工具系统 | `day2` |
| [Ch3](ch03-tool-descriptions.md) | 工具说明书比工具本身重要 | `day2` |
| [Ch4](ch04-resilience.md) | 让它扛揍:重试、退避、熔断 | `day3` |
| [Ch5](ch05-permissions.md) | AI 用 9 秒删光了一家公司:权限边界 | `day4` |
| [Ch6](ch06-context.md) | AI 的失忆症,和怎么让它忘得体面 | `day5` |
| [Ch7](ch07-repl-and-prompt.md) | 从一问一答到一场对话:REPL、宪法与流式输出 | `day6` |
| [Ch8](ch08-subagents-and-eval.md) | 分身术与期末考:子 agent 和 eval | `day7` |
| [Ch9](ch09-what-we-didnt-build.md) | 收尾:我们刻意没做的事 | `day8` |
| [附录](ch10-appendix.md) | 常量速查表与架构图 | — |

## 怎么学

每章固定五段:**做完长什么样 → 跟着写 → 为什么这么写 → 你会踩的坑 → 小结**。

推荐「跟做」:读一章,自己敲一遍,卡住了 `git checkout dayN` 对照当天代码。「坑」一节别跳过——里面全是写这份代码时真实踩过的。

## 支持这个项目

教程和代码永久免费。如果它帮到了你:点个 ⭐、转给想搞懂 agent 的朋友,就是最大的支持。

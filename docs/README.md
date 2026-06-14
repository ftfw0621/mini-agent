# 教程:跟着 AI,从零搓一个自己的 Claude Code

> 23 天,一天一章(主线 10 天 + 进阶 13 天),约 3150 行 TypeScript,用 DeepSeek API 从零写出一个工业级的命令行 Agent。
> 全部教程免费开源。代码与教程一一对应:每章对应一个 git tag,`git checkout dayN` 就是第 N 天对应的完整代码。

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
| [附录](ch10-appendix.md) | 常量速查表与架构图(含换模型清单,对应 `day10`) | — |

## 进阶篇:走向工业级

课程主线到 Ch9 为止是一个完整的 agent;进阶篇把它打磨成工业级 CLI,体例不变(一章一个 tag,五段结构)。

| 章 | 标题 | 对应 tag |
|---|---|---|
| [Ch11](ch11-settings-and-cli.md) | 配置即权限:settings、slash 命令与一个真正的 CLI 表面 | `day11` |
| [Ch12](ch12-sessions-and-telemetry.md) | 记得住自己干过什么:会话持久化与本地遥测 | `day12` |
| [Ch13](ch13-async-execution.md) | 别冻住:把工具执行改成全异步 | `day13` |
| [Ch14](ch14-hooks.md) | 核心做精,业务外挂:Hook 生命周期系统 | `day14` |
| [Ch15](ch15-mcp.md) | 借来的工具:接入 MCP 生态 | `day15` |
| [Ch16](ch16-llm-judge.md) | 让 AI 看门:LLM 权限裁判(减摩擦,不减安全) | `day16` |
| [Ch17](ch17-long-term-memory.md) | 记住跨会话的事:长期记忆 | `day17` |
| [Ch18](ch18-cost-accounting.md) | 账单看得见:token 与缓存成本核算 | `day18` |
| [Ch19](ch19-tool-validation.md) | 把概率输出钉进结构:工具调用校验与修复 | `day19` |
| [Ch20](ch20-plan-mode.md) | 先看后做:计划模式(只读研究,计划批准后才动手) | `day20` |
| [Ch21](ch21-diff-preview.md) | 让批准有意义:写入前的 diff 预览(看清每一刀再点 yes) | `day21` |
| [Ch22](ch22-undo.md) | 给一颗后悔药:/undo 撤销上一次写入(改完也能反悔) | `day22` |
| [Ch23](ch23-model-tiering.md) | 让杂活用便宜的模型:子 agent 模型分级(强模型当顾问) | `day23` |

## 怎么学

每章固定五段:**做完长什么样 → 跟着写 → 为什么这么写 → 你会踩的坑 → 小结**。

推荐「跟做」:读一章,自己敲一遍,卡住了 `git checkout dayN` 对照当天代码。「坑」一节别跳过——里面全是写这份代码时真实踩过的。

## 支持这个项目

教程和代码永久免费。如果它帮到了你:点个 ⭐、转给想搞懂 agent 的朋友,就是最大的支持。

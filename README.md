# mini-agent

用 DeepSeek API 从零手写一个类 Claude Code 的命令行 Agent,TypeScript 实现。

10 天,每天一个 commit。**commit 历史就是课程目录**:`git log --oneline` 看大纲,`git checkout dayN` 拿到第 N 天收工时的完整代码。

> 代码、注释、commit message 用英文——模型的工具调用主要在英文数据上训练,英文指令引导更稳,也方便国际读者;配套教程是中文。

## 快速开始

最简方式(npm 包):

```bash
echo 'DEEPSEEK_API_KEY=sk-你的key' > .env   # key 在 platform.deepseek.com 获取
npx mini-agent
```

从源码跑:

```bash
git clone https://github.com/Michael-crazyman/mini-agent.git && cd mini-agent
npm install
cp .env.example .env   # 填入你的 DeepSeek API Key
npm start              # 跑最新版
npm run eval           # 10 道题的回归考试
```

## 进度

| Tag | 内容 |
|---|---|
| `day1` | ~50 行 raw tool-calling loop:一个工具、一个循环、两条保险 |
| `day2` | 工具五件套(read/write/edit/search/bash):编辑前必须先读、old_string 唯一性、永不抛异常的 dispatch、四要素工具说明书 |
| `day3` | 主循环状态机:错误分类、指数退避(带抖动)、双重重试预算、熔断器,8 种终态各配人话提示,Ctrl+C 体面退出 |
| `day4` | 权限系统(allow/ask/deny):禁飞区硬拦(.git/.ssh/.env)、deny 永远赢(bypass 也压不过)、非交互 fail closed、bash 按输入定危险等级、秘密文件不进上下文 |
| `day5` | 上下文管理:token 估算(字节法,宁多勿少)、80% 触发线、6 段结构化摘要(双保险禁工具)、文件恢复(最近 5 个,从磁盘重读)、主动+被动压缩、压缩熔断 |
| `day6` | 多轮 REPL(行队列输入、/clear、Ctrl+C 三态语义)、system prompt 宪法(数字锚/反面禁令/防虚报)、AGENT.md 项目记忆、流式输出 + 双重看门狗(90s 断流/30s 只警告) |
| `day7` | 子 agent(task 工具:独立上下文、一层分身不套娃、报告是材料不是结论、文件状态快照隔离)+ 最小 eval(10 道固定题、物证判分、8/10 及格线,`npm run eval`) |
| `day8` | 封装发布:`bin` 入口 + tsc 构建,`npx mini-agent` 一行启动;内置 .env 加载;缺 key 人话报错 |

(每天更新)

## 配套教程(中文)

每个 tag 对应教程一章:为什么这么写、Claude Code 原版怎么做、你会踩的坑。获取方式见小红书 @老李是谁。

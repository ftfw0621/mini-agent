# mini-agent

用 DeepSeek API 从零手写一个类 Claude Code 的命令行 Agent,TypeScript 实现。

10 天,每天一个 commit。**commit 历史就是课程目录**:`git log --oneline` 看大纲,`git checkout dayN` 拿到第 N 天收工时的完整代码。

> 代码、注释、commit message 用英文——模型的工具调用主要在英文数据上训练,英文指令引导更稳,也方便国际读者;配套教程是中文。

## 快速开始

```bash
npm install
cp .env.example .env   # 填入你的 DeepSeek API Key
npm start
```

## 进度

| Tag | 内容 |
|---|---|
| `day1` | ~50 行 raw tool-calling loop:一个工具、一个循环、两条保险 |
| `day2` | 工具五件套(read/write/edit/search/bash):编辑前必须先读、old_string 唯一性、永不抛异常的 dispatch、四要素工具说明书 |
| `day3` | 主循环状态机:错误分类、指数退避(带抖动)、双重重试预算、熔断器,8 种终态各配人话提示,Ctrl+C 体面退出 |
| `day4` | 权限系统(allow/ask/deny):禁飞区硬拦(.git/.ssh/.env)、deny 永远赢(bypass 也压不过)、非交互 fail closed、bash 按输入定危险等级、秘密文件不进上下文 |
| `day5` | 上下文管理:token 估算(字节法,宁多勿少)、80% 触发线、6 段结构化摘要(双保险禁工具)、文件恢复(最近 5 个,从磁盘重读)、主动+被动压缩、压缩熔断 |

(每天更新)

## 配套教程(中文)

每个 tag 对应教程一章:为什么这么写、Claude Code 原版怎么做、你会踩的坑。获取方式见小红书 @老李是谁。

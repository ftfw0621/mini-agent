# Ch3 · 工具说明书比工具本身重要

> 本章不写新代码,对应的还是 `day2` 的 `src/tools.ts`——这次只看里面的文字部分。

## 一个实验

同一个 `edit_file` 工具,两种 description,行为差多少?

一句话版本:

> "Edit a file."

四要素版本(我们 day2 写的):

> Replace one exact string in a file: old_string → new_string.
> **Boundaries:** old_string must match the file content exactly (including whitespace and indentation) and must be unique in the file; if it is not unique, include a few surrounding lines as context.
> **Precondition:** you MUST have read the file with read_file first.
> **On error:** "not found" means old_string does not match the file — re-read and copy it exactly; "not unique" means include more surrounding context.
> ALWAYS use this tool to edit files. NEVER use sed/awk or shell redirection via run_bash.

《Harness Engineering》给过一组经验数据:只有一句话功能说明的工具,模型大约 **3 次就有 1 次用歪**;把边界、前置条件、错误处理补全之后,**100 次有 99 次是稳的**。

代码一行没变,行为从 67 分到 99 分。这就是本章只讲文字的理由。

顺带回答一个你可能想问的问题:**为什么说明书用英文写?** 模型的工具调用能力主要是在英文数据上训练出来的,英文指令(尤其 ALWAYS/NEVER/MUST 这类强约束词)的遵守率实测更稳;而且这份代码要开源,英文是默认语言。你跟 agent 对话用中文完全不受影响。

## 模型的手,全是你教出来的

先建立一个画面。Claude Code 内置 40 多个工具——Bash、Read、Edit、Grep、WebSearch、Agent……这些是模型的手。模型本身只能在文本里思考,**真正能动你硬盘、跑你命令的,全是这些手**。

每只手配一份说明书,核心字段四个:`name`(叫什么)、`description`(干嘛的、什么时候用)、`inputSchema`(传什么参数)、`call`(真正执行的代码)。模型每次决定「要不要调这个工具」,读的就是前三个——它从始至终看不到你的实现代码。

这在传统软件里没有对应物。函数 docstring 写烂了,读它的程序员会当面问你;**模型读不懂没人替它问,它直接乱调,然后把锅留给你**。所以这份说明书的质量,直接就是你 agent 的行为质量。

Claude Code 给 Bash 一个工具写的说明书有**几千字**,给 Agent 工具写了 **280 行**。第一次听说时我也觉得夸张,自己写过一遍之后觉得:不夸张,这是工作量该在的地方。

## 四要素,每一条防一类事故

回头看我们五个工具的 description,每个都按同一个模板写:

**1. 功能(what)**——一句话说清干什么。这条人人会写,略过。

**2. 边界(boundaries)**——「什么时候不该用我」。比如 write_file 里写 "to change a small part of a file use edit_file instead — do not rewrite whole files"。不写这条,模型会拿最顺手的工具硬干所有事。

**3. 前置条件(precondition)**——「用我之前你得先干什么」。edit_file 里写 "you MUST have read the file with read_file first"。配合代码里的 `readFiles` 检查,文字和代码双保险:文字让模型大概率第一次就做对,代码保证它做错了也过不去。**只有文字是劝告,只有代码是哑谜,两个都有才叫设计**。

**4. 出错怎么办(on error)**——失败之后的下一步指引。"'not found' means old_string does not match — re-read and copy it exactly"。这条最容易被省略,但它决定了模型失败后是「有方向地自救」还是「原地乱试三轮」。

## 最反直觉的一条:禁掉万能工具

我们的 run_bash 明明能 `cat`、能 `grep`、能 `sed`——为什么还要专门写四个工具,然后在 run_bash 的说明书里把这些用法**禁掉**?

> To read files use read_file (not cat), to search use search (not grep/find), to edit files use edit_file (not sed/redirection).

Claude Code 对 grep 的处理更狠,双向夹击:Bash 工具的说明书里写「搜索必须用 Grep 工具」;Grep 工具的说明书里再钉一遍 "ALWAYS use Grep. NEVER invoke grep or rg as Bash command"。两份说明书互相指,不留死角。我们的 search 和 run_bash 也是这样成对写的。

为什么这么大动干戈?四个理由,每个都是真实的痛:

1. **黑盒没法 debug**。模型跑 `grep -r "foo" .` 出错了,你只有一行 shell 报错;专用 search 工具的每一步都是你的代码,可以打日志、可以单测。
2. **绕过你的控制**。下一章我们要做权限系统——「编辑前必须先读」这条规矩,模型一句 `sed -i` 就绕过去了。万能工具是所有规则的后门。
3. **结果不可结构化**。专用工具能保证输出格式(file:line: content),bash 输出是自由文本,下游没法可靠处理。
4. **平台差异让模型「自信地用错」**。macOS 的 sed 和 GNU sed 语法不同,grep 各版本 flag 不同——模型在训练数据里全见过,混在一起用,错得理直气壮。

一句话总结:**bash 是能力的来源,也是失控的来源。能力收进专用工具,bash 只留给真正需要执行的事。**

## 说明书是写给「调用前」的

注意四要素全部作用在**调用之前**——让模型在伸手前就知道边界,而不是撞了墙再回头。

这有真金白银的差别:模型试一个被禁的命令 → 被拒 → 换个方式重试,一来一回多烧两轮 API 调用。把边界写进说明书,这两轮就省了。**让模型在调用之前知道边界,永远比撞墙便宜。**

沿着这个思路再往前一步,Claude Code 干了一件更漂亮的事:它的 description **不是字符串,是函数**——根据当前权限模式动态生成。你在配置里禁了 `rm -rf`,模型下次读到的 Bash 说明书就变成「注意:rm -rf 已被用户禁用,请勿尝试」。说明书随环境变化,模型永远拿到最新的边界。我们 V1 用静态字符串够了,但这个思想值得先记下:**description 是接口的一部分,不是装饰**。

## 你会踩的坑

**坑 1:说明书写成产品文案。**「强大的文件编辑能力,轻松修改任意文件」——这种话对模型是纯噪音。模型需要的是操作规范:什么格式、什么前置、什么边界、错了怎么办。写说明书时想象读者是一个一目十行、过度自信、从不提问的实习生。

**坑 2:只写正面,不写反面。**"Search file contents" 没拦住任何事;"NEVER run grep/rg/find via run_bash" 才是行为约束。反面规则(不要做 X)的效果普遍好于正面描述——边界是二值的,可验证;正面描述是开放的,全靠模型脑补。

**坑 3:五个工具的说明书口径打架。** search 说 "use read_file to see full content",如果 read_file 的说明书里没有对应的承接,模型会困惑。把五份说明书放在一起通读一遍,保证互相引用的闭环都成立——我们的 tools.ts 里 search↔read_file、run_bash↔其他四个,都是成对出现的。

**坑 4:说明书写完就不管了。** 工具行为改了、加了新限制,说明书没跟着改——模型按旧说明书行事,错得莫名其妙。把 description 当代码 review:改 `run` 必须顺手检查 `definition`。

## 小结

今天这一章一行代码没写,但它解释了 day2 一半的工作量花在哪:五份说明书,每份四要素,口径互相咬合。

说明书决定模型第一次用对的概率,代码检查兜住它用错的后果——**文字管概率,代码管底线**。这八个字会贯穿后面所有章节。

明天(Ch4)回到代码:现在的 agent 网络一抖就崩、报错就死。我们给它装上重试、退避、熔断——让它扛揍。

---

*本章对应 commit:`Day 2: the five core tools`(tag `day2`)*

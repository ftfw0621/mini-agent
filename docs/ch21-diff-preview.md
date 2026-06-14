# Ch21 · 让批准有意义:写入前的 diff 预览

> 本章完整代码:`git checkout day21`。新增 `src/diff.ts`,接进 `loop.ts` 的工具执行前一步。

## 这一章做完,你会得到什么

到 Day 20 为止,模型要改文件时,审批提示只告诉你一个文件名:

```
⚠️ approval needed — edit_file (writes to your filesystem)
   cart.js
  Allow? [y/N]
```

你其实是在**闭着眼睛**点 yes——你不知道它要把 `cart.js` 改成什么。这一章把真正的改动摊在你面前:

```
  edit cart.js
  +1 -1
    for (const it of items)
-     total += it.price - it.qty;
+     total += it.price * it.qty;
    return total;

⚠️ approval needed — edit_file (writes to your filesystem)
  Allow? [y/N]
```

绿色的 `+`、红色的 `-`,一眼看清它到底动了哪一行。审批这个动作,从「相信它没乱改」变成「我看过了,这个改动对」。

## 跟着写

### 第 1 步:为什么自己写一个 diff,而不是 `require('diff')`

npm 上有现成的 diff 库。但这一章我们自己写——不是为了造轮子,是因为**行级 diff 的核心算法(最长公共子序列,LCS)只有十几行**,而且它正是「确定性地描述两段文本的差异」这件事的最小内核。看懂它,你就明白所有 diff 工具底下是什么。这也延续全书的依赖预算:能十几行写清的,不引一个库、一份学习成本、一个故障面。

### 第 2 步:LCS——把「旧」变成「新」的最少增删

两段文本按行切开,求它们的**最长公共子序列**:那些不用动、原样保留的行。剩下的,旧文本里多出来的就是「删」,新文本里多出来的就是「增」。

```ts
export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)                       // 自底向上填表
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1  // 行相同 → 公共子序列 +1
                                : Math.max(lcs[i + 1][j], lcs[i][j + 1]); // 否则取更优的一侧
  // 正向走一遍表,把它翻译成有序的「保留/删/增」
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ kind: " ", line: a[i++] }), j++;        // 公共行,作为上下文
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ kind: "-", line: a[i++] }); // 删它能保住更长的 LCS
    else ops.push({ kind: "+", line: b[j++] });                          // 否则这是新增
  }
  while (i < n) ops.push({ kind: "-", line: a[i++] });  // 旧文本的尾巴全是删
  while (j < m) ops.push({ kind: "+", line: b[j++] });  // 新文本的尾巴全是增
  return ops;
}
```

`lcs[i][j]` 是「`a` 从 `i` 往后」和「`b` 从 `j` 往后」的最长公共子序列长度。填完表正向走一遍,每一步看「删左边这行」还是「增右边这行」能保住更长的公共子序列——贪心地走,就得到最小的增删序列。

### 第 3 步:只给人看「变了什么」,不是整个文件

一个 500 行的文件改了 1 行,把 500 行全打出来没人看。所以渲染时**折叠**:只保留变动行,外加它前后几行上下文,中间大段没动的collapse 成一句 `⋮ (N unchanged lines)`:

```ts
const keep = new Array(ops.length).fill(false);
ops.forEach((op, idx) => {
  if (op.kind === " ") return;
  for (let k = idx - CONTEXT; k <= idx + CONTEXT; k++) keep[clamp(k)] = true; // 变动行周围 ±3 行留着
});
// 没 keep 的连续段,整段折叠成一行「⋮ (跳过 N 行)」
```

再加一个 `+A -B` 的汇总头、一个总行数上限(再大的 diff 也不许刷屏)。这和 Day 13「超长输出落盘」、Day 18「别浪费 token」是同一个克制:**给人的信息要够用,但不能淹没人**。

### 第 4 步:把预览接到工具的真实语义上

光有 diff 算法还不够,得知道「这次工具调用会让文件变成什么样」。`previewChange` 按工具复现它们各自的语义:

```ts
export function previewChange(toolName, argsJson): string | null {
  const args = JSON.parse(argsJson);            // 解析失败 → 返回 null,不预览
  if (toolName === "write_file") {
    const oldText = exists ? safeRead(p) : "";  // 新文件,「之前」是空
    return `  ${exists ? "overwrite" : "create"} ${args.path}\n${renderDiff(oldText, args.content)}`;
  }
  if (toolName === "edit_file") {
    const oldText = safeRead(p);
    const occ = oldText.split(args.old_string).length - 1;
    const newText = occ === 1 ? oldText.split(args.old_string).join(args.new_string) : null; // 复现 edit_file 的「唯一匹配才替换」
    return `  edit ${args.path}\n${renderDiff(oldText, newText ?? ...)}`;
  }
  return null;                                  // 不是写文件的工具 → 不预览
}
```

关键是 `previewChange` **复现而不调用** edit_file 的语义:edit_file 只在 old_string 唯一时替换,预览也只在唯一时算真实 before/after。两边的「会发生什么」必须一致,否则预览就成了骗局——你看到的 diff 和真正写下去的不一样,比没有 diff 更危险。

还有一条铁律:**预览永远不许抛异常**。它只是给人看的辅助,任何意外(文件读不了、是二进制、参数缺字段)都返回 null,绝不能因为「想给你看个 diff」反而搞崩了工具调用。`safeRead` 把过大、含 NUL 字节(二进制)的文件挡在外面,就是这个意思。

### 第 5 步:在闸门之前、执行之前,把 diff 打出来

接进 `loop.ts`——在权限闸门判完、但还没问你之前,对写文件的工具打印预览:

```ts
const v = checkPermission(call.name, call.args);
if (!opts.quiet && v.decision !== "deny" && (call.name === "write_file" || call.name === "edit_file")) {
  const preview = previewChange(call.name, call.args);
  if (preview) console.log(preview.replace(/^/gm, indent)); // 子 agent 的话,跟着缩进对齐
}
```

放这个位置有讲究:**deny 的不打**(根本不会执行,打了是噪音);**ask 和 allow 的都打**——ask 时你正要决定要不要批准,diff 是你做决定的依据;allow 时(比如你 settings 里预批准了写文件)虽然不问你,但把改了什么显出来,你仍然看得见、能喊停(Ctrl+C)。

## 为什么这么写

**为什么 diff 在权限闸门之后、而不是在工具里?** 因为这是**展示**,不是**执行**。工具(edit_file)只管把字写进磁盘;要不要让人看、怎么看,是 loop 这一层的事。Day 4 把「决定能不能做」收进权限层,Day 21 把「让人看清要做什么」收进 loop 的渲染层——各司其职。工具本身不需要知道有没有人在看屏幕。

**为什么预览要复现工具语义,而不直接跑一遍工具拿结果?** 因为跑一遍就把文件改了——预览的全部意义是「改之前先看」。所以只能**纯函数地推演**结果:读出当前内容,在内存里算出改完会是什么样,绝不落盘。这也是为什么 `previewChange` 必须和 edit_file 的匹配规则严格对齐:它是同一套逻辑的一次无副作用排练。

**为什么宁可不预览,也不让它出错?** 同 Day 19 校验器的不对称失败:diff 是锦上添花,缺了顶多让审批回到「只有文件名」的旧状态;但如果预览本身抛异常,它就把一次合法的工具调用搞崩了——辅助功能害死主流程,是最不划算的 bug。所以它从头到尾 fail 到 null。

## 你会踩的坑

**坑 1:`"".split("\n")` 是 `[""]` 不是 `[]`。** 空文件按行切会得到一个含空串的数组,diff 会凭空多出一行。所以 `oldText.length ? split : []`——空文本就是零行。新建文件的「之前」是空,这个边界天天踩。

**坑 2:把整个文件打出来。** 没有折叠和上限,改一行的 diff 在大文件上能刷几百行,把审批提示冲没了。上下文窗口 + `⋮` 折叠 + 硬上限,缺一不可。

**坑 3:预览和实际写入不一致。** 如果 `previewChange` 对 edit_file 的多重匹配也照样替换、而 edit_file 其实会拒绝,你看到的 diff 就是假的。预览必须和工具同样「只在唯一匹配时动手」,否则它在骗你点 yes。

**坑 4:二进制文件当文本 diff。** 对图片、可执行文件做行 diff,输出一堆乱码还可能很慢。`safeRead` 用 NUL 字节判二进制(和 Day 2 的 search 一致)、用大小上限挡超大文件,从源头返回 null。

## 小结

本章给写文件的工具加了一层 diff 预览:十几行的 LCS 算出最小增删、折叠成只看变动的紧凑视图、复现工具语义无副作用地推演结果、在闸门之后执行之前打给人看。它没改任何工具的行为,只是把「批准」从一次盲签变成一次知情的确认。

`npm test` 189 例,新增 22 个覆盖:LCS 的增/删/改/空边界、渲染的计数与折叠、previewChange 对 write/edit/新建/二进制/坏参数的处理。

它和这门课的主线又合上了一拍:Day 4 给了人「拒绝的权力」,Day 20 给了人「先看计划的权力」,Day 21 给了人**「看清每一刀」的权力**——人在回路里,靠的不是信任,是看得见。

---

*本章对应 commit:`Day 21: diff preview before writes`(tag `day21`)*

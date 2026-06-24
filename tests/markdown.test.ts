import { renderMarkdown, MarkdownStream } from "../src/markdown.js"; // unit under test
import { displayWidth } from "../src/editor.js"; // to assert table fits the window
import { check, checkContains, finish } from "./helpers.js"; // assertions
// chalk auto-disables color when stdout isn't a TTY (as under the test runner),
// so these assertions see plain text — but box-drawing glyphs are always emitted.

// ---- renderMarkdown: block + inline ---------------------------------------------------
const heading = renderMarkdown("## Hello world", 80);
checkContains("heading keeps its text", heading, "Hello world");
check("heading strips the ## markup", !heading.includes("##"), `got: ${heading}`);

const bold = renderMarkdown("this is **important** text", 80);
checkContains("bold keeps its text", bold, "important");
check("bold strips the ** markup", !bold.includes("**"), `got: ${bold}`);

const code = renderMarkdown("call `doThing()` now", 80);
checkContains("inline code keeps its text", code, "doThing()");
check("inline code strips the backticks", !code.includes("`"), `got: ${code}`);

// ---- renderMarkdown: a CJK table aligns into a box ------------------------------------
const table = renderMarkdown(["| 主题 | 资源 |", "|------|------|", "| 控制论 | 维纳《控制论》 |"].join("\n"), 80);
checkContains("table draws a box border", table, "│");
checkContains("table keeps a header cell", table, "主题");
checkContains("table keeps a CJK body cell", table, "维纳《控制论》");
check("table drops the |---| separator row", !table.includes("---|"), `got: ${table}`);

// ---- responsive table: adapts to the window width ------------------------------------
const wide = [
  "| 主题 | 内容 |",
  "|------|------|",
  "| 反馈与系统思维 | 开环 vs 闭环、正/负反馈、稳态误差、超调量、阻尼比、相位裕度 |",
  "| 必读 | 现代控制工程 (Ogata)、Feedback Control of Dynamic Systems (Franklin) |",
].join("\n");
for (const w of [88, 60, 40]) {
  const out = renderMarkdown(wide, w);
  const widest = Math.max(...out.split("\n").map((l) => displayWidth(l)));
  check(`table fits width ${w}`, widest <= w, `widest line = ${widest} > ${w}`);
  check(`table at width ${w} doesn't truncate with an ellipsis`, !out.includes("…"), `got ellipsis at width ${w}`);
}
checkContains("narrow table still keeps the CJK content (wrapped, not dropped)", renderMarkdown(wide, 40), "相位裕度");

// ---- MarkdownStream: completed blocks flush before end() ------------------------------
const out: string[] = [];
const s = new MarkdownStream((x) => out.push(x), { firstPrefix: "> ", indent: "  " });
s.push("first paragraph.\n\nsecond para"); // blank line ⇒ first block is complete
check("a finished block flushes immediately", out.length === 1 && out[0].includes("first paragraph"), `out=${JSON.stringify(out)}`);
check("the unfinished block waits", !out.join("").includes("second para"), `out=${JSON.stringify(out)}`);
s.end(); // now the tail flushes
check("end() flushes the final block", out.join("").includes("second para"), `out=${JSON.stringify(out)}`);

// ---- MarkdownStream: the ⏺ prefix leads only the first line ---------------------------
const out2: string[] = [];
const s2 = new MarkdownStream((x) => out2.push(x), { firstPrefix: "P>", indent: "  " });
s2.push("line one\n\nline two\n\n");
const joined = out2.join("");
check("firstPrefix leads the very first line", joined.startsWith("P>"), `got: ${JSON.stringify(joined.slice(0, 20))}`);
check("the second block uses the indent, not the prefix", joined.indexOf("P>", 2) === -1, `got: ${JSON.stringify(joined)}`);

// ---- lists render their inline markup (marked-terminal v15 regression fix) ------------
// marked-terminal left list items as RAW markdown (literal ** and `, a * bullet);
// our custom list renderer parses the inline tokens, like the table override.
const BT = String.fromCharCode(96); // backtick, without shell-escaping headaches
const listOut = renderMarkdown(`intro:\n* use ${BT}read_file${BT} not cat\n* **bold** matters`, 80);
check("list items drop the literal ** (bold parsed)", !listOut.includes("**"), listOut);
check("list items drop the literal backtick (code parsed)", !listOut.includes(BT), listOut);
check("list uses a • bullet, not a raw *", listOut.includes("•"), listOut);
checkContains("list keeps the code word", listOut, "read_file");
const ordered = renderMarkdown("steps:\n1. **first**\n2. second", 80);
check("ordered list keeps its numbers and parses bold", ordered.includes("1.") && ordered.includes("2.") && !ordered.includes("**"), ordered);

// ---- MarkdownStream: a blank line INSIDE a fence is not a block boundary --------------
const out3: string[] = [];
const s3 = new MarkdownStream((x) => out3.push(x), {});
s3.push("```\ncode line 1\n\ncode line 2\n```\n\ntrailing");
check("fenced block with an inner blank line stays one block", out3.length === 1, `out=${JSON.stringify(out3)}`);
checkContains("the fenced block kept both code lines", out3.join(""), "code line 2");

finish();

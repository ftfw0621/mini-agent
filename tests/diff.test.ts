import fs from "node:fs"; // create temp files to preview
import os from "node:os"; // temp dir
import path from "node:path"; // join temp paths
import { diffLines, renderDiff, previewChange } from "../src/diff.js"; // unit under test
import { check, checkContains, finish } from "./helpers.js"; // assertions

// A scratch file we can write, edit, and diff.
const tmp = path.join(os.tmpdir(), `mini-agent-diff-${process.pid}.txt`);
const writeTmp = (s: string) => fs.writeFileSync(tmp, s, "utf8");

// ---- diffLines: the core LCS ------------------------------------------------------------
check("identical text → all context", diffLines("a\nb", "a\nb").every((o) => o.kind === " "));
check("appended line → one addition", diffLines("a", "a\nb").filter((o) => o.kind === "+").length === 1);
check("removed line → one removal", diffLines("a\nb", "a").filter((o) => o.kind === "-").length === 1);
{
  const ops = diffLines("a\nb\nc", "a\nB\nc"); // middle line changed
  check("a changed line is one - and one +", ops.filter((o) => o.kind === "-").length === 1 && ops.filter((o) => o.kind === "+").length === 1);
  check("unchanged neighbours stay context", ops.filter((o) => o.kind === " ").length === 2);
}
check("empty → content is all additions", diffLines("", "x\ny").every((o) => o.kind === "+"));

// ---- renderDiff: the human-facing view --------------------------------------------------
const rd = renderDiff("a\nb\nc", "a\nB\nc", false); // color off for stable assertions
checkContains("header counts the changes", rd, "+1 -1");
checkContains("removed line is marked with -", rd, "- b");
checkContains("added line is marked with +", rd, "+ B");
{
  const big = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
  const edited = big.replace("line20", "LINE20");
  const out = renderDiff(big, edited, false);
  checkContains("long unchanged runs collapse", out, "unchanged line"); // the ⋮ marker
  check("collapsed view is far shorter than the file", out.split("\n").length < 30);
}

// ---- previewChange: ties it to the real tools -------------------------------------------
check("non-write tool has no preview", previewChange("read_file", JSON.stringify({ path: tmp })) === null);
check("unparseable args → no preview", previewChange("write_file", "not json") === null);

const created = previewChange("write_file", JSON.stringify({ path: tmp, content: "hello\nworld" }));
checkContains("new-file write says create", created ?? "", "create");
checkContains("new-file write shows additions", created ?? "", "+ hello");

writeTmp("hello\nworld\n");
const overwrite = previewChange("write_file", JSON.stringify({ path: tmp, content: "hello\nthere\n" }));
checkContains("existing-file write says overwrite", overwrite ?? "", "overwrite");
checkContains("overwrite shows the changed line removed", overwrite ?? "", "- world");
checkContains("overwrite shows the changed line added", overwrite ?? "", "+ there");

writeTmp("const x = 1;\nconst y = 2;\n");
const edited = previewChange("edit_file", JSON.stringify({ path: tmp, old_string: "const y = 2;", new_string: "const y = 3;" }));
checkContains("edit shows the old line", edited ?? "", "- const y = 2;");
checkContains("edit shows the new line", edited ?? "", "+ const y = 3;");

check("edit of a missing file → no preview", previewChange("edit_file", JSON.stringify({ path: tmp + ".nope", old_string: "a", new_string: "b" })) === null);

// binary file (NUL byte) must never be diffed
fs.writeFileSync(tmp, Buffer.from([104, 0, 105]));
check("binary file → no preview", previewChange("write_file", JSON.stringify({ path: tmp, content: "x" })) === null);

fs.rmSync(tmp, { force: true }); // clean up
finish();

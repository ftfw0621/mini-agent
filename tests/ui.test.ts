import { banner, promptString, mark, thinkingWord, spinnerText } from "../src/ui.js"; // unit under test
import { check, checkContains, finish } from "./helpers.js"; // assertions
// chalk auto-disables color when stdout isn't a TTY (as under the test runner),
// so these assertions see plain text.

// ---- banner ----------------------------------------------------------------------------
const b = banner("0.19.0", "deepseek-chat", "api.deepseek.com");
checkContains("banner shows the version", b, "v0.19.0");
checkContains("banner shows the model", b, "deepseek-chat");
checkContains("banner shows the host", b, "api.deepseek.com");
checkContains("banner is a rounded box", b, "╭");
checkContains("banner closes the box", b, "╯");

// ---- prompt ----------------------------------------------------------------------------
checkContains("normal prompt is a chevron", promptString(false), "❯");
check("normal prompt is not plan mode", !promptString(false).includes("plan"));
checkContains("plan-mode prompt is marked", promptString(true), "plan");

// ---- activity markers ------------------------------------------------------------------
checkContains("tool marker shows the name", mark.tool("read_file", '{"path":"x"}'), "read_file");
checkContains("tool marker uses the ⏺ glyph", mark.tool("search", ""), "⏺");
checkContains("denied marker explains why", mark.denied("secret file"), "denied — secret file");
checkContains("sub-agent marker shows the tier when switched", mark.subAgentStart("read all files", "cheap-model"), "[cheap-model]");
check("sub-agent marker omits the tier when same", !mark.subAgentStart("do x", "").includes("["));

// ---- thinking word -------------------------------------------------------------------
check("thinking word is deterministic by seed", thinkingWord(0) === thinkingWord(0));
check("thinking word cycles", thinkingWord(0) === thinkingWord(10));
check("thinking word varies across seeds", thinkingWord(0) !== thinkingWord(1));
check("thinking word handles negative seeds", typeof thinkingWord(-1) === "string" && thinkingWord(-1).length > 0);

// ---- spinner text --------------------------------------------------------------------
const st = spinnerText("Pondering", 3, false);
checkContains("spinner shows the word", st, "Pondering");
checkContains("spinner shows elapsed seconds", st, "3s");
checkContains("spinner says how to bail", st, "interrupt");
checkContains("sub-agent spinner is labeled", spinnerText("Pondering", 1, true), "sub-agent");

finish();

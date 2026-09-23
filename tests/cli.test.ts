import { parseCli, applyCliOptions, readPrintPrompt, CliUsageError } from "../src/cli.js";
import { CONFIG } from "../src/config.js";
import { effortParameters, setEffort } from "../src/effort.js";
import { check, finish } from "./helpers.js";

for (const args of [
  ["-p", "hello", "--model", "deepseek-flash", "--effort", "high"],
  ["--effort=high", "--model=deepseek-flash", "--print", "hello"],
  ["exec", "--prompt", "hello", "--effort", "high", "--model", "deepseek-flash"],
]) {
  const options = parseCli(args);
  check("flags remain options on either side of the prompt", options.print && options.prompt === "hello" && options.model === "deepseek-flash" && options.effort === "high");
}
check("delimiter keeps flag-shaped prompt literal", parseCli(["-p", "--", "--help", "--model", "literal"]).prompt === "--help --model literal");
check("help-like text inside a prompt isn't a CLI flag", !parseCli(["-p", "Explain --help and --version"]).help);
check("interactive model override doesn't force print mode", !parseCli(["--model", "custom"]).print);
check("bypass mode has the Claude-compatible shorthand", parseCli(["-p", "hello", "--dangerously-skip-permissions"]).permissionMode === "bypassPermissions");
check("explicit skip flag takes precedence over auto", parseCli(["exec", "hello", "--permission-mode=auto", "--dangerously-skip-permissions"]).permissionMode === "bypassPermissions");
let invalidMode = false;
try { parseCli(["-p", "hello", "--permission-mode=typo"]); } catch (error) { invalidMode = error instanceof CliUsageError; }
check("unknown permission modes fail before execution", invalidMode);
for (const args of [["-p", "--model"], ["-p", "--effort="], ["-p", "--unknown"], ["-p", "--output-format", "bogus"], ["--output-format", "json"], ["exec", "hello", "--prompt", "other"]]) {
  let failed = false;
  try { parseCli(args); } catch (error) { failed = error instanceof CliUsageError; }
  check(`invalid arguments fail: ${args.join(" ")}`, failed);
}
async function* pipe() { yield Buffer.from("管道\ncontext\n"); }
check("stdin-only prompt is preserved", await readPrintPrompt("", pipe(), false) === "管道\ncontext\n");
check("stdin supplements positional prompt", await readPrintPrompt("Summarize", pipe(), false) === "Summarize\n管道\ncontext\n");
check("TTY input is not consumed", await readPrintPrompt("hello", pipe(), true) === "hello");
let emptyFailed = false;
try { await readPrintPrompt("", pipe(), true); } catch (error) { emptyFailed = error instanceof CliUsageError; }
check("empty print invocation is a usage error", emptyFailed);
const original = { model: CONFIG.model, url: CONFIG.baseURL, auto: CONFIG.autoMode.enabled, bypass: CONFIG.bypassPermissions };
try {
  CONFIG.baseURL = "https://api.deepseek.com";
  applyCliOptions(parseCli(["exec", "hello", "--model", "deepseek-flash", "--effort", "max", "--auto"]));
  check("CLI model/effort use the existing request adapter", CONFIG.model === "deepseek-flash" && effortParameters(CONFIG.model).reasoning_effort === "max" && CONFIG.autoMode.enabled);
  let unsupported = false;
  try { applyCliOptions(parseCli(["exec", "hello", "--effort", "xhigh"])); } catch (error) { unsupported = error instanceof CliUsageError && error.message.includes("Choose:"); }
  check("unsupported effort lists supported values", unsupported);
  applyCliOptions(parseCli(["exec", "hello", "--auto", "--permission-mode", "bypassPermissions"]));
  check("explicit bypass wins over auto and disables classifier mode", CONFIG.bypassPermissions && !CONFIG.autoMode.enabled);
  applyCliOptions(parseCli(["exec", "hello", "--permission-mode", "default"]));
  check("explicit default does not inherit bypass or auto", !CONFIG.bypassPermissions && !CONFIG.autoMode.enabled);
} finally {
  setEffort("deepseek-flash", "default");
  CONFIG.model = original.model; CONFIG.baseURL = original.url; CONFIG.autoMode.enabled = original.auto;
  CONFIG.bypassPermissions = original.bypass;
}
finish();

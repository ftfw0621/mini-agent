import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, finish } from "./helpers.js";

// Exercise the real entry point + OpenAI SDK without sockets or real keys.
// The child preload isolates global settings and replaces only the HTTP edge.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-print-"));
const agent = fileURLToPath(new URL("../src/agent.ts", import.meta.url));
const preload = path.join(root, "mock.mjs");
fs.writeFileSync(preload, `
import os from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
os.homedir = () => process.cwd();
syncBuiltinESMExports();
let call = 0;
globalThis.fetch = async (input, init) => {
  if (String(input) !== 'https://api.deepseek.com/chat/completions') throw new Error('Unexpected fixture URL');
  const request = JSON.parse(init.body);
  fs.appendFileSync('requests.jsonl', JSON.stringify(request) + '\\n');
  process.stdout.write('fixture startup diagnostic\\n');
  if (process.env.FIXTURE === 'interrupt') return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  if (process.env.FIXTURE === 'error') return new Response(JSON.stringify({error:{message:'fixture auth failure'}}), {status:401});
  const tool = process.env.FIXTURE === 'tool' && call++ === 0;
  const delta = tool ? {content:'Intermediate narration', tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'run_bash',arguments:JSON.stringify({command:'rm -f blocked.txt'})}}]} : {content:'**Final answer**\\nSecond line'};
  const frames = [{id:'fixture',choices:[{index:0,delta,finish_reason:null}]}, {id:'fixture',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40}}];
  return new Response(frames.map(f=>'data: '+JSON.stringify(f)+'\\n\\n').join('')+'data: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
};
`);

let sequence = 0;
async function run(args: string[], input = "", fixture = "normal") {
  const dir = path.join(root, String(sequence++)); fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, ".mini-agent"));
  const settings = JSON.stringify({ model: "saved-model", autoMode: { enabled: false }, judge: { enabled: false } });
  fs.writeFileSync(path.join(dir, ".mini-agent/settings.json"), settings);
  fs.writeFileSync(path.join(dir, "blocked.txt"), "keep me");
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(preload).href, agent, ...args], {
    cwd: dir, env: { PATH: process.env.PATH, MINI_AGENT_API_KEY: "fixture-key", MINI_AGENT_BASE_URL: "https://api.deepseek.com",
      MINI_AGENT_MODEL: "env-model", MINI_AGENT_NO_TELEMETRY: "1", MINI_AGENT_REVIEW_DEBUG: "0", FIXTURE: fixture },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {}); // usage errors may exit before consuming stdin
  child.stdin.end(input);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const interrupt = fixture === "interrupt" ? setInterval(() => {
    if (fs.existsSync(path.join(dir, "requests.jsonl"))) child.kill("SIGINT");
  }, 100) : undefined;
  const code = await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  clearTimeout(timeout); clearInterval(interrupt);
  const records = path.join(dir, "requests.jsonl");
  const requests = fs.existsSync(records) ? fs.readFileSync(records, "utf8").trim().split("\n").map((s) => JSON.parse(s)) : [];
  return { code, stdout, stderr, requests, dir, settings };
}

try {
  const text = await run(["-p", "Summarize", "--model", "deepseek-flash", "--effort", "max"], "piped context\n");
  check("print exits and stdout is only unrendered final text", text.code === 0 && text.stdout === "**Final answer**\nSecond line\n", text.stderr);
  check("incidental stdout is moved to stderr", text.stderr.includes("fixture startup diagnostic"));
  check("CLI overrides reach the actual SDK request", text.requests[0]?.model === "deepseek-flash" && text.requests[0]?.reasoning_effort === "max" && text.requests[0]?.thinking.type === "enabled");
  check("prompt and piped content both reach the model", text.requests[0]?.messages.at(-1).content === "Summarize\npiped context\n");
  check("CLI overrides do not alter saved settings", fs.readFileSync(path.join(text.dir, ".mini-agent/settings.json"), "utf8") === text.settings);
  const json = await run(["exec", "--prompt", "hello", "--model=deepseek-flash", "--effort=none", "--output-format=json"]);
  const result = JSON.parse(json.stdout);
  check("exec produces one JSON result with usage and session metadata", json.code === 0 && result.type === "result" && !result.is_error && result.model === "deepseek-flash" && result.effort === "none" && result.session_id && result.usage.input_tokens === 100 && result.usage.cached_input_tokens === 60 && result.usage.output_tokens === 20);
  check("DeepSeek none disables thinking", json.requests[0]?.thinking.type === "disabled" && !json.requests[0]?.reasoning_effort);
  const pipe = await run(["--print"], "stdin-only task");
  check("stdin alone supplies the task", pipe.code === 0 && pipe.requests[0]?.messages.at(-1).content === "stdin-only task");
  const tool = await run(["-p", "Inspect the project"], "", "tool");
  check("print never prompts or bypasses approval", tool.code === 0 && fs.existsSync(path.join(tool.dir, "blocked.txt")) && tool.stderr.includes("declined (no prompt available)"));
  check("intermediate assistant text stays out of stdout", tool.stdout === "**Final answer**\nSecond line\n" && tool.requests.length === 2);
  for (const args of [["-p"], ["-p", "hello", "--model"], ["-p", "hello", "--effort=bogus"], ["exec", "--unknown"]]) {
    const invalid = await run(args);
    check(`usage errors exit 2 before any request: ${args.join(" ")}`, invalid.code === 2 && invalid.requests.length === 0 && invalid.stdout === "");
  }
  for (const flag of ["--help", "--version"]) {
    const result = await run([flag]);
    check(`${flag} exits without an API call`, result.code === 0 && result.requests.length === 0 && result.stdout.length > 0);
  }
  const failed = await run(["-p", "hello", "--output-format=json"], "", "error");
  check("API failure returns JSON error and exit 1", failed.code === 1 && JSON.parse(failed.stdout).is_error === true);
  const interrupted = await run(["-p", "hello"], "", "interrupt");
  check("SIGINT returns 130 and cleans up", interrupted.code === 130 && interrupted.stdout === "");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
finish();

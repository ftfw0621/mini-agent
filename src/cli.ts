import { parseArgs } from "node:util";
import { CONFIG } from "./config.js";
import { effortMenu, setEffort } from "./effort.js";

export class CliUsageError extends Error {}

export interface CliOptions {
  print: boolean;
  prompt: string;
  model?: string;
  effort?: string;
  auto: boolean;
  permissionMode?: "default" | "auto" | "bypassPermissions";
  resume: boolean;
  help: boolean;
  version: boolean;
  outputFormat: "text" | "json";
}

// -p is a mode, not a boundary after which flags turn into task text. Node's
// parser handles --option=value and the -- delimiter without another dependency.
export function parseCli(args: string[]): CliOptions {
  const exec = args[0] === "exec";
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: exec ? args.slice(1) : args, strict: true, allowPositionals: true, options: {
      print: { type: "boolean", short: "p" },
      prompt: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      auto: { type: "boolean" },
      "permission-mode": { type: "string" },
      "dangerously-skip-permissions": { type: "boolean" },
      resume: { type: "boolean", short: "r" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      "output-format": { type: "string" },
    } });
  } catch (error) { throw new CliUsageError((error as Error).message); }
  const { values, positionals } = parsed;
  const print = exec || values.print === true;
  const requestedMode = values["permission-mode"];
  if (requestedMode !== undefined && requestedMode !== "default" && requestedMode !== "auto" && requestedMode !== "bypassPermissions") {
    throw new CliUsageError("--permission-mode must be default, auto, or bypassPermissions");
  }
  // Match Claude's precedence: the explicit skip flag wins over a mode flag.
  const permissionMode = values["dangerously-skip-permissions"] ? "bypassPermissions" : requestedMode;
  const outputFormat = values["output-format"] ?? "text";
  if (outputFormat !== "text" && outputFormat !== "json") throw new CliUsageError("--output-format must be text or json");
  for (const flag of ["model", "effort", "prompt"]) {
    if (typeof values[flag] === "string" && !values[flag].trim()) throw new CliUsageError(`--${flag} cannot be empty`);
  }
  if (values.prompt !== undefined && positionals.length) throw new CliUsageError("Use either a positional prompt or --prompt, not both");
  const prompt = typeof values.prompt === "string" ? values.prompt : positionals.join(" ");
  if (!print && (prompt || values["output-format"] !== undefined)) throw new CliUsageError("Use -p / --print or exec with a prompt or --output-format");
  return { print, prompt, outputFormat, permissionMode, model: typeof values.model === "string" ? values.model : undefined,
    effort: typeof values.effort === "string" ? values.effort : undefined, auto: values.auto === true,
    resume: values.resume === true, help: values.help === true, version: values.version === true };
}

// CLI overrides live only in this process; never save them to user settings.
// Validate against the selected model/endpoint before any request is started.
export function applyCliOptions(options: CliOptions): void {
  const model = options.model ?? CONFIG.model;
  if (options.effort !== undefined && options.effort !== "default") {
    const menu = effortMenu(model);
    if (!menu.values.includes(options.effort)) throw new CliUsageError(menu.values.length
      ? `Unsupported effort '${options.effort}' for ${model}. Choose: ${menu.values.join(", ")}` : menu.header);
  }
  CONFIG.model = model;
  if (options.effort !== undefined) setEffort(model, options.effort);
  CONFIG.bypassPermissions = options.permissionMode === "bypassPermissions";
  if (options.permissionMode !== undefined) CONFIG.autoMode.enabled = options.permissionMode === "auto";
  else if (options.auto) CONFIG.autoMode.enabled = true;
}

// Match print-mode pipe composition: the instruction first, followed by stdin.
// Wait for EOF so slow producers aren't silently truncated. Never read a TTY.
export async function readPrintPrompt(prompt: string, input: AsyncIterable<string | Buffer>, isTTY: boolean): Promise<string> {
  const chunks: Buffer[] = [];
  if (!isTTY) for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = [prompt, Buffer.concat(chunks).toString("utf8")].filter(Boolean).join("\n");
  if (!text.trim()) throw new CliUsageError('Provide a prompt: mini-agent -p "<task>" or pipe text into mini-agent -p');
  return text;
}

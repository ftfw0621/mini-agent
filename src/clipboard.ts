import { execFile } from "node:child_process";

export interface ClipboardContent { image?: Buffer; text?: string }
export interface ClipboardSource { read(): Promise<ClipboardContent> }
export type ClipboardCommand = (program: string, args: readonly string[]) => Promise<Buffer>;

// Bound native helpers independently of the attachment limit. Always argv,
// never a shell command containing clipboard text, paths or user input.
const nativeCommand: ClipboardCommand = (program, args) => new Promise((resolve, reject) => {
  execFile(program, [...args], { encoding: "buffer", timeout: 8000, maxBuffer: 12 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new Error(`Clipboard helper ${program} failed. Check clipboard access and that the helper is installed.`));
    else resolve(stdout);
  });
});

function decodeNative(data: Buffer): ClipboardContent {
  const value = JSON.parse(data.toString("utf8")) as { image?: unknown; text?: unknown };
  if (typeof value.image === "string" && value.image) return { image: Buffer.from(value.image, "base64") };
  return { text: typeof value.text === "string" ? value.text : "" };
}

const MAC_SCRIPT = `ObjC.import('AppKit');
var board = $.NSPasteboard.generalPasteboard;
if (board.isNil()) throw Error('Clipboard is unavailable');
var data = board.dataForType('public.png');
if (data.isNil()) {
  var tiff = board.dataForType('public.tiff');
  if (!tiff.isNil()) {
    var bitmap = $.NSBitmapImageRep.alloc.initWithData(tiff);
    if (!bitmap.isNil()) data = bitmap.representationUsingTypeProperties($.NSPNGFileType, $.NSDictionary.dictionary);
  }
}
if (!data.isNil()) {
  if (Number(data.length) > 5 * 1024 * 1024) throw Error('Image exceeds 5 MB');
  JSON.stringify({image: ObjC.unwrap(data.base64EncodedStringWithOptions(0))});
} else {
  var text = board.stringForType('public.utf8-plain-text');
  JSON.stringify({text: text.isNil() ? '' : ObjC.unwrap(text)});
}`;

const WINDOWS_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [System.Windows.Forms.Clipboard]::GetImage()
  $buffer = New-Object System.IO.MemoryStream
  try {
    $image.Save($buffer, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($buffer.Length -gt 5MB) { throw 'Image exceeds 5 MB' }
    @{ image = [Convert]::ToBase64String($buffer.ToArray()) } | ConvertTo-Json -Compress
  } finally { $buffer.Dispose(); $image.Dispose() }
} else {
  @{ text = [System.Windows.Forms.Clipboard]::GetText() } | ConvertTo-Json -Compress
}`;

class MacClipboard implements ClipboardSource {
  constructor(private run: ClipboardCommand) {}
  async read(): Promise<ClipboardContent> { return decodeNative(await this.run("osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT])); }
}

class WindowsClipboard implements ClipboardSource {
  constructor(private run: ClipboardCommand) {}
  async read(): Promise<ClipboardContent> { return decodeNative(await this.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_SCRIPT])); }
}

class LinuxClipboard implements ClipboardSource {
  constructor(private run: ClipboardCommand, private wayland: boolean) {}
  async read(): Promise<ClipboardContent> {
    const program = this.wayland ? "wl-paste" : "xclip";
    const types = (await this.run(program, this.wayland ? ["--list-types"] : ["-selection", "clipboard", "-o", "-t", "TARGETS"])).toString("utf8").split(/\r?\n/);
    const imageType = ["image/png", "image/jpeg", "image/webp", "image/gif"].find((type) => types.includes(type));
    const type = imageType ?? (this.wayland ? "text" : "UTF8_STRING");
    const data = await this.run(program, this.wayland ? ["--no-newline", "--type", type] : ["-selection", "clipboard", "-o", "-t", type]);
    return imageType ? { image: data } : { text: data.toString("utf8") };
  }
}

export function systemClipboard(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  run: ClipboardCommand = nativeCommand,
): ClipboardSource {
  if (platform === "darwin") return new MacClipboard(run);
  if (platform === "win32") return new WindowsClipboard(run);
  if (platform === "linux") return new LinuxClipboard(run, !!env.WAYLAND_DISPLAY);
  return { read: async () => { throw new Error(`Clipboard paste is not supported on ${platform}.`); } };
}

import OpenAI from "openai";
import { imageFromBytes, readClipboard, imagesInInput, userContent, MAX_IMAGE_BYTES } from "../src/images.js";
import { systemClipboard, type ClipboardCommand } from "../src/clipboard.js";
import { makeRunTurn } from "../src/ink/chat.js";
import { makeInkSink } from "../src/ink/sink.js";
import { estimateHistoryTokens } from "../src/context.js";
import { check, finish } from "./helpers.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const image = imageFromBytes(png, 1);
check("clipboard PNG becomes an actual image data URL", image.dataUrl.startsWith("data:image/png;base64,"));
for (const invalid of [Buffer.from("not an image"), Buffer.alloc(MAX_IMAGE_BYTES + 1)]) {
  let rejected = false;
  try { imageFromBytes(invalid, 2); } catch { rejected = true; }
  check("invalid or oversized image fails before sending", rejected);
}
const injected = await readClipboard(3, { read: async () => ({ image: png }) });
check("platform-independent clipboard interface can be injected", injected.image?.id === 3 && injected.image.dataUrl === image.dataUrl);
check("plain text clipboard remains text", (await readClipboard(4, { read: async () => ({ text: "你好" }) })).text === "你好");
check("deleted image label removes its attachment", imagesInInput("Describe [Image #1]", [image, { ...image, id: 2 }]).length === 1);
check("partial label is not an attachment", imagesInInput("[Image #", [image]).length === 0);
check("text-only input preserves the original API shape", userContent("hello", []) === "hello");
const content = userContent("Compare [Image #1] and [Image #2]", [image, { ...image, id: 2 }]);
check("multiple labels map to separate image parts", Array.isArray(content) && content.filter((part) => part.type === "image_url").length === 2);
check("token estimation does not tokenize base64 transport", estimateHistoryTokens([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(2_000_000) } }] }]) < 10_000);

for (const platform of ["darwin", "win32"] as const) {
  let used = "";
  let argumentsUsed: readonly string[] = [];
  const command: ClipboardCommand = async (program, args) => { used = program; argumentsUsed = args; return Buffer.from(JSON.stringify({ image: png.toString("base64") })); };
  const got = await systemClipboard(platform, {}, command).read();
  check(`${platform} adapter returns image bytes behind the same interface`, got.image?.equals(png) === true);
  check(`${platform} selects its native helper`, used === (platform === "darwin" ? "osascript" : "powershell.exe"));
  if (platform === "win32") check("Windows clipboard helper uses required STA threading", argumentsUsed.includes("-STA"));
}
for (const wayland of [true, false]) {
  const calls: { program: string; args: readonly string[] }[] = [];
  const source = systemClipboard("linux", wayland ? { WAYLAND_DISPLAY: "wayland-0" } : {}, async (program, args) => {
    calls.push({ program, args });
    return calls.length === 1 ? Buffer.from("text/plain\nimage/png\n") : png;
  });
  check(`${wayland ? "Wayland" : "X11"} adapter negotiates an image representation`, (await source.read()).image?.equals(png) === true);
  check("Linux helpers receive explicit image type and clipboard selection", calls[1].program === (wayland ? "wl-paste" : "xclip") && calls[1].args.includes("image/png") && (wayland || calls[1].args.includes("clipboard")));
}
let unsupported = false;
try { await systemClipboard("freebsd", {}, async () => Buffer.alloc(0)).read(); } catch { unsupported = true; }
check("unsupported platform fails visibly instead of sending a placeholder", unsupported);

// Exercise the real frontend -> loop -> provider path, with no network calls.
const messages: OpenAI.ChatCompletionMessageParam[] = [];
let requestMessages: OpenAI.ChatCompletionMessageParam[] = [];
const client = { chat: { completions: { create: async (params: { messages: OpenAI.ChatCompletionMessageParam[] }) => {
  requestMessages = [...params.messages];
  return (async function* () { yield { choices: [{ delta: { content: "I can see the image." } }] }; })();
} } } };
const output = makeInkSink({ setStatus: () => {}, setLive: () => {}, pushItem: () => {} });
const hooks = { output, images: [image], signal: new AbortController().signal, isInterrupted: () => false, confirm: async () => false };
const result = await makeRunTurn(client as never, messages)("Describe [Image #1]", hooks);
const sent = requestMessages[0].content;
check("actual model request contains image bytes, not just a label", result.finalText?.includes("image") === true && Array.isArray(sent) && sent.some((part) => part.type === "image_url" && part.image_url.url === image.dataUrl));
check("image survives in conversation history for follow-up questions", JSON.stringify(messages).includes(image.dataUrl));
const rejectsImage = { chat: { completions: { create: async () => { throw new OpenAI.BadRequestError(400, { message: "image_url is unsupported" }, "image_url is unsupported", new Headers()); } } } };
const failed = await makeRunTurn(rejectsImage as never, [])("Describe [Image #1]", hooks);
check("non-vision provider yields an actionable image-specific ending", failed.reason === "image_input_rejected");
finish();

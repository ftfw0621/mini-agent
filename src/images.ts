import { systemClipboard, type ClipboardSource } from "./clipboard.js";
import type OpenAI from "openai";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export interface ImageAttachment { id: number; dataUrl: string }
export const imageLabel = (id: number): string => `[Image #${id}]`;

export function imageFromBytes(data: Buffer, id: number): ImageAttachment {
  if (data.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds 5 MB. Copy a smaller image.");
  let mime: string;
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = "image/png";
  else if (data[0] === 255 && data[1] === 216 && data[2] === 255) mime = "image/jpeg";
  else if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString())) mime = "image/gif";
  else if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") mime = "image/webp";
  else throw new Error("Clipboard does not contain a supported PNG, JPEG, GIF or WebP image.");
  return { id, dataUrl: `data:${mime};base64,${data.toString("base64")}` };
}

// UI and attachment handling depend on this interface, never on an OS API.
export async function readClipboard(id: number, source: ClipboardSource = systemClipboard()): Promise<{ image?: ImageAttachment; text?: string }> {
  const content = await source.read();
  return content.image ? { image: imageFromBytes(content.image, id) } : { text: content.text ?? "" };
}

// The numbered text labels stay next to their image parts so multiple images
// can be referenced unambiguously. Plain text remains a plain text message.
export function userContent(text: string, images: readonly ImageAttachment[]): OpenAI.ChatCompletionUserMessageParam["content"] {
  if (!images.length) return text;
  return [
    { type: "text", text },
    ...images.flatMap((image): OpenAI.ChatCompletionContentPart[] => [
      { type: "text", text: imageLabel(image.id) },
      { type: "image_url", image_url: { url: image.dataUrl } },
    ]),
  ];
}

// Deleting a label removes its attachment too; raw image bytes never enter
// the editable buffer, terminal transcript, title generation or auto judge.
export function imagesInInput(text: string, images: readonly ImageAttachment[]): ImageAttachment[] {
  return images.filter((image) => text.includes(imageLabel(image.id)));
}

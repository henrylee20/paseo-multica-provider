import { createHash } from "node:crypto";

export const textRevision = (text: string) => createHash("sha256").update(text).digest("hex");

// Keep surrogate pairs intact and leave room below the host's 64 KiB JSON limit.
export function textSlice(text: string, offset: number, length: number): string {
  let end = Math.min(text.length, offset + length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(offset, end);
}

export function readText(text: string, request: { revision: string; offset: number }) {
  if (textRevision(text) !== request.revision || request.offset > text.length) throw new Error("Cached text changed; reopen the discussion or execution segment");
  const chunk = textSlice(text, request.offset, 8192);
  const end = request.offset + chunk.length;
  return { text: chunk, nextOffset: end < text.length ? end : null };
}

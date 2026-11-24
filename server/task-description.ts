import { createHash } from "node:crypto";

export function descriptionRevision(description: string): string {
  return createHash("sha256").update(description).digest("hex");
}

// A UTF-16 unit needs at most six JSON bytes. These bounds leave ample room
// below the host's 64 KiB plugin data limit, including escaped control text.
export function descriptionSlice(description: string, offset: number, length: number): string {
  let end = Math.min(description.length, offset + length);
  if (end < description.length && /[\uD800-\uDBFF]/.test(description[end - 1])) end--;
  return description.slice(offset, end);
}

export function taskDescriptionData(connectionKey: string, issueId: string, description: string) {
  const preview = descriptionSlice(description, 0, 4096);
  return { connectionKey, issueId, revision: descriptionRevision(description), preview, truncated: preview.length < description.length };
}

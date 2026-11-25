/** A cancelled read returns no partial text. Each continuation must advance. */
export async function collectText(
  read: (offset: number) => Promise<{ text: string; nextOffset: number | null }>,
  active: () => boolean = () => true
): Promise<string | undefined> {
  const parts: string[] = [];
  let offset = 0;
  while (active()) {
    const page = await read(offset);
    if (!active()) return undefined;
    parts.push(page.text);
    if (page.nextOffset === null) return parts.join("");
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("Invalid chunked text cursor");
    offset = page.nextOffset;
  }
  return undefined;
}

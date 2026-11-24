import type { NativeHost } from "./native-host.js";
import type { StoredRow } from "./thread-state.js";

/** Source IDs in the host timeline acknowledge originals; a neighbouring plugin
 * source row only acknowledges itself. Read every page before publishing anything. */
export async function nativeOriginals(host: NativeHost, agentId: string) {
  type Page = Awaited<ReturnType<NativeHost["fetchAgentTimeline"]>>;
  const entries: Page["entries"] = [];
  const cursors = new Set<string>();
  let cursor: NonNullable<Page["startCursor"]> | undefined;
  let epoch: string | undefined;
  for (;;) {
    const page = await host.fetchAgentTimeline(agentId, { projection: "canonical", direction: cursor ? "before" : "tail", cursor, limit: 200, mergeWindow: false });
    // Installed 0.15.3 can return projected pages for this canonical request.
    // Both preserve source messageId; incomplete/changed windows are not authority.
    if (page.error || page.agentId !== agentId || page.gap || page.staleCursor || page.reset || (epoch && page.epoch !== epoch)) {
      throw new Error("Native comment history is incomplete; retry reconciliation");
    }
    epoch = page.epoch;
    entries.push(...page.entries);
    if (!page.hasOlder) break;
    const next = page.startCursor;
    if (!next || cursors.has(JSON.stringify(next))) throw new Error("Incomplete native comment pagination");
    cursors.add(JSON.stringify(next)); cursor = next;
  }
  return entries;
}

export function hasNativeOriginal(entries: Awaited<ReturnType<typeof nativeOriginals>>, row: StoredRow): boolean {
  const type = row.role === "user" ? "user_message" : "assistant_message";
  const matches = entries.filter(entry => {
    const item = entry.item;
    return (item.type === "user_message" || item.type === "assistant_message") &&
      (item.messageId === row.commentId || (row.role === "user" && row.clientMessageId !== undefined && item.type === "user_message" && item.clientMessageId === row.clientMessageId));
  });
  if (!matches.length) return false;
  if (matches.some(entry => entry.item.type !== type) || matches.sort((a, b) => a.seqStart - b.seqStart).map(entry => "text" in entry.item ? entry.item.text : "").join("") !== row.text) {
    throw new Error("Native source comment differs from cached original; retain history without replay");
  }
  return true;
}

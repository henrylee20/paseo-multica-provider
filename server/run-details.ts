import { z } from "zod";
import { runAddress, runMessageSchema, type runRead } from "../shared/runs.js";
import type { AuthenticatedConnection } from "./connection.js";
import { StateStore, cachedWorkspace } from "./state.js";
import { remoteJson } from "./sync.js";
import { readText, textRevision } from "./chunked-text.js";

type Address = z.infer<typeof runAddress>;
const key = (address: Address) => JSON.stringify([address.connectionKey, address.issueId, address.rootId, address.runId]);

/** Only explicit expansion refreshes output. Cached reads never need CLI login. */
export class RunDetails {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>) {}

  private async cached(address: Address) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue || issue.runs[address.runId]?.ownerRootId !== address.rootId) throw new Error("Run does not belong to this discussion");
    return { issue, cache: issue.runDetails[address.runId], metadata: issue.runs[address.runId].metadata };
  }
  async open(address: Address): Promise<{ status: "ready" | "cached" | "unavailable"; revision?: string; metadataRevision?: string; message?: string }> {
    try { await this.cached(address); } catch { return { status: "unavailable", message: "此执行段尚未映射到当前讨论。" }; }
    let status: "ready" | "cached" | "unavailable" = "ready";
    try {
      const id = key(address);
      let operation = this.pending.get(id);
      if (!operation) {
        operation = this.refresh(address).finally(() => this.pending.delete(id));
        this.pending.set(id, operation);
      }
      await operation;
    } catch { status = "cached"; }
    const { cache, metadata } = await this.cached(address);
    const metadataRevision = metadata && Object.keys(metadata).length ? textRevision(JSON.stringify(metadata)) : undefined;
    if (!cache) return { status: metadataRevision ? "cached" : "unavailable", metadataRevision, message: "无法读取执行消息；尚无已读消息缓存。" };
    return { status, revision: textRevision(JSON.stringify(cache.messages)), metadataRevision,
      ...(status === "cached" ? { message: "远端执行明细暂不可用，正在显示已读缓存。" } : {}) };
  }
  private async refresh(address: Address) {
    const { issue, cache } = await this.cached(address);
    // Resolve the current CLI context; cached history cannot authorize another login.
    const connection = await this.connection();
    if (connection.connectionKey !== address.connectionKey) throw new Error("Connection identity changed");
    const workspace = cachedWorkspace(await this.store.read(), address.connectionKey, issue);
    const known = new Set(cache?.messages.map(message => message.seq));
    // Strict seq > since. Never advance across a missing sequence, including
    // the first message; old/partial sources are safe to reread in full.
    let contiguous = known.has(0) ? 0 : known.has(1) ? 1 : undefined;
    if (contiguous !== undefined) while (known.has(contiguous + 1)) contiguous++;
    const query = contiguous === undefined ? "" : `?since=${contiguous}`;
    const messages = await remoteJson(connection, `/api/tasks/${encodeURIComponent(address.runId)}/messages${query}`, z.array(runMessageSchema), workspace) as Array<z.infer<typeof runMessageSchema>>;
    if (messages.some(message => message.task_id !== address.runId || message.issue_id !== address.issueId)) throw new Error("Run message identity mismatch");
    const unique = new Map(cache?.messages.map(message => [message.seq, message]));
    for (const message of messages) if (!unique.has(message.seq)) unique.set(message.seq, message);
    if (cache && unique.size === cache.messages.length) return;
    await this.store.update(state => {
      state.connections[address.connectionKey].issues[address.issueId].runDetails[address.runId] = { messages: [...unique.values()].sort((a, b) => a.seq - b.seq) };
    });
  }
  async read(address: z.infer<typeof runRead.input>) {
    const { cache, metadata } = await this.cached(address);
    const value = address.kind === "messages" ? cache?.messages : metadata;
    if (!value) throw new Error("Run cached content unavailable");
    return readText(JSON.stringify(value), address);
  }
  async close() { await Promise.allSettled(this.pending.values()); }
}

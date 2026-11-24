import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProviderPrompt, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { AuthenticatedConnection } from "./connection.js";
import type { DeliveryRecord } from "./delivery-state.js";
import type { RunAddress } from "./runs.js";
import { StateStore } from "./state.js";
import type { StopCoordinator } from "./stops.js";
import { remoteJson, workspaceSchema } from "./sync.js";
import { nativeOriginals, hasNativeOriginal } from "./projection-recovery.js";
import type { NativeHost } from "./native-host.js";
import type { StoredRow } from "./thread-state.js";

export const deliveryKey = (rootId: string, clientMessageId: string) => createHash("sha256").update(JSON.stringify([rootId, clientMessageId])).digest("hex");
const addressKey = (address: RunAddress) => JSON.stringify([address.connectionKey, address.issueId, address.rootId]);
const receiptSchema = z.object({ id: z.string(), issue_id: z.string(), parent_id: z.string().nullish(), content: z.string(), type: z.literal("comment"), author_type: z.literal("member"), author_id: z.string(),
  created_at: z.string().optional(), updated_at: z.string().optional(), trigger_outcomes: z.array(z.object({ target_type: z.string(), target_id: z.string(), status: z.string(), reason_code: z.string().optional() })).optional(),
});

export function deliveryRow(record: DeliveryRecord): ProviderTimelineItem {
  return { type: "plugin", id: `multica:delivery:${record.idempotencyKey}`, pluginId: "multica", kind: "comment-delivery", version: 1, data: {
    connectionKey: record.connectionKey, issueId: record.issueId, rootId: record.rootId, clientMessageId: record.clientMessageId,
    idempotencyKey: record.idempotencyKey, createdAt: record.createdAt, status: record.status, body: [...record.body].slice(0, 4000).join(""), truncated: [...record.body].length > 4000,
    ...(record.commentId ? { commentId: record.commentId } : {}), ...(record.threadRootId ? { threadRootId: record.threadRootId } : {}), ...(record.message ? { message: record.message } : {}),
  } };
}
export function deliveryInput(record: DeliveryRecord): StoredRow {
  return { id: `multica:input:${record.idempotencyKey}`, role: "user", commentId: record.commentId ?? `multica:input:${record.idempotencyKey}`,
    clientMessageId: record.clientMessageId, text: record.body, sourceCreatedAt: record.receipt?.createdAt ?? record.createdAt, sourceUpdatedAt: record.receipt?.updatedAt };
}

/** Durable input admission and truthful remote receipts; no automatic resend. */
export class CommentDelivery {
  private readonly listeners = new Map<string, Set<{ deliver(record: DeliveryRecord, includeOriginal?: boolean): void; recovery: boolean }>>();
  private readonly posts = new Map<string, Promise<void>>();
  private readonly operations = new Set<Promise<void>>();
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>, private readonly stops: StopCoordinator,
    private readonly onSaved: () => Promise<void>) {}
  subscribe(address: RunAddress, deliver: (record: DeliveryRecord, includeOriginal?: boolean) => void, recovery = false) {
    const listener = { deliver, recovery };
    const id = addressKey(address), listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  private publish(record: DeliveryRecord) { for (const listener of this.listeners.get(addressKey(record)) ?? []) listener.deliver(record); }
  presentation(record: DeliveryRecord): DeliveryRecord {
    return record.status === "received" && record.claimedAt && !this.posts.has(record.idempotencyKey)
      ? { ...record, status: "pending_verification", message: "上次投递中断，保存结果待核实；不会自动重发。" } : record;
  }
  async recover(host: NativeHost) {
    for (const [id, listeners] of this.listeners) {
      const recovering = [...listeners].filter(listener => listener.recovery);
      if (!recovering.length) continue;
      const [connectionKey, issueId, rootId] = JSON.parse(id) as string[];
      const issue = (await this.store.read()).connections[connectionKey]?.issues[issueId];
      const agentId = rootId === "main" ? issue?.mainAgentId : issue?.threads[rootId]?.agentId;
      if (!issue || !agentId) continue;
      const records = Object.values(issue.deliveries).filter(record => record.rootId === rootId);
      const entries = records.length ? await nativeOriginals(host, agentId) : [];
      const originals = records.map(record => ({ record: this.presentation(record), includeOriginal: !hasNativeOriginal(entries, deliveryInput(record)) }));
      for (const listener of recovering) {
        for (const { record, includeOriginal } of originals) listener.deliver(record, includeOriginal);
        listener.recovery = false;
      }
    }
  }
  async admit(address: RunAddress, prompt: ProviderPrompt): Promise<DeliveryRecord> {
    const body = prompt.input.type === "message" && prompt.input.content.every(part => part.type === "text" && !("mimeType" in part))
      ? prompt.input.content.map(part => part.type === "text" ? part.text : "").join("") : undefined;
    if (body === undefined || !body.trim() || prompt.outputSchema !== undefined) throw new Error("仅支持非空文本评论；请移除附件或结构化输出。 ");
    const stopEpoch = await this.stops.epoch(address);
    let record!: DeliveryRecord;
    await this.store.update(state => {
      const issue = state.connections[address.connectionKey]?.issues[address.issueId];
      if (!issue || (address.rootId !== "main" && !issue.threads[address.rootId])) throw new Error("请在 Multica 管理页启用任务工作区后打开已导入的讨论。");
      const id = deliveryKey(address.rootId, prompt.clientMessageId);
      const existing = issue.deliveries[id];
      if (existing) {
        if (existing.body !== body || existing.nativeDelivery !== prompt.delivery) throw new Error("同一输入身份不能改变正文或目标。");
        record = existing; return;
      }
      record = issue.deliveries[id] = { ...address, clientMessageId: prompt.clientMessageId, idempotencyKey: randomUUID(), body, createdAt: new Date().toISOString(), stopEpoch, nativeDelivery: prompt.delivery, status: "received" };
    });
    this.publish(record); return record;
  }
  start(record: DeliveryRecord) {
    const id = record.idempotencyKey;
    if (record.status !== "received" || record.claimedAt || this.posts.has(id)) return;
    const post = this.perform(record);
    this.posts.set(id, post);
    const operation = post.then(async () => {
      const current = (await this.store.read()).connections[record.connectionKey]?.issues[record.issueId]?.deliveries[deliveryKey(record.rootId, record.clientMessageId)];
      if (current?.status === "saved") await this.onSaved();
    }).catch(() => {}).finally(() => { this.operations.delete(operation); });
    this.operations.add(operation);
    void post.finally(() => this.posts.delete(id)).catch(() => {});
  }
  async waitForPosts() { await Promise.allSettled([...this.posts.values()]); }
  private async perform(record: DeliveryRecord) {
    let sent = false;
    try {
      const connection = await this.connection();
      if (connection.connectionKey !== record.connectionKey) throw new Error("登录身份已变化；原输入不会转发到新连接。");
      const issue = (await this.store.read()).connections[record.connectionKey]?.issues[record.issueId];
      if (!issue) throw new Error("讨论不可用。");
      const workspaces = await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as z.infer<typeof workspaceSchema>[];
      const workspace = workspaces.find(workspace => workspace.id === issue.remoteWorkspaceId);
      if (!workspace) throw new Error("Multica 工作区不可用。");
      let claimed = false;
      await this.stops.guardDelivery(record, record.stopEpoch, state => {
        const current = state.connections[record.connectionKey].issues[record.issueId].deliveries[deliveryKey(record.rootId, record.clientMessageId)];
        if (current.status !== "received" || current.claimedAt) return;
        current.claimedAt = new Date().toISOString(); claimed = true;
      });
      if (!claimed) return;
      // No asynchronous gap between the durable Stop fence and issuing POST.
      sent = true;
      const response = await fetch(`${connection.apiUrl}/api/issues/${encodeURIComponent(record.issueId)}/comments`, {
        method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", "X-Workspace-Slug": workspace.slug, "Idempotency-Key": record.idempotencyKey },
        body: JSON.stringify({ content: record.body, type: "comment", ...(record.rootId === "main" ? {} : { parent_id: record.rootId }) }), redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // A server error can follow a committed transaction; it is not proof of absence.
        await this.finish(record, response.status >= 500 || response.status === 408 ? "pending_verification" : "failed", `评论未确认保存（HTTP ${response.status}）；原输入已保留，不会自动重发。`); return;
      }
      const comment = receiptSchema.parse(await response.json());
      if (comment.issue_id !== record.issueId || (comment.parent_id ?? null) !== (record.rootId === "main" ? null : record.rootId) || comment.content !== record.body || comment.author_id !== connection.userId) throw new Error("评论回执与原输入不匹配。");
      await this.finish(record, "saved", "评论已保存；是否开始执行以独立 Run 状态为准。", comment);
    } catch (error) {
      const status = sent ? "pending_verification" : "failed";
      const message = sent ? "响应丢失或回执无法核实；原输入已保留，不会自动重发。" : error instanceof Error ? error.message : "投递失败；原输入已保留。";
      try { await this.finish(record, status, message); }
      catch { this.publish({ ...record, status, message: "无法持久保存投递结果；请保留原生输入并核实。不会自动重发。" }); }
    }
  }
  private async finish(record: DeliveryRecord, status: DeliveryRecord["status"], message: string, comment?: z.infer<typeof receiptSchema>) {
    let current!: DeliveryRecord;
    await this.store.update(state => {
      current = state.connections[record.connectionKey].issues[record.issueId].deliveries[deliveryKey(record.rootId, record.clientMessageId)];
      Object.assign(current, { status, message, ...(comment ? { commentId: comment.id, threadRootId: record.rootId === "main" ? comment.id : record.rootId,
        receipt: { authorId: comment.author_id, parentId: comment.parent_id ?? null, createdAt: comment.created_at, updatedAt: comment.updated_at, triggerOutcomes: comment.trigger_outcomes } } : {}) });
    });
    this.publish(current);
  }
  async list() {
    const state = await this.store.read();
    return { records: Object.values(state.connections).flatMap(connection => Object.values(connection.issues).flatMap(issue => Object.values(issue.deliveries).map(record => ({
      ...record, body: [...record.body].slice(0, 4000).join(""), truncated: [...record.body].length > 4000,
      ...(record.threadRootId && issue.threads[record.threadRootId]?.agentId ? { threadAgentId: issue.threads[record.threadRootId].agentId } : {}),
      // A claimed request left across a crash has no authoritative save receipt.
      status: this.presentation(record).status, message: this.presentation(record).message,
    })))) };
  }
  async read(address: RunAddress & { clientMessageId: string; offset: number }) {
    const record = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId]?.deliveries[deliveryKey(address.rootId, address.clientMessageId)];
    if (!record || address.offset > record.body.length) throw new Error("原输入不可用。");
    const text = record.body.slice(address.offset, address.offset + 8192), next = address.offset + text.length;
    return { text, nextOffset: next < record.body.length ? next : null };
  }
  async targets() { const state = await this.store.read(); return { issues: Object.entries(state.connections).flatMap(([connectionKey, connection]) => Object.entries(connection.issues).map(([issueId, issue]) => ({ connectionKey, issueId, title: issue.title }))) }; }
  async mentions(address: { connectionKey: string; issueId: string }) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    const connection = await this.connection();
    if (!issue || connection.connectionKey !== address.connectionKey) throw new Error("请连接此讨论的原 Multica 身份。");
    const workspaces = await remoteJson(connection, "/api/workspaces", z.array(workspaceSchema)) as z.infer<typeof workspaceSchema>[];
    const workspace = workspaces.find(workspace => workspace.id === issue.remoteWorkspaceId);
    if (!workspace) throw new Error("Multica 工作区不可用。");
    const agents = await remoteJson(connection, `/api/agents?workspace_id=${encodeURIComponent(workspace.id)}&include_archived=true`, z.array(z.object({ id: z.string(), name: z.string(), archived_at: z.string().nullish() })), workspace) as Array<{ id: string; name: string; archived_at?: string | null }>;
    return { agents: agents.filter(agent => !agent.archived_at && z.uuid().safeParse(agent.id).success).map(agent => ({ id: agent.id, name: agent.name, reference: `[@${agent.name.replace(/[\\\[\]]/g, "\\$&")}](mention://agent/${agent.id})` })) };
  }
  async close() { await Promise.allSettled(this.operations); this.listeners.clear(); }
}

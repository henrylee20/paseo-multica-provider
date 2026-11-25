import { z } from "zod";
import { createHash } from "node:crypto";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { askuserDocumentSchema, isAskuserReplyValid, type AskuserCardData } from "../shared/askuser.js";
import { remoteFetch, type AuthenticatedConnection } from "./connection.js";
import { StateStore, type IssueMapping } from "./state.js";
import type { RemoteWorkspace } from "./sync.js";

type Address = { connectionKey: string; issueId: string; rootId: string };
type CardAddress = { connectionKey: string; issueId: string; commentId: string; attachmentId: string };
export type AskuserComment = { id: string; type: string; parent_id?: string | null; deleted_at?: string | null; attachments?: Array<{ id?: string; filename?: string; content_type?: unknown; download_url?: string }> | null };
const timelineSchema = z.array(z.object({ id: z.string(), type: z.string(), parent_id: z.string().nullish(), content: z.string().optional(),
  actor_type: z.string().optional(), actor_id: z.string().optional(), delegated_by: z.string().nullish(), deleted_at: z.string().nullish(),
  askuser_skipped_at: z.string().nullish(), askuser_skipped_by: z.string().nullish(),
}));
const cardKey = (commentId: string, attachmentId: string) => JSON.stringify([commentId, attachmentId]);
const discussionKey = (address: Address) => JSON.stringify([address.connectionKey, address.issueId, address.rootId]);
const preview = (text: string | undefined, limit: number) => text === undefined ? undefined : [...text].slice(0, limit).join("");
const bounded = (data: AskuserCardData): AskuserCardData => {
  if (Buffer.byteLength(JSON.stringify(data)) < 24000) return data;
  return { ...data, title: preview(data.title, 160)!, description: preview(data.description, 800), truncated: true,
    readOnlyReason: preview(data.readOnlyReason, 240), error: preview(data.error, 500), statusError: preview(data.statusError, 160), skippedAt: preview(data.skippedAt, 64), skippedBy: preview(data.skippedBy, 128),
    questions: data.questions.slice(0, 3).map(question => ({ ...question, id: preview(question.id, 60)!, title: preview(question.title, 100)!, description: preview(question.description, 150),
      ...(question.type === "text" ? { required_when: question.required_when && { question_id: preview(question.required_when.question_id, 60)!, option_ids: question.required_when.option_ids.slice(0, 5).map(id => preview(id, 60)!) } } : { options: question.options.map(option => ({ id: preview(option.id, 60)!, label: preview(option.label, 80)! })),
        other: question.other && { ...question.other, label: preview(question.other.label, 80) } }),
    })),
    answer: data.answer && { ...data.answer, content: preview(data.answer.content, 800)!, actorId: preview(data.answer.actorId, 128), actorType: preview(data.answer.actorType, 32), delegatedBy: preview(data.answer.delegatedBy, 128) },
  };
};
const revision = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function cachedAskuserCard(address: CardAddress, issue: IssueMapping, context: { offline: boolean; userId?: string } = { offline: true }): AskuserCardData {
    const record = issue.askuserCards?.[cardKey(address.commentId, address.attachmentId)];
    if (!record) throw new Error("提问卡片缓存不可用。");
    const cached = issue.askuserAttachments?.[record.attachmentId];
    const document = cached?.document;
    const offline = context.offline;
    const targetUser = document?.answer_user_id;
    const readOnlyReason = issue.access?.status === "inaccessible" ? "任务已不可访问，仅显示缓存。"
      : issue.archiveReason || issue.manualHidden.workspace || issue.manualHidden.discussions.includes(record.rootId) ? "讨论已归档，仅显示缓存。"
      : record.deleted ? "原评论已删除，仅显示缓存。" : offline ? "离线缓存，仅供只读。"
      : targetUser && targetUser !== context.userId ? `仅指定用户 ${targetUser} 可作答；当前为只读。` : undefined;
    return { connectionKey: address.connectionKey, issueId: address.issueId, commentId: address.commentId, attachmentId: address.attachmentId, rootId: record.rootId, revision: revision([record, cached, offline, readOnlyReason]), title: document?.title ?? "askuser.json 提问卡片", description: document?.description,
      questions: document?.questions ?? [], status: record.status, readOnly: !!readOnlyReason || record.status !== "pending", readOnlyReason, offline, truncated: false, error: cached?.error, statusError: record.statusError, answer: record.answer, skippedAt: record.skippedAt, skippedBy: record.skippedBy };
  }

/** Attachment downloads and full timeline observations are independent of ordinary comment projection. */
export class AskUsers {
  private listeners = new Map<string, Set<(row: ProviderTimelineItem) => void>>();
  private userIds = new Map<string, string>();
  private pending = new Map<string, Promise<void>>();
  private online = new Set<string>();
  constructor(private readonly store: StateStore, private readonly connection: () => Promise<AuthenticatedConnection>) {}
  subscribe(address: Address, listener: (row: ProviderTimelineItem) => void) {
    const key = discussionKey(address);
    const listeners = this.listeners.get(key) ?? new Set(); listeners.add(listener); this.listeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
  private data(address: CardAddress, issue: IssueMapping) {
    return cachedAskuserCard(address, issue, { offline: !this.online.has(address.connectionKey), userId: this.userIds.get(address.connectionKey) });
  }
  private row(data: AskuserCardData): ProviderTimelineItem {
    return { type: "plugin", id: `multica:askuser:${data.commentId}:${data.attachmentId}`, pluginId: "multica", kind: "askuser", version: 1, data: bounded(data) };
  }
  async rows(address: Address) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    return issue ? Object.values(issue.askuserCards ?? {}).filter(card => card.rootId === address.rootId).map(card => this.row(this.data({ ...address, commentId: card.commentId, attachmentId: card.attachmentId }, issue))) : [];
  }
  private async publish(connectionKey: string, issueId: string) {
    const issue = (await this.store.read()).connections[connectionKey]?.issues[issueId];
    if (!issue) return;
    for (const card of Object.values(issue.askuserCards ?? {})) {
      const address = { connectionKey, issueId, rootId: card.rootId };
      const row = this.row(this.data({ ...address, commentId: card.commentId, attachmentId: card.attachmentId }, issue));
      for (const listener of this.listeners.get(discussionKey(address)) ?? []) listener(row);
    }
  }
  discover(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string, comments: AskuserComment[], roots: Map<string, string | undefined>, scope?: string) {
    const key = JSON.stringify([connection.connectionKey, issueId]);
    const operation = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.discoverSnapshot(connection, workspace, issueId, comments, roots, scope));
    this.pending.set(key, operation);
    return operation.finally(() => { if (this.pending.get(key) === operation) this.pending.delete(key); });
  }
  private async discoverSnapshot(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string, comments: AskuserComment[], roots: Map<string, string | undefined>, scope?: string) {
    this.online.add(connection.connectionKey); this.userIds.set(connection.connectionKey, connection.userId);
    for (const comment of comments) {
      const rootId = roots.get(comment.id);
      if (!rootId || comment.type !== "comment" || comment.deleted_at) continue;
      for (const attachment of comment.attachments ?? []) {
        if (attachment.filename !== "askuser.json" || attachment.content_type !== "application/json" || !attachment.id) continue;
        const issue = (await this.store.read()).connections[connection.connectionKey].issues[issueId];
        let cached = issue.askuserAttachments?.[attachment.id];
        // Hiding defers discovery; it is not a permanent attachment failure.
        if (!cached && (issue.manualHidden.workspace || issue.manualHidden.discussions.includes(rootId) || issue.archiveReason || issue.access?.status === "inaccessible")) continue;
        if (!cached) {
          try { cached = { document: await this.download(connection, workspace, issueId, attachment.download_url, rootId) }; }
          catch (error) { if (connection.signal?.aborted) this.online.delete(connection.connectionKey); cached = { error: error instanceof Error ? error.message.slice(0, 1000) : "附件下载或解析失败。" }; }
          await this.store.update(state => { (state.connections[connection.connectionKey].issues[issueId].askuserAttachments ??= {})[attachment.id!] = cached!; });
        }
        await this.store.update(state => {
          const cards = state.connections[connection.connectionKey].issues[issueId].askuserCards ??= {};
          cards[cardKey(comment.id, attachment.id!)] ??= { rootId, commentId: comment.id, attachmentId: attachment.id!, status: cached?.document ? "pending" : "invalid" };
        });
      }
    }
    // Only a complete snapshot proves removal. A Thread read cannot remove cards in another Thread.
    if (![...roots.values()].some(root => root === undefined)) await this.store.update(state => {
      const local = state.connections[connection.connectionKey].issues[issueId];
      for (const record of Object.values(local.askuserCards ?? {})) {
        if (scope && record.rootId !== scope) continue;
        const source = comments.find(comment => comment.id === record.commentId);
        record.deleted = !source || !!source.deleted_at || !(source.attachments ?? []).some(attachment => attachment.id === record.attachmentId && attachment.filename === "askuser.json" && attachment.content_type === "application/json");
      }
    });
    await this.resolveStatuses(connection, workspace, issueId);
    await this.publish(connection.connectionKey, issueId);
  }
  private async resolveStatuses(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string) {
    const issue = (await this.store.read()).connections[connection.connectionKey].issues[issueId];
    const unresolved = Object.entries(issue.askuserCards ?? {}).filter(([, card]) => card.status !== "answered" && card.status !== "skipped" && !card.deleted);
    if (!unresolved.length) return;
    try {
      const response = await remoteFetch(connection, `/api/issues/${encodeURIComponent(issueId)}/timeline`, { headers: { "X-Workspace-Slug": workspace.slug } });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Timeline unavailable"); }
      const entries = timelineSchema.parse(await response.json());
      await connection.assertCurrent?.();
      await this.store.update(state => {
        const local = state.connections[connection.connectionKey].issues[issueId];
        for (const [key] of unresolved) {
          const record = local.askuserCards![key];
          delete record.statusError;
          const original = entries.find(entry => entry.id === record.commentId);
          if (original?.askuser_skipped_at?.trim()) {
            record.status = "skipped"; record.skippedAt = original.askuser_skipped_at; record.skippedBy = original.askuser_skipped_by ?? undefined; continue;
          }
          const document = local.askuserAttachments?.[record.attachmentId]?.document;
          const answer = document && entries.find(entry => entry.type === "comment" && entry.parent_id === record.commentId && !entry.deleted_at && entry.content && isAskuserReplyValid(document, { ...entry, content: entry.content }));
          if (answer) {
            record.status = "answered";
            record.answer = { commentId: answer.id, content: answer.content!, actorId: answer.actor_id, actorType: answer.actor_type, delegatedBy: answer.delegated_by ?? undefined };
          }
        }
      });
    } catch {
      if (connection.signal?.aborted) this.online.delete(connection.connectionKey);
      await this.store.update(state => {
        for (const [key] of unresolved) state.connections[connection.connectionKey].issues[issueId].askuserCards![key].statusError = "无法核对完整时间线，显示最后已知状态。";
      });
    }
  }
  private async download(connection: AuthenticatedConnection, workspace: RemoteWorkspace, issueId: string, source?: string, rootId?: string) {
    if (!source) throw new Error("附件缺少 download_url。");
    let url: URL;
    try { url = new URL(source, `${connection.apiUrl}/`); } catch { throw new Error("附件 download_url 无效。"); }
    if (url.origin !== new URL(connection.apiUrl).origin || url.username || url.password) throw new Error("拒绝跨源或含凭据的附件地址。");
    const issue = (await this.store.read()).connections[connection.connectionKey]?.issues[issueId];
    if (!issue || issue.access?.status === "inaccessible" || issue.archiveReason || issue.manualHidden.workspace || !!rootId && issue.manualHidden.discussions.includes(rootId)) throw new Error("任务不可访问或已归档，未下载附件。");
    const accessible = await remoteFetch(connection, `/api/issues/${encodeURIComponent(issueId)}`, { headers: { "X-Workspace-Slug": workspace.slug } });
    if (!accessible.ok) { await accessible.body?.cancel(); throw new Error(`任务访问核对失败（HTTP ${accessible.status}），未下载附件。`); }
    const object = z.object({ id: z.string(), workspace_id: z.string() }).parse(await accessible.json());
    await connection.assertCurrent?.();
    if (object.id !== issueId || object.workspace_id !== workspace.id) throw new Error("任务访问核对返回了其他任务，未下载附件。");
    let response: Response;
    try {
      await connection.assertCurrent?.();
      response = await fetch(url, { headers: { Authorization: `Bearer ${connection.token}`, "X-Workspace-Slug": workspace.slug }, redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(connection.signal ? [connection.signal] : [])]) });
    } catch { throw new Error("附件下载失败（网络、重定向或登录上下文已变化）。"); }
    try {
      await connection.assertCurrent?.();
      if (!response.ok) throw new Error(`附件下载失败（HTTP ${response.status}）。`);
      if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("附件响应不是 application/json JSON。");
      if (Number(response.headers.get("content-length")) > 65536) throw new Error("附件超过 64 KiB 上限。");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("附件 JSON 正文为空。");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.byteLength;
          if (size > 65536) throw new Error("附件超过 64 KiB 上限。");
          chunks.push(result.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      await connection.assertCurrent?.();
      let json: unknown;
      try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("附件 JSON 正文不可解析。"); }
      const parsed = askuserDocumentSchema.safeParse(json);
      if (!parsed.success) throw new Error(`askuser.json schema 无效：${parsed.error.issues.map(issue => issue.path.join(".") || "document").join(", ").slice(0, 700)}`);
      return parsed.data;
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  async observe(address: CardAddress) {
    try { const connection = await this.connection(); if (connection.connectionKey === address.connectionKey) { this.online.add(address.connectionKey); this.userIds.set(address.connectionKey, connection.userId); } else this.online.delete(address.connectionKey); }
    catch { this.online.delete(address.connectionKey); }
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue) throw new Error("提问卡片缓存不可用。");
    return bounded(this.data(address, issue));
  }
  async read(address: CardAddress & { revision: string; offset: number }) {
    const issue = (await this.store.read()).connections[address.connectionKey]?.issues[address.issueId];
    if (!issue) throw new Error("提问卡片缓存不可用。");
    const data = this.data(address, issue);
    // Cache reads do not consult CLI credentials or access the network.
    const text = JSON.stringify(data);
    if (data.revision !== address.revision || address.offset > text.length) throw new Error("提问卡片已变化，请重新读取。");
    const end = Math.min(text.length, address.offset + 8192);
    return { text: text.slice(address.offset, end), nextOffset: end < text.length ? end : null };
  }
  async close() { await Promise.allSettled(this.pending.values()); this.listeners.clear(); }
}
